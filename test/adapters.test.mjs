import assert from "node:assert/strict";
import test from "node:test";
import { createTypeSafeClient, createWorkersAiClient, noul } from "../dist/index.js";

function fetched(response) {
	const calls = [];
	const fetchImpl = async (url, init) => {
		calls.push({ url, init });
		return response;
	};
	return { fetch: fetchImpl, calls };
}

const ok = (answers) => ({ ok: true, status: 200, json: async () => ({ answers }) });

test("typeSafe client posts the evaluation and returns answers", async () => {
	const { fetch, calls } = fetched(ok({ a: { type: "noul", noul: 0.7 } }));
	const client = createTypeSafeClient({ apiKey: "secret", fetch });

	const answers = await client.evaluate({ state: { x: 1 }, questions: { a: noul("?") } });
	assert.equal(answers.a.noul, 0.7);

	assert.equal(calls.length, 1);
	const [{ url, init }] = calls;
	assert.equal(url, "https://api.typesafe.ai/v1/systemone");
	assert.equal(init.method, "POST");
	assert.equal(init.headers.authorization, "Bearer secret");
	assert.equal(init.headers["content-type"], "application/json");
	const body = JSON.parse(init.body);
	assert.equal(body.model, "jev-latest");
	assert.deepEqual(body.state, { x: 1 });
	assert.deepEqual(body.questions, { a: { type: "noul", instructions: "?" } });
});

test("typeSafe client honours model and baseUrl overrides", async () => {
	const { fetch, calls } = fetched(ok({}));
	const client = createTypeSafeClient({
		apiKey: "k",
		model: "jev-1.13.0",
		baseUrl: "https://gateway.example/run",
		fetch,
	});
	assert.deepEqual(await client.evaluate({ state: null, questions: {} }), {});
	assert.equal(calls[0].url, "https://gateway.example/run");
	assert.equal(JSON.parse(calls[0].init.body).model, "jev-1.13.0");
});

test("typeSafe client throws on a non-ok response", async () => {
	const { fetch } = fetched({ ok: false, status: 401, json: async () => ({}) });
	const client = createTypeSafeClient({ apiKey: "k", fetch });
	await assert.rejects(
		() => client.evaluate({ state: null, questions: {} }),
		/401/,
	);
});

test("typeSafe client defaults to the global fetch", async () => {
	const original = globalThis.fetch;
	const { fetch, calls } = fetched(ok({}));
	globalThis.fetch = fetch;
	try {
		const client = createTypeSafeClient({ apiKey: "k" });
		await client.evaluate({ state: null, questions: {} });
		assert.equal(calls.length, 1);
	} finally {
		globalThis.fetch = original;
	}
});

test("workers-ai client forwards to the binding and unwraps answers", async () => {
	const calls = [];
	const binding = {
		run: async (model, input) => {
			calls.push({ model, input });
			return { answers: { a: { type: "noul", noul: 1 } } };
		},
	};
	const client = createWorkersAiClient(binding);
	const answers = await client.evaluate({ state: 1, questions: { a: noul("?") } });

	assert.equal(answers.a.noul, 1);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].model, "typesafe/jev");
	assert.deepEqual(calls[0].input, { state: 1, questions: { a: { type: "noul", instructions: "?" } } });
});

test("workers-ai client takes a model override and tolerates a missing payload", async () => {
	const calls = [];
	const binding = {
		run: async (model) => {
			calls.push(model);
			return {};
		},
	};
	const client = createWorkersAiClient(binding, "typesafe/jev-preview");
	assert.deepEqual(await client.evaluate({ state: null, questions: {} }), {});
	assert.equal(calls[0], "typesafe/jev-preview");
});
