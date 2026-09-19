import type { JevAnswers, JevClient, JevEvaluation } from "../client.js";

/** Produce the answers for one evaluation. May be async. */
export type MemoryResponder = (
	evaluation: JevEvaluation,
) => JevAnswers | Promise<JevAnswers>;

export interface MemoryClient extends JevClient {
	/** Every evaluation this client saw, in order. Handy in assertions. */
	readonly calls: JevEvaluation[];
}

/** In-memory Jev client driven by a responder, for tests and deterministic oracles. */
export function createMemoryClient(responder: MemoryResponder): MemoryClient {
	const calls: JevEvaluation[] = [];
	return {
		calls,
		async evaluate(input: JevEvaluation): Promise<JevAnswers> {
			calls.push(input);
			return responder(input);
		},
	};
}
