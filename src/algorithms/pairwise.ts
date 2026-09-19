import { noul, type JevClient, type JevQuestions, type JevState } from "../client.js";
import { chunk } from "../lib/chunk.js";

/** Pairs per Jev request. Bounds the prompt and the answer count. */
export const DEFAULT_MAX_PAIRS_PER_REQUEST = 40;
/** Hard cap on sort/selection rounds before falling back to the current order. */
export const DEFAULT_MAX_ROUNDS = 40;

export interface PairwiseOptions<T> {
	/** Ranking goal woven into the question, e.g. "for replying first". */
	task: string;
	/** Map an item to the Jev state Jev compares. */
	stateOf: (item: T) => JevState;
	/** Pairs per request. Default {@link DEFAULT_MAX_PAIRS_PER_REQUEST}. */
	maxPairsPerRequest?: number;
	/** Injectable RNG for pivot choice. Default `Math.random`. */
	random?: () => number;
	/** Round cap. Default {@link DEFAULT_MAX_ROUNDS}. */
	maxRounds?: number;
}

/** Answers one batch of pairs: true means `pairs[i][0]` outranks `pairs[i][1]`. */
export type PairComparator = (pairs: Array<[number, number]>) => Promise<boolean[]>;

/**
 * Build a comparator that asks Jev which of two items ranks higher.
 *
 * Many pairs share one request against a shared `state`; each request carries
 * only the items its pairs reference, addressed by a chunk-local index. Throws
 * if Jev omits an answer, so callers never persist a fabricated order.
 */
export function createPairComparator<T>(
	client: JevClient,
	items: readonly T[],
	options: PairwiseOptions<T>,
): PairComparator {
	const {
		task,
		stateOf,
		maxPairsPerRequest = DEFAULT_MAX_PAIRS_PER_REQUEST,
	} = options;

	return async (pairs) => {
		const decisions: boolean[] = new Array(pairs.length).fill(false);

		for (let start = 0; start < pairs.length; start += maxPairsPerRequest) {
			const part = pairs.slice(start, start + maxPairsPerRequest);

			// Only the items referenced by this chunk travel in the state.
			const localIndex = new Map<number, number>();
			const candidates: JevState[] = [];
			const localize = (i: number) => {
				let local = localIndex.get(i);
				if (local === undefined) {
					local = candidates.length;
					localIndex.set(i, local);
					candidates.push(stateOf(items[i]));
				}
				return local;
			};
			const localPairs = part.map(
				([a, b]) => [localize(a), localize(b)] as [number, number],
			);

			const questions: JevQuestions = {};
			localPairs.forEach(([a, b], k) => {
				questions[`c${k}`] = noul(
					`Does \`candidates[${a}]\` rank higher than \`candidates[${b}]\` ${task}? ` +
						`Answer true only if \`candidates[${a}]\` should come first.`,
					{
						true: `candidates[${a}] comes first`,
						false: `candidates[${b}] comes first, or the two tie`,
					},
				);
			});

			const answers = await client.evaluate({
				state: { candidates, pairs: localPairs },
				questions,
			});

			localPairs.forEach((_, k) => {
				const value = answers[`c${k}`];
				const probability = value && "noul" in value ? value.noul : undefined;
				if (typeof probability !== "number" || !Number.isFinite(probability)) {
					throw new Error("pairwise: Jev returned no answer for a comparison");
				}
				decisions[start + k] = probability >= 0.5;
			});
		}

		return decisions;
	};
}

interface SortNode {
	ids: number[];
	/** Set once the node is split; undefined means the node is a leaf. */
	pivot?: number;
	high?: SortNode;
	low?: SortNode;
}

/**
 * Randomized quicksort over an injectable comparator, one recursion level per
 * `compare` call.
 *
 * Classic quicksort is sequential because a split decides the next comparison.
 * Level-order traversal removes that dependency: nodes on a level are disjoint,
 * so all their pivot comparisons fit in one request and the order costs
 * ~log n requests instead of one per comparison.
 */
export async function sortIndicesByPairwise(
	indices: readonly number[],
	compare: PairComparator,
	options: { random?: () => number; maxRounds?: number } = {},
): Promise<number[]> {
	const { random = Math.random, maxRounds = DEFAULT_MAX_ROUNDS } = options;
	if (indices.length <= 1) return [...indices];

	const root: SortNode = { ids: [...indices] };
	let frontier: SortNode[] = [root];
	let rounds = 0;

	while (frontier.length > 0 && rounds < maxRounds) {
		const pairs: Array<[number, number]> = [];
		const pending: Array<{ node: SortNode; others: number[] }> = [];

		for (const node of frontier) {
			if (node.ids.length <= 1) continue;
			const pivot = node.ids[Math.floor(random() * node.ids.length)];
			const others = node.ids.filter((id) => id !== pivot);
			node.pivot = pivot;
			pending.push({ node, others });
			for (const other of others) pairs.push([other, pivot]);
		}
		if (pairs.length === 0) break;

		const decisions = await compare(pairs);

		let cursor = 0;
		const next: SortNode[] = [];
		for (const { node, others } of pending) {
			const high: number[] = [];
			const low: number[] = [];
			for (const other of others) {
				(decisions[cursor++] ? high : low).push(other);
			}
			if (high.length > 0) {
				node.high = { ids: high };
				next.push(node.high);
			}
			if (low.length > 0) {
				node.low = { ids: low };
				next.push(node.low);
			}
		}
		frontier = next;
		rounds++;
	}

	return flatten(root);
}

/** In-order walk: high subtree first, so the result is highest-ranked first. */
function flatten(node?: SortNode): number[] {
	if (!node) return [];
	if (node.pivot === undefined) return node.ids;
	return [...flatten(node.high), node.pivot, ...flatten(node.low)];
}

export interface SortRuntimeOptions {
	random?: () => number;
	maxRounds?: number;
}

/** Sort items highest-first using an injected comparator. */
export async function sortByPairwiseWith<T>(
	items: readonly T[],
	compare: PairComparator,
	options: SortRuntimeOptions = {},
): Promise<T[]> {
	const order = await sortIndicesByPairwise(
		items.map((_, i) => i),
		compare,
		options,
	);
	return order.map((i) => items[i]);
}

/** Sort items highest-first using Jev as the pairwise oracle. */
export async function sortByPairwise<T>(
	client: JevClient,
	items: readonly T[],
	options: PairwiseOptions<T>,
): Promise<T[]> {
	return sortByPairwiseWith(items, createPairComparator(client, items, options), options);
}

/**
 * Pick the top-k indices with quickselect: only the pivot side that can still
 * contain the k-th item is explored, so this beats a full sort on comparisons.
 * Returns the k winners (unordered).
 */
export async function selectTopKIndices(
	indices: readonly number[],
	k: number,
	compare: PairComparator,
	options: SortRuntimeOptions = {},
): Promise<number[]> {
	const { random = Math.random, maxRounds = DEFAULT_MAX_ROUNDS } = options;
	if (k <= 0) return [];
	if (k >= indices.length) return sortIndicesByPairwise(indices, compare, options);

	const confirmed: number[] = [];
	let candidates = [...indices];
	let rounds = 0;

	while (confirmed.length < k && candidates.length > 0) {
		const remaining = k - confirmed.length;
		if (candidates.length <= remaining) {
			confirmed.push(...candidates);
			break;
		}
		if (rounds >= maxRounds) {
			// Adversarial or noisy answers: stop probing and keep the rest.
			confirmed.push(...candidates);
			break;
		}

		const pivot = candidates[Math.floor(random() * candidates.length)];
		const others = candidates.filter((id) => id !== pivot);
		const decisions = await compare(others.map((id) => [id, pivot] as [number, number]));

		const high: number[] = [];
		const low: number[] = [];
		others.forEach((id, i) => (decisions[i] ? high : low).push(id));

		if (high.length >= remaining) {
			candidates = high; // pivot and low are below the top k
		} else {
			confirmed.push(...high, pivot);
			candidates = low;
		}
		rounds++;
	}

	return confirmed.slice(0, k);
}

/** Pick the top-k items, ordered highest-first, using an injected comparator. */
export async function selectTopKWith<T>(
	items: readonly T[],
	k: number,
	compare: PairComparator,
	options: SortRuntimeOptions = {},
): Promise<T[]> {
	const indices = await selectTopKIndices(
		items.map((_, i) => i),
		k,
		compare,
		options,
	);
	const ordered = await sortIndicesByPairwise(indices, compare, options);
	return ordered.map((i) => items[i]);
}

/** Pick the top-k items, ordered highest-first, using Jev as the oracle. */
export async function selectTopK<T>(
	client: JevClient,
	items: readonly T[],
	k: number,
	options: PairwiseOptions<T>,
): Promise<T[]> {
	return selectTopKWith(items, k, createPairComparator(client, items, options), options);
}
