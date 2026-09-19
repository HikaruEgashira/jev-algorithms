import { choice, noul, score, type JevClient, type JevState } from "../client.js";

export interface ClassifyChoiceOptions {
	/** Question text, e.g. "Which team should handle this ticket?" */
	instruction: string;
	/** Option key -> description. */
	labels: Record<string, string>;
	/**
	 * Abstain when Jev's confidence is below this. Default 0, which never
	 * abstains. Raise it to route uncertain cases to a human.
	 */
	abstainBelow?: number;
	/** Question id. Default "choice". */
	id?: string;
}

export interface ClassifyChoiceResult {
	/** Chosen label, or null when abstaining. */
	label: string | null;
	confidence: number;
	probabilities: Record<string, number>;
}

/**
 * Pick one label with an optional abstain band.
 *
 * Jev returns the full probability distribution plus a confidence score, so a
 * caller can act on high confidence, escalate the middle, and drop the rest
 * instead of forcing a guess.
 */
export async function classifyChoice(
	client: JevClient,
	state: JevState,
	options: ClassifyChoiceOptions,
): Promise<ClassifyChoiceResult> {
	const { instruction, labels, abstainBelow = 0, id = "choice" } = options;
	if (Object.keys(labels).length < 2) {
		throw new Error("classifyChoice needs at least two labels");
	}

	const answers = await client.evaluate({
		state,
		questions: { [id]: choice(instruction, labels) },
	});

	const answer = answers[id];
	if (!answer || !("choice" in answer)) {
		throw new Error("classifyChoice: Jev returned no choice");
	}

	const probabilities = answer.probabilities ?? {};
	const confidence =
		typeof answer.confidence === "number"
			? answer.confidence
			: (probabilities[answer.choice] ?? 1);

	return {
		label: confidence >= abstainBelow ? answer.choice : null,
		confidence,
		probabilities,
	};
}

export interface BooleanDecisionOptions {
	instruction: string;
	criteria?: { true?: string; false?: string };
	/** Probability at or above which the decision is true. Default 0.5. */
	threshold?: number;
	/** Question id. Default "decision". */
	id?: string;
}

/** Ask a yes/no question and return the probability plus a thresholded verdict. */
export async function booleanDecision(
	client: JevClient,
	state: JevState,
	options: BooleanDecisionOptions,
): Promise<{ value: boolean; probability: number }> {
	const { instruction, criteria, threshold = 0.5, id = "decision" } = options;
	const answers = await client.evaluate({
		state,
		questions: { [id]: noul(instruction, criteria) },
	});

	const answer = answers[id];
	const probability = answer && "noul" in answer ? answer.noul : undefined;
	if (typeof probability !== "number" || !Number.isFinite(probability)) {
		throw new Error("booleanDecision: Jev returned no answer");
	}
	return { value: probability >= threshold, probability };
}

export interface RubricScoreOptions {
	instruction: string;
	/** Ordered labels, lowest first. */
	levels: string[];
	/** Question id. Default "rubric". */
	id?: string;
}

export interface RubricScoreResult {
	/** Interpolated position on the scale, 0..levels.length-1. */
	score: number;
	/** Nearest level index. */
	level: number;
	/** Scale label for `level`. */
	label: string;
	/** `score` mapped to 0–1. */
	normalized: number;
	confidence: number;
}

/** Grade a state against an ordered rubric and return the interpolated score. */
export async function rubricScore(
	client: JevClient,
	state: JevState,
	options: RubricScoreOptions,
): Promise<RubricScoreResult> {
	const { instruction, levels, id = "rubric" } = options;
	if (levels.length < 2) throw new Error("rubricScore needs at least two levels");

	const answers = await client.evaluate({
		state,
		questions: { [id]: score(instruction, levels) },
	});

	const answer = answers[id];
	const value = answer && "score" in answer ? answer.score : undefined;
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error("rubricScore: Jev returned no score");
	}

	const max = levels.length - 1;
	const clamped = Math.max(0, Math.min(max, value));
	const level = Math.round(clamped);
	return {
		score: value,
		level,
		label: levels[level],
		normalized: clamped / max,
		confidence: answer && "confidence" in answer ? (answer.confidence ?? 0) : 0,
	};
}
