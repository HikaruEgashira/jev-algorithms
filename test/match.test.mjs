import assert from "node:assert/strict";
import test from "node:test";
import { buildPreferences, createMemoryClient, stableMatching } from "../dist/index.js";

test("stableMatching pairs proposer-optimally", () => {
	const pairs = stableMatching(
		["m1", "m2"],
		["w1", "w2"],
		{ m1: ["w1", "w2"], m2: ["w1", "w2"] },
		{ w1: ["m1", "m2"], w2: ["m1", "m2"] },
	).sort();

	assert.deepEqual(pairs, [
		["m1", "w1"],
		["m2", "w2"],
	]);
});

test("stableMatching resolves contention by receiver preference", () => {
	const pairs = stableMatching(
		["m1", "m2"],
		["w1", "w2"],
		{ m1: ["w1", "w2"], m2: ["w1", "w2"] },
		{ w1: ["m2", "m1"], w2: ["m1", "m2"] },
	).sort();

	assert.deepEqual(pairs, [
		["m1", "w2"],
		["m2", "w1"],
	]);
});

test("stableMatching leaves a proposer unmatched once its list is exhausted", () => {
	const pairs = stableMatching(
		["m1", "m2"],
		["w1"],
		{ m1: ["w1"], m2: ["w1"] },
		{ w1: ["m1", "m2"] },
	);
	assert.deepEqual(pairs, [["m1", "w1"]]);
});

test("stableMatching skips receivers outside the receiver set", () => {
	const pairs = stableMatching(["m1"], ["w1"], { m1: ["ghost", "w1"] }, { w1: ["m1"] });
	assert.deepEqual(pairs, [["m1", "w1"]]);
});

test("buildPreferences ranks independently per chooser", async () => {
	const choosers = [{ id: "c1" }, { id: "c2" }];
	const candidates = [
		{ id: "x", score: 1 },
		{ id: "y", score: 5 },
		{ id: "z", score: 3 },
	];
	const client = createMemoryClient(({ state }) => {
		const answers = {};
		state.pairs.forEach(([a, b], k) => {
			const left = state.candidates[a];
			const right = state.candidates[b];
			const higher = left.candidate.score > right.candidate.score;
			answers[`c${k}`] = {
				type: "noul",
				noul: left.chooser === "c1" ? (higher ? 1 : 0) : higher ? 0 : 1,
			};
		});
		return answers;
	});

	const prefs = await buildPreferences(client, choosers, candidates, {
		task: "for this chooser",
		stateOf: (chooser, candidate) => ({ chooser: chooser.id, candidate }),
		idOfChooser: (chooser) => chooser.id,
		idOfCandidate: (candidate) => candidate.id,
	});

	assert.deepEqual(prefs, { c1: ["y", "z", "x"], c2: ["x", "z", "y"] });
});


