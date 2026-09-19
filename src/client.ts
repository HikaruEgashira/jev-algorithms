/** The Jev client contract: one state, many typed questions, typed answers. */

/** Any JSON value Jev can read as shared state. */
export type JevState =
	| string
	| number
	| boolean
	| null
	| JevState[]
	| { [key: string]: JevState };

/** Is this true? Answers with `noul`, the probability the answer is yes. */
export interface NoulQuestion {
	type: "noul";
	instructions: string;
	criteria?: { true?: string; false?: string };
}

/** Which of these options? Answers with one key from `criteria`. */
export interface ChoiceQuestion {
	type: "choice";
	instructions: string;
	/** Option key -> description. */
	criteria: Record<string, string>;
}

/** Where on this ordered scale? Answers with an interpolated `score`. */
export interface ScoreQuestion {
	type: "score";
	instructions: string;
	/** At least two ordered labels, lowest first. */
	criteria: string[];
}

export type JevQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;
export type JevQuestions = Record<string, JevQuestion>;

export interface NoulAnswer {
	type?: "noul";
	/** Probability the answer is yes, 0–1. */
	noul: number;
}

export interface ChoiceAnswer {
	type?: "choice";
	choice: string;
	confidence?: number;
	probabilities?: Record<string, number>;
}

export interface ScoreAnswer {
	type?: "score";
	/** Interpolated position on the scale, 0..criteria.length-1. */
	score: number;
	confidence?: number;
	legend?: Record<string, string>;
	probabilities?: Record<string, number>;
}

export type JevAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer;
export type JevAnswers = Record<string, JevAnswer>;

export interface JevEvaluation {
	state: JevState;
	questions: JevQuestions;
}

export interface JevClient {
	/** Evaluate one state against many questions in a single round trip. */
	evaluate(input: JevEvaluation): Promise<JevAnswers>;
}

/** Build a Noul question. `criteria` sharpens what true and false mean. */
export function noul(
	instructions: string,
	criteria?: { true?: string; false?: string },
): NoulQuestion {
	return criteria ? { type: "noul", instructions, criteria } : { type: "noul", instructions };
}

/** Build a Choice question from an option map. */
export function choice(
	instructions: string,
	criteria: Record<string, string>,
): ChoiceQuestion {
	return { type: "choice", instructions, criteria };
}

/** Build a Score question from ordered labels, lowest first. */
export function score(instructions: string, criteria: string[]): ScoreQuestion {
	if (criteria.length < 2) {
		throw new Error("score() needs at least two criteria labels");
	}
	return { type: "score", instructions, criteria };
}

/** Read a Noul answer as a probability, or null if Jev did not answer it. */
export function readNoul(answers: JevAnswers, id: string): number | null {
	const answer = answers[id];
	if (!answer || !("noul" in answer)) return null;
	const value = (answer as NoulAnswer).noul;
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Read a Choice answer, or null if Jev did not answer it. */
export function readChoice(answers: JevAnswers, id: string): ChoiceAnswer | null {
	const answer = answers[id];
	return answer && "choice" in answer ? (answer as ChoiceAnswer) : null;
}

/** Read a Score answer, or null if Jev did not answer it. */
export function readScore(answers: JevAnswers, id: string): ScoreAnswer | null {
	const answer = answers[id];
	return answer && "score" in answer ? (answer as ScoreAnswer) : null;
}
