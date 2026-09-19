import assert from "node:assert/strict";
import test from "node:test";
import {
	booleanDecision,
	classifyChoice,
	createMemoryClient,
	rubricScore,
} from "../dist/index.js";

test("classifyChoice returns the chosen label and confidence", async () => {
	const client = createMemoryClient(() => ({
		choice: { type: "choice", choice: "billing", confidence: 0.9, probabilities: { billing: 0.9, sales: 0.1 } },
	}));
	const result = await classifyChoice(client, { ticket: "double charge" }, {
		instruction: "Which team?",
		labels: { billing: "payments", sales: "pricing" },
	});
	assert.equal(result.label, "billing");
	assert.equal(result.confidence, 0.9);
	assert.deepEqual(result.probabilities, { billing: 0.9, sales: 0.1 });
});

test("classifyChoice abstains below the confidence band", async () => {
	const client = createMemoryClient(() => ({
		choice: { type: "choice", choice: "billing", confidence: 0.3 },
	}));
	const result = await classifyChoice(client, {}, {
		instruction: "Which team?",
		labels: { billing: "payments", sales: "pricing" },
		abstainBelow: 0.5,
	});
	assert.equal(result.label, null);
});

test("booleanDecision thresholds the probability", async () => {
	const client = createMemoryClient(() => ({ decision: { type: "noul", noul: 0.82 } }));
	assert.equal(
		(await booleanDecision(client, {}, { instruction: "?", threshold: 0.8 })).value,
		true,
	);
	assert.equal(
		(await booleanDecision(client, {}, { instruction: "?", threshold: 0.9 })).value,
		false,
	);
});

test("classifyChoice falls back to the top probability when confidence is absent", async () => {
	const client = createMemoryClient(() => ({
		choice: { type: "choice", choice: "billing", probabilities: { billing: 0.6, sales: 0.4 } },
	}));
	const result = await classifyChoice(client, {}, {
		instruction: "Which team?",
		labels: { billing: "payments", sales: "pricing" },
	});
	assert.equal(result.confidence, 0.6);
	assert.equal(result.label, "billing");
});

test("classifyChoice keeps a label exactly at the abstain boundary", async () => {
	const client = createMemoryClient(() => ({ choice: { type: "choice", choice: "billing", confidence: 0.5 } }));
	const result = await classifyChoice(client, {}, {
		instruction: "?",
		labels: { billing: "b", sales: "s" },
		abstainBelow: 0.5,
	});
	assert.equal(result.label, "billing");
});

test("classify sends the label map as choice criteria", async () => {
	const client = createMemoryClient(() => ({ choice: { type: "choice", choice: "a", confidence: 1 } }));
	await classifyChoice(client, { ticket: 1 }, { instruction: "Pick", labels: { a: "A", b: "B" } });
	assert.deepEqual(client.calls[0].questions.choice, {
		type: "choice",
		instructions: "Pick",
		criteria: { a: "A", b: "B" },
	});
});

test("booleanDecision sends a noul question and rejects a missing or non-finite answer", async () => {
	const ok = createMemoryClient(() => ({ decision: { type: "noul", noul: 1 } }));
	await booleanDecision(ok, {}, { instruction: "?", criteria: { true: "t", false: "f" } });
	assert.deepEqual(ok.calls[0].questions.decision, {
		type: "noul",
		instructions: "?",
		criteria: { true: "t", false: "f" },
	});

	const empty = createMemoryClient(() => ({ decision: { type: "choice", choice: "a" } }));
	await assert.rejects(() => booleanDecision(empty, {}, { instruction: "?" }), /no answer/);

	const infinite = createMemoryClient(() => ({ decision: { type: "noul", noul: Infinity } }));
	await assert.rejects(() => booleanDecision(infinite, {}, { instruction: "?" }), /no answer/);
});

test("rubricScore sends the ordered levels and rejects a non-finite score", async () => {
	const ok = createMemoryClient(() => ({ rubric: { type: "score", score: 1 } }));
	await rubricScore(ok, {}, { instruction: "Rate", levels: ["low", "high"] });
	assert.deepEqual(ok.calls[0].questions.rubric, {
		type: "score",
		instructions: "Rate",
		criteria: ["low", "high"],
	});

	const infinite = createMemoryClient(() => ({ rubric: { type: "score", score: Infinity } }));
	await assert.rejects(() => rubricScore(infinite, {}, { instruction: "?", levels: ["a", "b"] }), /no score/);
});

test("classifyChoice validates its inputs and a missing answer", async () => {
	await assert.rejects(
		() => classifyChoice(createMemoryClient(() => ({})), {}, { instruction: "?", labels: { only: "one" } }),
		/at least two labels/,
	);
	const client = createMemoryClient(() => ({}));
	await assert.rejects(
		() => classifyChoice(client, {}, { instruction: "?", labels: { a: "a", b: "b" } }),
		/no choice/,
	);
});

test("booleanDecision treats 0.5 as true at the default threshold", async () => {
	const client = createMemoryClient(() => ({ decision: { type: "noul", noul: 0.5 } }));
	assert.equal((await booleanDecision(client, {}, { instruction: "?" })).value, true);
});

test("rubricScore normalizes the interpolated score", async () => {
	const client = createMemoryClient(() => ({
		rubric: { type: "score", score: 1.04, confidence: 0.9 },
	}));
	const result = await rubricScore(client, {}, {
		instruction: "How severe?",
		levels: ["low", "medium", "high"],
	});
	assert.equal(result.level, 1);
	assert.equal(result.label, "medium");
	assert.ok(Math.abs(result.normalized - 0.52) < 1e-9);
	assert.equal(result.confidence, 0.9);
});

test("rubricScore clamps out-of-range scores and defaults confidence", async () => {
	const low = createMemoryClient(() => ({ rubric: { type: "score", score: -3 } }));
	const lowResult = await rubricScore(low, {}, { instruction: "?", levels: ["a", "b", "c"] });
	assert.equal(lowResult.level, 0);
	assert.equal(lowResult.normalized, 0);
	assert.equal(lowResult.confidence, 0);

	const high = createMemoryClient(() => ({ rubric: { type: "score", score: 9 } }));
	const highResult = await rubricScore(high, {}, { instruction: "?", levels: ["a", "b", "c"] });
	assert.equal(highResult.level, 2);
	assert.equal(highResult.normalized, 1);

	await assert.rejects(
		() => rubricScore(createMemoryClient(() => ({})), {}, { instruction: "?", levels: ["only"] }),
		/at least two levels/,
	);
	await assert.rejects(
		() => rubricScore(createMemoryClient(() => ({})), {}, { instruction: "?", levels: ["a", "b"] }),
		/no score/,
	);
});
