/** Aggregate noisy pairwise outcomes (which may cycle) into a global ranking. */

export interface Comparison {
	a: string;
	b: string;
	/**
	 * Which side won: "first" is `a`, "second" is `b`. Named by position, not
	 * by id, so a player literally called "a" or "b" cannot be confused.
	 * "draw" splits the point.
	 */
	winner: "first" | "second" | "draw";
}

export interface EloOptions {
	/** K-factor: how far one result moves a rating. Default 32. */
	k?: number;
	/** Starting rating for unseen players. Default 1000. */
	initial?: number;
	/** Passes over the comparison list. Default 1. */
	rounds?: number;
}

/** Elo ratings after replaying every comparison in order. */
export function elo(
	comparisons: readonly Comparison[],
	options: EloOptions = {},
): Record<string, number> {
	const { k = 32, initial = 1000, rounds = 1 } = options;
	const ratings = new Map<string, number>();

	const rating = (id: string) => {
		let value = ratings.get(id);
		if (value === undefined) {
			value = initial;
			ratings.set(id, value);
		}
		return value;
	};

	for (let round = 0; round < rounds; round++) {
		for (const { a, b, winner } of comparisons) {
			const ra = rating(a);
			const rb = rating(b);
			const expectedA = 1 / (1 + 10 ** ((rb - ra) / 400));
			const scoreA = winner === "first" ? 1 : winner === "second" ? 0 : 0.5;
			const delta = k * (scoreA - expectedA);
			ratings.set(a, ra + delta);
			ratings.set(b, rb - delta);
		}
	}

	return Object.fromEntries(ratings);
}

export interface BradleyTerryOptions {
	/** MM iterations. Default 100. */
	iterations?: number;
	/** Stop when the largest change falls below this. Default 1e-9. */
	tolerance?: number;
}

/**
 * Bradley-Terry strengths via the MM (minorize-maximize) algorithm.
 *
 * Draws count as half a win for each side. Players with no wins keep strength
 * 0, which is correct: BT is defined up to scale, only the order matters.
 */
export function bradleyTerry(
	comparisons: readonly Comparison[],
	options: BradleyTerryOptions = {},
): Record<string, number> {
	const { iterations = 100, tolerance = 1e-9 } = options;

	const players = new Set<string>();
	const wins = new Map<string, number>();
	// Pairwise game counts, keyed "i\u0000j" with i < j.
	const games = new Map<string, number>();

	const bump = (map: Map<string, number>, key: string, by: number) => {
		map.set(key, (map.get(key) ?? 0) + by);
	};
	const pairKey = (i: string, j: string) => (i < j ? `${i}\u0000${j}` : `${j}\u0000${i}`);

	for (const { a, b, winner } of comparisons) {
		players.add(a);
		players.add(b);
		bump(games, pairKey(a, b), 1);
		if (winner === "first") bump(wins, a, 1);
		else if (winner === "second") bump(wins, b, 1);
		else {
			bump(wins, a, 0.5);
			bump(wins, b, 0.5);
		}
	}

	const ids = [...players];
	const strength = new Map<string, number>();
	for (const id of ids) strength.set(id, Math.max(wins.get(id) ?? 0, 1e-6));

	// Denominator term for each player: sum_j n_ij / (p_i + p_j).
	for (let iteration = 0; iteration < iterations; iteration++) {
		const next = new Map<string, number>();
		let maxChange = 0;

		for (const id of ids) {
			let denominator = 0;
			for (const other of ids) {
				if (other === id) continue;
				const n = games.get(pairKey(id, other));
				if (!n) continue;
				denominator += n / ((strength.get(id) as number) + (strength.get(other) as number));
			}
			const w = wins.get(id) ?? 0;
			const value = denominator > 0 && w > 0 ? w / denominator : 1e-6;
			next.set(id, value);
			maxChange = Math.max(maxChange, Math.abs(value - (strength.get(id) as number)));
		}

		// Normalize to keep the scale from drifting.
		const total = [...next.values()].reduce((sum, v) => sum + v, 0) || 1;
		for (const [id, value] of next) next.set(id, value / total);

		for (const [id, value] of next) strength.set(id, value);
		if (maxChange < tolerance) break;
	}

	return Object.fromEntries(strength);
}

/** Ids ordered strongest-first by Bradley-Terry, ties broken by id. */
export function rankByBradleyTerry(comparisons: readonly Comparison[]): string[] {
	const strengths = bradleyTerry(comparisons);
	return Object.keys(strengths).sort(
		(a, b) => (strengths[b] as number) - (strengths[a] as number) || a.localeCompare(b),
	);
}

/** Ids ordered strongest-first by Elo, ties broken by id. */
export function rankByElo(comparisons: readonly Comparison[]): string[] {
	const ratings = elo(comparisons);
	return Object.keys(ratings).sort(
		(a, b) => (ratings[b] as number) - (ratings[a] as number) || a.localeCompare(b),
	);
}
