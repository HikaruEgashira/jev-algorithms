import type { JevAnswers, JevClient, JevEvaluation } from "../client.js";

const DEFAULT_BASE_URL = "https://api.typesafe.ai/v1/systemone";
const DEFAULT_MODEL = "jev-latest";
const DEFAULT_TIMEOUT_MS = 15_000;

export interface TypeSafeClientOptions {
	/** TypeSafe API key. Keep it on the server; never ship it to a browser. */
	apiKey: string;
	/** Model id. Defaults to `jev-latest`. */
	model?: string;
	/** Endpoint override, e.g. for a gateway or a test double. */
	baseUrl?: string;
	/** Fetch implementation. Defaults to the global `fetch`. */
	fetch?: typeof fetch;
	timeoutMs?: number;
}

interface SystemOneResponse {
	answers?: JevAnswers;
	model?: string;
}

/** Jev over TypeSafe's HTTP API. */
export function createTypeSafeClient(options: TypeSafeClientOptions): JevClient {
	const {
		apiKey,
		model = DEFAULT_MODEL,
		baseUrl = DEFAULT_BASE_URL,
		timeoutMs = DEFAULT_TIMEOUT_MS,
	} = options;
	const doFetch = options.fetch ?? fetch;

	return {
		async evaluate({ state, questions }: JevEvaluation): Promise<JevAnswers> {
			const response = await doFetch(baseUrl, {
				method: "POST",
				headers: {
					authorization: `Bearer ${apiKey}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({ model, state, questions }),
				signal: AbortSignal.timeout(timeoutMs),
			});

			if (!response.ok) {
				throw new Error(`TypeSafe request failed: ${response.status}`);
			}

			const body = (await response.json()) as SystemOneResponse;
			return body.answers ?? {};
		},
	};
}
