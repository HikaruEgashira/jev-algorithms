import { noul, type JevClient, type JevQuestions, type JevState } from "../client.js";
import { UnionFind } from "../lib/unionFind.js";

/** Total comparisons allowed before the pair set is sampled. */
export const DEFAULT_MAX_COMPARISONS = 2000;
/** Pairs per Jev request. */
export const DEFAULT_MAX_CLUSTER_PAIRS_PER_REQUEST = 40;

/**
 * Answers one batch of pairs with the probability that the two items are the
 * same. Probabilities, not booleans, so the clustering threshold stays with
 * the caller.
 */
export type EquivalenceComparator = (
	pairs: Array<[number, number]>,
) => Promise<number[]>;

export interface ClusterOptions<T> {
	/** Relation name woven into the question, e.g. "duplicate support ticket". */
	relation: string;
	stateOf: (item: T) => JevState;
	/** Probability at or above which two items are joined. Default 0.5. */
	threshold?: number;
	/** Pairs per request. Default {@link DEFAULT_MAX_CLUSTER_PAIRS_PER_REQUEST}. */
	maxPairsPerRequest?: number;
	/** Cap on total comparisons. Pairs are sampled beyond it. Default 2000. */
	maxComparisons?: number;
	/** Injectable RNG used when sampling. Default `Math.random`. */
	random?: () => number;
}

export function createRelationComparator<T>(
	client: JevClient,
	items: readonly T[],
	options: Pick<ClusterOptions<T>, "relation" | "stateOf" | "maxPairsPerRequest">,
): EquivalenceComparator {
	const {
		relation,
		stateOf,
		maxPairsPerRequest = DEFAULT_MAX_CLUSTER_PAIRS_PER_REQUEST,
	} = options;

	return async (pairs) => {
		const same: number[] = new Array(pairs.length).fill(0);

		for (let start = 0; start < pairs.length; start += maxPairsPerRequest) {
			const part = pairs.slice(start, start + maxPairsPerRequest);

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
				questions[`p${k}`] = noul(
					`Do \`candidates[${a}]\` and \`candidates[${b}]\` refer to the same ${relation}?`,
					{
						true: `they are the same ${relation}`,
						false: `they are different ${relation}s`,
					},
				);
			});

			const answers = await client.evaluate({
				state: { candidates, pairs: localPairs },
				questions,
			});

			localPairs.forEach((_, k) => {
				const answer = answers[`p${k}`];
				const probability = answer && "noul" in answer ? answer.noul : undefined;
				if (typeof probability !== "number" || !Number.isFinite(probability)) {
					throw new Error("cluster: Jev returned no answer for a pair");
				}
				same[start + k] = probability;
			});
		}

		return same;
	};
}

/**
 * Union-find clustering over an injected equivalence comparator.
 *
 * Every pair is compared once, then `union` merges whenever the probability
 * clears the threshold. O(n^2) comparisons in the worst case; cap and sample
 * with `maxComparisons` when n is large.
 */
export async function clusterWith<T>(
	items: readonly T[],
	compare: EquivalenceComparator,
	options: {
		threshold?: number;
		maxComparisons?: number;
		random?: () => number;
	} = {},
): Promise<T[][]> {
	const {
		threshold = 0.5,
		maxComparisons = DEFAULT_MAX_COMPARISONS,
		random = Math.random,
	} = options;

	const unionFind = new UnionFind<number>(items.map((_, i) => i));

	let pairs: Array<[number, number]> = [];
	for (let i = 0; i < items.length; i++) {
		for (let j = i + 1; j < items.length; j++) {
			pairs.push([i, j]);
		}
	}

	if (pairs.length > maxComparisons) {
		// ponytail: sampled instead of exhaustive above the cap. Raise the cap or
		// block candidates before clustering when recall matters.
		pairs = shuffle(pairs, random).slice(0, maxComparisons);
	}

	const probabilities = await compare(pairs);
	pairs.forEach(([i, j], k) => {
		if ((probabilities[k] ?? 0) >= threshold) unionFind.union(i, j);
	});

	return unionFind.groups().map((group) => group.map((i) => items[i]));
}

/** Cluster items by a Jev equivalence question, one request per 40 pairs. */
export async function clusterByRelation<T>(
	client: JevClient,
	items: readonly T[],
	options: ClusterOptions<T>,
): Promise<T[][]> {
	const { threshold, maxComparisons, random } = options;
	return clusterWith(items, createRelationComparator(client, items, options), {
		threshold,
		maxComparisons,
		random,
	});
}

function shuffle<T>(items: readonly T[], random: () => number): T[] {
	const out = [...items];
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(random() * (i + 1));
		[out[i], out[j]] = [out[j], out[i]];
	}
	return out;
}
