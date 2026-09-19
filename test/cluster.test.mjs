import assert from "node:assert/strict";
import test from "node:test";
import {
	clusterByRelation,
	clusterWith,
	createMemoryClient,
	createRelationComparator,
} from "../dist/index.js";

function sameValueClient() {
	return createMemoryClient(({ state }) => {
		const answers = {};
		state.pairs.forEach(([a, b], k) => {
			answers[`p${k}`] = {
				type: "noul",
				noul: state.candidates[a] === state.candidates[b] ? 1 : 0,
			};
		});
		return answers;
	});
}

test("clusterByRelation groups equal values transitively", async () => {
	const items = [1, 1, 1, 2, 2, 3];
	const groups = await clusterByRelation(sameValueClient(), items, {
		relation: "number",
		stateOf: (v) => v,
	});

	const sizes = groups.map((g) => g.length).sort((a, b) => a - b);
	assert.deepEqual(sizes, [1, 2, 3]);
	assert.deepEqual([...groups.flat()].sort((a, b) => a - b), [1, 1, 1, 2, 2, 3]);
});

test("threshold controls merging", async () => {
	const items = [0, 1];
	const weak = await clusterWith(items, async () => [0.4], { threshold: 0.5 });
	assert.deepEqual(weak, [[0], [1]]);

	const strong = await clusterWith(items, async () => [0.6], { threshold: 0.5 });
	assert.deepEqual(strong, [[0, 1]]);
});

test("relation comparator batches 40 pairs per request", async () => {
	const items = Array.from({ length: 10 }, (_, i) => i);
	const client = createMemoryClient(({ state }) => {
		const answers = {};
		state.pairs.forEach((_, k) => {
			answers[`p${k}`] = { type: "noul", noul: 0 };
		});
		return answers;
	});
	const compare = createRelationComparator(client, items, {
		relation: "thing",
		stateOf: (v) => v,
	});

	const pairs = Array.from({ length: 90 }, (_, i) => [i % 10, (i + 1) % 10]);
	await compare(pairs);
	assert.equal(client.calls.length, 3, "90 pairs -> 3 requests");
	assert.equal(client.calls[0].state.candidates.length, 10, "each item travels once");
	for (const call of client.calls) {
		assert.ok(Object.keys(call.questions).length <= 40);
	}
});

test("relation comparator sends the pair state and rejects bad answers", async () => {
	const ok = createMemoryClient(() => ({ p0: { type: "noul", noul: 1 } }));
	const compare = createRelationComparator(ok, [{ k: 1 }, { k: 2 }], {
		relation: "ticket",
		stateOf: (item) => item.k,
	});
	assert.deepEqual(await compare([[0, 1]]), [1]);
	assert.deepEqual(ok.calls[0].state.candidates, [1, 2]);
	assert.equal(ok.calls[0].questions.p0.type, "noul");
	assert.equal(typeof ok.calls[0].questions.p0.criteria.true, "string");

	const missing = createRelationComparator(createMemoryClient(() => ({})), [0, 1], {
		relation: "thing",
		stateOf: (v) => v,
	});
	await assert.rejects(() => missing([[0, 1]]), /no answer/);

	const infinite = createRelationComparator(
		createMemoryClient(() => ({ p0: { type: "noul", noul: Infinity } })),
		[0, 1],
		{ relation: "thing", stateOf: (v) => v },
	);
	await assert.rejects(() => infinite([[0, 1]]), /no answer/);
});

test("clusterWith compares each unordered pair exactly once", async () => {
	let seen = null;
	await clusterWith([1, 2, 3], async (pairs) => {
		seen = pairs.map((p) => [...p]);
		return pairs.map(() => 0);
	});
	assert.deepEqual(seen, [
		[0, 1],
		[0, 2],
		[1, 2],
	]);
});

test("clusterWith merges exactly at the threshold", async () => {
	const groups = await clusterWith([0, 1], async () => [0.5], { threshold: 0.5 });
	assert.deepEqual(groups, [[0, 1]]);
});

test("clusterWith does not sample when the pair count equals the cap", async () => {
	const items = Array.from({ length: 31 }, (_, i) => i);
	let first = null;
	await clusterWith(
		items,
		async (pairs) => {
			first = [...pairs[0]];
			return pairs.map(() => 0);
		},
		{ maxComparisons: 465, random: () => 0 },
	);
	assert.deepEqual(first, [0, 1], "the natural first pair survives");
});

test("sampling shuffles deterministically under a fixed RNG", async () => {
	const items = Array.from({ length: 100 }, (_, i) => i);
	let first = null;
	await clusterWith(
		items,
		async (pairs) => {
			first = [...pairs[0]];
			return pairs.map(() => 0);
		},
		{ maxComparisons: 25, random: () => 0 },
	);
	assert.deepEqual(first, [0, 2]);
});

test("maxComparisons samples rather than exploding", async () => {
	const items = Array.from({ length: 100 }, (_, i) => i);
	let asked = 0;
	await clusterWith(
		items,
		async (pairs) => {
			asked += pairs.length;
			return pairs.map(() => 0);
		},
		{ maxComparisons: 25, random: () => 0.5 },
	);
	assert.equal(asked, 25);
});
