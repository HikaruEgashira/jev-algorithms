import { noul, type JevClient, type JevState } from "../client.js";

export interface FindFirstTrueOptions<T> {
	/** Map an item to the Jev state the question inspects. */
	stateOf: (item: T) => JevState;
	/** Question about the single candidate under the cursor. */
	instruction: string;
	criteria?: { true?: string; false?: string };
}

export interface FindFirstTrueResult<T> {
	/** Index of the first item the predicate is true for, or `items.length`. */
	index: number;
	/** That item, or null when the predicate is never true. */
	item: T | null;
	/** Jev calls spent (one binary-search step each). */
	steps: number;
}

/**
 * Binary search for the first item a Jev predicate is true for.
 *
 * `items` must already be ordered so the predicate is monotone (all false,
 * then all true) — for example a list sorted by recency, asking "is this
 * older than 30 days?". Each step is one Jev call, so this finds a cutoff in
 * `O(log n)` requests. That is the point: the predicate is expensive, the
 * ordering is not.
 */
export async function findFirstTrue<T>(
	client: JevClient,
	items: readonly T[],
	options: FindFirstTrueOptions<T>,
): Promise<FindFirstTrueResult<T>> {
	const { stateOf, instruction, criteria } = options;
	let low = 0;
	let high = items.length;
	let steps = 0;

	while (low < high) {
		const mid = low + Math.floor((high - low) / 2);
		const answers = await client.evaluate({
			state: { candidate: stateOf(items[mid]) },
			questions: { is_true: noul(instruction, criteria) },
		});
		steps++;

		const answer = answers.is_true;
		const probability = answer && "noul" in answer ? answer.noul : undefined;
		if (typeof probability !== "number" || !Number.isFinite(probability)) {
			throw new Error("findFirstTrue: Jev returned no answer");
		}

		if (probability >= 0.5) {
			high = mid;
		} else {
			low = mid + 1;
		}
	}

	return { index: low, item: low < items.length ? items[low] : null, steps };
}
