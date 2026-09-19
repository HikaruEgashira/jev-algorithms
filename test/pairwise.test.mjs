import assert from "node:assert/strict";
import test from "node:test";
import {
	createMemoryClient,
	createPairComparator,
	selectTopK,
	selectTopKIndices,
	selectTopKWith,
	sortByPairwise,
	sortByPairwiseWith,
} from "../dist/index.js";

function numericClient() {
	return createMemoryClient(({ state }) => {
		const answers = {};
		state.pairs.forEach(([a, b], k) => {
			answers[`c${k}`] = { type: "noul", noul: state.candidates[a] > state.candidates[b] ? 1 : 0 };
		});
		return answers;
	});
}

function shuffled(n, random = Math.random) {
	const values = Array.from({ length: n }, (_, i) => i);
	for (let i = n - 1; i > 0; i--) {
		const j = Math.floor(random() * (i + 1));
		[values[i], values[j]] = [values[j], values[i]];
	}
	return values;
}

test("comparator batches 40 pairs per request", async () => {
	const items = [0, 1, 2, 3];
	const client = numericClient();
	const compare = createPairComparator(client, items, { task: "by size", stateOf: (v) => v });

	const pairs = Array.from({ length: 80 }, (_, i) => [i % 4, (i + 1) % 4]);
	const decisions = await compare(pairs);

	assert.equal(client.calls.length, 2, "80 pairs -> 2 requests");
	assert.equal(decisions.length, 80);
	assert.equal(decisions[0], false, "pair [0,1]: 0 does not outrank 1");
	assert.equal(decisions[3], true, "pair [3,0]: 3 outranks 0");
	for (const call of client.calls) {
		assert.ok(Object.keys(call.questions).length <= 40);
	}
});

test("comparator sends each referenced item exactly once", async () => {
	const client = createMemoryClient(({ state }) => {
		const answers = {};
		state.pairs.forEach((_, k) => {
			answers[`c${k}`] = { type: "noul", noul: 0 };
		});
		return answers;
	});
	const compare = createPairComparator(
		client,
		[{ id: "a" }, { id: "b" }, { id: "c" }],
		{ task: "x", stateOf: (item) => item.id },
	);
	await compare([[0, 1], [0, 2]]);
	assert.deepEqual(client.calls[0].state.candidates, ["a", "b", "c"]);
});

test("comparator throws when Jev omits an answer or returns a non-finite one", async () => {
	const missing = createMemoryClient(() => ({}));
	await assert.rejects(
		() => createPairComparator(missing, [0, 1], { task: "x", stateOf: (v) => v })([[0, 1]]),
		/no answer/,
	);

	const infinite = createMemoryClient(() => ({ c0: { type: "noul", noul: Infinity } }));
	await assert.rejects(
		() => createPairComparator(infinite, [0, 1], { task: "x", stateOf: (v) => v })([[0, 1]]),
		/no answer/,
	);
});

test("sortByPairwise returns a strict highest-first order", async () => {
	for (let trial = 0; trial < 50; trial++) {
		const n = 2 + (trial % 24);
		const values = shuffled(n);
		const client = createMemoryClient(({ state }) => {
			const answers = {};
			state.pairs.forEach(([a, b], k) => {
				answers[`c${k}`] = {
					type: "noul",
					noul: state.candidates[a] > state.candidates[b] ? 1 : 0,
				};
			});
			return answers;
		});
		const ordered = await sortByPairwise(client, values, {
			task: "by size",
			stateOf: (v) => v,
		});
		const expected = [...values].sort((a, b) => b - a);
		assert.deepEqual(ordered, expected, `n=${n}`);
	}
});

test("sortByPairwiseWith only needs a comparator", async () => {
	const items = ["a", "b", "c", "d"];
	const rank = { a: 1, b: 4, c: 2, d: 3 };
	const ordered = await sortByPairwiseWith(items, async (pairs) =>
		pairs.map(([x, y]) => rank[items[x]] > rank[items[y]]),
	);
	assert.deepEqual(ordered, ["b", "d", "c", "a"]);
});

test("sorting zero or one item never compares", async () => {
	let calls = 0;
	const compare = async () => {
		calls++;
		return [];
	};
	assert.deepEqual(await sortByPairwiseWith([], compare), []);
	assert.deepEqual(await sortByPairwiseWith(["only"], compare), ["only"]);
	assert.equal(calls, 0);
});

test("comparator treats probability 0.5 as the first item winning", async () => {
	const client = createMemoryClient(() => ({ c0: { type: "noul", noul: 0.5 } }));
	const compare = createPairComparator(client, [0, 1], { task: "x", stateOf: (v) => v });
	assert.deepEqual(await compare([[0, 1]]), [true]);
});

test("comparator sends mapped states and a noul question", async () => {
	const client = createMemoryClient(() => ({ c0: { type: "noul", noul: 1 } }));
	const compare = createPairComparator(client, [{ id: "a" }, { id: "b" }], {
		task: "by id",
		stateOf: (item) => item.id,
	});
	await compare([[0, 1]]);

	assert.deepEqual(client.calls[0].state.candidates, ["a", "b"]);
	assert.deepEqual(client.calls[0].state.pairs, [[0, 1]]);
	const question = client.calls[0].questions.c0;
	assert.equal(question.type, "noul");
	assert.match(question.instructions, /candidates\[0\]/);
	assert.equal(typeof question.criteria.true, "string");
	assert.equal(typeof question.criteria.false, "string");
});

test("selectTopK ranks the winners through the client", async () => {
	const client = createMemoryClient(({ state }) => {
		const answers = {};
		state.pairs.forEach(([a, b], k) => {
			answers[`c${k}`] = {
				type: "noul",
				noul: state.candidates[a] > state.candidates[b] ? 1 : 0,
			};
		});
		return answers;
	});
	const out = await selectTopK(client, [3, 1, 2, 5, 4], 2, {
		task: "by size",
		stateOf: (v) => v,
	});
	assert.deepEqual(out, [5, 4]);
});

test("sorting falls back to a permutation at the round cap", async () => {
	const compare = async (pairs) => pairs.map(() => false);
	const items = [1, 2, 3, 4, 5];
	const out = await sortByPairwiseWith(items, compare, { maxRounds: 2, random: () => 0 });
	assert.deepEqual([...out].sort((a, b) => a - b), [1, 2, 3, 4, 5]);
});

test("selectTopKWith handles k <= 0 and k >= n", async () => {
	const values = [3, 1, 2];
	const compare = async (pairs) => pairs.map(([a, b]) => values[a] > values[b]);
	assert.deepEqual(await selectTopKWith(values, 0, compare), []);
	assert.deepEqual(await selectTopKWith(values, 5, compare), [3, 2, 1]);
});

test("selectTopKIndices falls back to the remaining candidates at the round cap", async () => {
	const compare = async (pairs) => pairs.map(() => false);
	const picked = await selectTopKIndices([0, 1, 2, 3, 4], 2, compare, {
		maxRounds: 1,
		random: () => 0,
	});
	assert.equal(picked.length, 2);
	assert.equal(new Set(picked).size, 2);
});

test("selectTopKWith returns the ordered top k", async () => {
	for (let trial = 0; trial < 30; trial++) {
		const n = 1 + (trial % 15);
		const values = shuffled(n);
		const k = (trial % n) + 1;
		const items = values.map((v) => v);
		const ordered = await selectTopKWith(items, k, async (pairs) =>
			pairs.map(([x, y]) => values[x] > values[y]),
		);
		const expected = [...values].sort((a, b) => b - a).slice(0, k);
		assert.deepEqual(ordered, expected, `n=${n} k=${k}`);
	}
});

test("selectTopKWith uses fewer comparisons than a full sort with balanced pivots", async () => {
	let comparisons = 0;
	const n = 64;
	const random = () => 0.5;
	const values = Array.from({ length: n }, (_, i) => i);
	let selections = 0;
	const ordered = await selectTopKWith(
		values,
		3,
		async (pairs) => {
			comparisons += pairs.length;
			selections++;
			return pairs.map(([x, y]) => values[x] > values[y]);
		},
		{ random },
	);
	assert.deepEqual(ordered, [...values].sort((a, b) => b - a).slice(0, 3));
	assert.ok(comparisons < 4 * n, `expected < ${4 * n} comparisons, got ${comparisons}`);
	assert.ok(selections < 3 * Math.log2(n) + 5, `rounds=${selections}`);
});
