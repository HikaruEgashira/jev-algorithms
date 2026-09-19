import assert from "node:assert/strict";
import test from "node:test";
import { createMemoryClient, findFirstTrue } from "../dist/index.js";

function atLeastClient(threshold) {
	return createMemoryClient(({ state }) => ({
		is_true: { type: "noul", noul: state.candidate >= threshold ? 1 : 0 },
	}));
}

test("findFirstTrue finds the boundary in logarithmic steps", async () => {
	const items = Array.from({ length: 100 }, (_, i) => i);
	const result = await findFirstTrue(atLeastClient(42), items, {
		stateOf: (v) => v,
		instruction: "Is `candidate` at least 42?",
	});
	assert.equal(result.index, 42);
	assert.equal(result.item, 42);
	assert.ok(result.steps <= 7, `steps=${result.steps}`);
});

test("findFirstTrue handles never-true and always-true", async () => {
	const items = [1, 2, 3];
	const never = await findFirstTrue(atLeastClient(99), items, {
		stateOf: (v) => v,
		instruction: "?",
	});
	assert.equal(never.index, 3);
	assert.equal(never.item, null);

	const always = await findFirstTrue(atLeastClient(-1), items, {
		stateOf: (v) => v,
		instruction: "?",
	});
	assert.equal(always.index, 0);
	assert.equal(always.item, 1);
});

test("findFirstTrue rejects an unanswered question", async () => {
	const client = createMemoryClient(() => ({}));
	await assert.rejects(
		() => findFirstTrue(client, [1, 2], { stateOf: (v) => v, instruction: "?" }),
		/no answer/,
	);
});

test("findFirstTrue treats probability 0.5 as true", async () => {
	const client = createMemoryClient(() => ({ is_true: { type: "noul", noul: 0.5 } }));
	const result = await findFirstTrue(client, [10, 20], {
		stateOf: (v) => v,
		instruction: "?",
	});
	assert.equal(result.index, 0);
});

test("findFirstTrue forwards criteria and counts one step per comparison", async () => {
	const client = createMemoryClient(() => ({ is_true: { type: "noul", noul: 1 } }));
	const result = await findFirstTrue(client, [1, 2, 3, 4], {
		stateOf: (v) => v,
		instruction: "?",
		criteria: { true: "yes", false: "no" },
	});
	assert.deepEqual(client.calls[0].questions.is_true.criteria, { true: "yes", false: "no" });
	assert.equal(result.steps, client.calls.length);
	assert.equal(result.index, 0);
});
