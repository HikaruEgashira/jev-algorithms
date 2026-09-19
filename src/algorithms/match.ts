import type { JevClient, JevState } from "../client.js";
import {
	createPairComparator,
	sortByPairwiseWith,
	type SortRuntimeOptions,
} from "./pairwise.js";

/**
 * Proposer-optimal stable matching (Gale-Shapley).
 *
 * Every proposer ranks its acceptable receivers, every receiver ranks its
 * acceptable proposers. The result is stable: no pair would rather be
 * together than with the partners they were assigned.
 */
export function stableMatching(
	proposers: readonly string[],
	receivers: readonly string[],
	proposerPrefs: Record<string, readonly string[]>,
	receiverPrefs: Record<string, readonly string[]>,
): Array<[string, string]> {
	// Rank of each proposer in each receiver's list, for O(1) comparisons.
	const receiverRank = new Map<string, Map<string, number>>();
	for (const receiver of receivers) {
		const ranks = new Map<string, number>();
		(receiverPrefs[receiver] ?? []).forEach((proposer, i) => ranks.set(proposer, i));
		receiverRank.set(receiver, ranks);
	}

	const free = [...proposers];
	const nextChoice = new Map<string, number>();
	const heldBy = new Map<string, string>(); // receiver -> proposer

	while (free.length > 0) {
		const proposer = free.shift() as string;
		const prefs = proposerPrefs[proposer] ?? [];
		let index = nextChoice.get(proposer) ?? 0;
		if (index >= prefs.length) continue; // proposer exhausted its list

		const receiver = prefs[index];
		nextChoice.set(proposer, index + 1);

		// Skip partners that are not valid receivers, but keep the proposer
		// free for its next choice instead of dropping it.
		if (!receivers.includes(receiver)) {
			free.push(proposer);
			continue;
		}

		const current = heldBy.get(receiver);
		if (current === undefined) {
			heldBy.set(receiver, proposer);
			continue;
		}

		const ranks = receiverRank.get(receiver) as Map<string, number>;
		const currentRank = ranks.get(current) ?? Number.POSITIVE_INFINITY;
		const challengerRank = ranks.get(proposer) ?? Number.POSITIVE_INFINITY;
		if (challengerRank < currentRank) {
			heldBy.set(receiver, proposer);
			free.push(current);
		} else {
			free.push(proposer);
		}
	}

	return [...heldBy.entries()].map(([receiver, proposer]) => [proposer, receiver]);
}

export interface BuildPreferencesOptions<C, D> {
	/** Ranking goal woven into the question, e.g. "for this support ticket". */
	task: string;
	/** Build the Jev state for one chooser and one candidate. */
	stateOf: (chooser: C, candidate: D) => JevState;
	idOfChooser: (chooser: C) => string;
	idOfCandidate: (candidate: D) => string;
	maxPairsPerRequest?: number;
	random?: () => number;
}

/**
 * Rank every candidate for every chooser with pairwise comparisons.
 *
 * Each chooser gets its own pairwise sort, so this costs one sort per chooser.
 * Feed the result to {@link stableMatching} once both sides' preferences are
 * built.
 */
export async function buildPreferences<C, D>(
	client: JevClient,
	choosers: readonly C[],
	candidates: readonly D[],
	options: BuildPreferencesOptions<C, D>,
): Promise<Record<string, string[]>> {
	const {
		task,
		stateOf,
		idOfChooser,
		idOfCandidate,
		maxPairsPerRequest,
		random,
	} = options;

	const runtime: SortRuntimeOptions = { random };
	const prefs: Record<string, string[]> = {};

	for (const chooser of choosers) {
		const compare = createPairComparator(client, candidates, {
			task,
			stateOf: (candidate) => stateOf(chooser, candidate),
			maxPairsPerRequest,
			random,
		});
		const ordered = await sortByPairwiseWith(candidates, compare, runtime);
		prefs[idOfChooser(chooser)] = ordered.map(idOfCandidate);
	}

	return prefs;
}
