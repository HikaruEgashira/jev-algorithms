import type { JevAnswers, JevClient, JevEvaluation } from "../client.js";

const DEFAULT_MODEL = "typesafe/jev";

/** The shape of a Workers AI binding (`env.AI`). Structural, so no CF types. */
export interface AiBinding {
	run(model: string, input: unknown): Promise<unknown>;
}

/**
 * Jev over a Cloudflare Workers AI binding.
 *
 * Works with `env.AI` inside a Worker or a Durable Object. Kept structural so
 * this package stays free of `@cloudflare/workers-types`.
 */
export function createWorkersAiClient(
	binding: AiBinding,
	model: string = DEFAULT_MODEL,
): JevClient {
	return {
		async evaluate({ state, questions }: JevEvaluation): Promise<JevAnswers> {
			const raw = (await binding.run(model, { state, questions })) as {
				answers?: JevAnswers;
			};
			return raw?.answers ?? {};
		},
	};
}
