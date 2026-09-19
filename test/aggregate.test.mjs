import assert from "node:assert/strict";
import test from "node:test";
import { bradleyTerry, elo, rankByBradleyTerry, rankByElo } from "../dist/index.js";

const transitive = [
	{ a: "a", b: "b", winner: "first" },
	{ a: "a", b: "c", winner: "first" },
	{ a: "b", b: "c", winner: "first" },
];

test("bradleyTerry ranks a strict transitive order", () => {
	const strengths = bradleyTerry(transitive);
	assert.ok(strengths.a > strengths.b, "a > b");
	assert.ok(strengths.b > strengths.c, "b > c");
	assert.deepEqual(rankByBradleyTerry(transitive), ["a", "b", "c"]);
});

test("elo ranks a strict transitive order", () => {
	const ratings = elo(transitive, { rounds: 10 });
	assert.ok(ratings.a > ratings.b);
	assert.ok(ratings.b > ratings.c);
	assert.deepEqual(rankByElo(transitive), ["a", "b", "c"]);
});

test("draws count as half a win on both sides", () => {
	const strengths = bradleyTerry([
		{ a: "x", b: "y", winner: "draw" },
		{ a: "x", b: "z", winner: "first" },
		{ a: "y", b: "z", winner: "first" },
	]);
	assert.ok(strengths.x > strengths.z, "x > z");
	assert.ok(strengths.y > strengths.z, "y > z");
});

test("the losing side of a non-draw is credited to b, not to a", () => {
	const strengths = bradleyTerry([{ a: "b", b: "c", winner: "second" }]);
	assert.ok(strengths.c > strengths.b, "c won, so c > b");
});

test("elo uses the documented default k and initial", () => {
	const ratings = elo([{ a: "p", b: "q", winner: "first" }]);
	assert.equal(ratings.p, 1016);
	assert.equal(ratings.q, 984);
});

test("elo honours rounds and initial overrides", () => {
	const once = elo([{ a: "p", b: "q", winner: "first" }], { rounds: 1 });
	const twice = elo([{ a: "p", b: "q", winner: "first" }], { rounds: 2 });
	assert.ok(twice.p > once.p, "a second pass moves the rating further");

	const fromZero = elo([{ a: "p", b: "q", winner: "first" }], { initial: 0 });
	assert.equal(fromZero.p, 16);
	assert.equal(fromZero.q, -16);
});

test("bradleyTerry with zero iterations returns the initial strengths", () => {
	const strengths = bradleyTerry(transitive, { iterations: 0 });
	assert.equal(strengths.a, 2);
	assert.equal(strengths.b, 1);
	assert.ok(strengths.c > 0 && strengths.c < 1e-5, "a no-win player is not zeroed out");
});

test("bradleyTerry normalizes strengths to sum to one", () => {
	const strengths = bradleyTerry(transitive);
	const sum = Object.values(strengths).reduce((total, value) => total + value, 0);
	assert.ok(Math.abs(sum - 1) < 1e-9, `sum=${sum}`);
});

test("elo credits a second-side win to the second player", () => {
	const ratings = elo([{ a: "p", b: "q", winner: "second" }]);
	assert.equal(ratings.q, 1016);
	assert.equal(ratings.p, 984);
});

test("bradleyTerry keeps a no-win player above zero", () => {
	const strengths = bradleyTerry(transitive);
	assert.ok(strengths.c > 0, "c never won, yet is not zeroed out");
});

test("ranking breaks a draw tie by id, not insertion order", () => {
	const draw = [{ a: "z", b: "a", winner: "draw" }];
	assert.deepEqual(rankByElo(draw), ["a", "z"]);
	assert.deepEqual(rankByBradleyTerry(draw), ["a", "z"]);
});

test("a cycle still yields a total order", () => {
	const noisy = [
		{ a: "r", b: "p", winner: "first" },
		{ a: "p", b: "s", winner: "first" },
		{ a: "s", b: "r", winner: "first" },
	];
	const order = rankByBradleyTerry(noisy);
	assert.equal(order.length, 3);
	assert.deepEqual([...order].sort(), ["p", "r", "s"]);
});
