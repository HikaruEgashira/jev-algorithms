import assert from "node:assert/strict";
import test from "node:test";
import {
	choice,
	chunk,
	createMemoryClient,
	noul,
	readChoice,
	readNoul,
	readScore,
	score,
	UnionFind,
} from "../dist/index.js";

test("question builders produce the Jev shapes", () => {
	assert.deepEqual(noul("Is it urgent?"), { type: "noul", instructions: "Is it urgent?" });
	assert.deepEqual(noul("Is it urgent?", { true: "yes", false: "no" }), {
		type: "noul",
		instructions: "Is it urgent?",
		criteria: { true: "yes", false: "no" },
	});
	assert.deepEqual(choice("Pick", { a: "A", b: "B" }), {
		type: "choice",
		instructions: "Pick",
		criteria: { a: "A", b: "B" },
	});
	assert.deepEqual(score("Rate", ["low", "high"]), {
		type: "score",
		instructions: "Rate",
		criteria: ["low", "high"],
	});
	assert.throws(() => score("Rate", ["only"]), /at least two/);
});

test("answer readers ignore absent or foreign answers", () => {
	const answers = {
		yes: { type: "noul", noul: 0.8 },
		pick: { type: "choice", choice: "a", confidence: 0.7 },
		grade: { type: "score", score: 1.5 },
	};
	assert.equal(readNoul(answers, "yes"), 0.8);
	assert.equal(readNoul(answers, "pick"), null);
	assert.equal(readNoul(answers, "missing"), null);
	assert.equal(readChoice(answers, "pick")?.choice, "a");
	assert.equal(readChoice(answers, "yes"), null);
	assert.equal(readScore(answers, "grade")?.score, 1.5);
	assert.equal(readScore(answers, "yes"), null);
});

test("memory client records every evaluation", async () => {
	const client = createMemoryClient(() => ({ a: { type: "noul", noul: 1 } }));
	const answers = await client.evaluate({
		state: { x: 1 },
		questions: { a: noul("?") },
	});
	assert.equal(readNoul(answers, "a"), 1);
	assert.equal(client.calls.length, 1);
	assert.deepEqual(client.calls[0].state, { x: 1 });
});

test("answer readers reject non-finite and non-numeric values", () => {
	const answers = {
		infinity: { type: "noul", noul: Infinity },
		nan: { type: "noul", noul: Number.NaN },
		text: { type: "noul", noul: "0.5" },
		zero: { type: "noul", noul: 0 },
	};
	assert.equal(readNoul(answers, "infinity"), null);
	assert.equal(readNoul(answers, "nan"), null);
	assert.equal(readNoul(answers, "text"), null);
	assert.equal(readNoul(answers, "zero"), 0);
});

test("chunk splits evenly and validates size", () => {
	assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
	assert.deepEqual(chunk([], 3), []);
	assert.deepEqual(chunk([1, 2, 3], 1), [[1], [2], [3]]);
	assert.throws(() => chunk([1], 0), /positive integer/);
	assert.throws(() => chunk([1], 1.5), /positive integer/);
});

test("union-find merges transitively and groups once", () => {
	const uf = new UnionFind([1, 2, 3, 4]);
	uf.union(1, 2);
	uf.union(2, 3);
	assert.equal(uf.connected(1, 3), true);
	assert.equal(uf.connected(1, 4), false);
	const sizes = uf
		.groups()
		.map((g) => g.length)
		.sort((a, b) => a - b);
	assert.deepEqual(sizes, [1, 3]);
});

test("union-find seeds groups from its constructor and add is idempotent", () => {
	const seeded = new UnionFind([1, 2]);
	assert.deepEqual(
		seeded
			.groups()
			.map((g) => g[0])
			.sort((a, b) => a - b),
		[1, 2],
	);

	// Re-adding a member must not detach it from its existing group.
	const uf = new UnionFind([1, 2]);
	uf.union(1, 2);
	uf.add(2);
	assert.equal(uf.connected(1, 2), true);
});

test("union-find handles an empty set, auto-insert, and self-union", () => {
	const empty = new UnionFind();
	assert.deepEqual(empty.groups(), []);
	assert.equal(empty.find("x"), "x");
	empty.union("x", "x");
	assert.deepEqual(empty.groups(), [["x"]]);
});

test("union-find merges a smaller tree into a larger one", () => {
	const uf = new UnionFind([1, 2, 3, 4]);
	uf.union(1, 2);
	uf.union(1, 3); // {1,2,3}
	uf.union(4, 1); // size 1 into size 3
	assert.equal(uf.connected(4, 2), true);
	const sizes = uf.groups().map((g) => g.length);
	assert.deepEqual(sizes, [4]);
});
