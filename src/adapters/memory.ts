import type { JevAnswers, JevClient, JevEvaluation } from "../client.js";

/** Produce the answers for one evaluation. May be async. */
export type MemoryResponder = (
	evaluation: JevEvaluation,
) => JevAnswers | Promise<JevAnswers>;

export interface MemoryClient extends JevClient {
	/** Every evaluation this client saw, in order. Handy in assertions. */
	readonly calls: JevEvaluation[];
}

/**
 * An in-memory Jev client driven by a responder.
 *
 * Use it to test a pipeline without calling the model, or to plug a
 * deterministic oracle into the sorting and clustering primitives.
 */
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
