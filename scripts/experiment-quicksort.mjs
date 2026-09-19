#!/usr/bin/env node
// End-to-end Jev experiments behind the article "JevでQuickSort".
//
//   TYPESAFE_API_KEY=... node scripts/experiment-quicksort.mjs
//
// Reads TYPESAFE_API_KEY / TYPESAFE_MODEL from the environment, calls the real
// TypeSafe API, and prints one JSON report: sort cost by n, the Pokemon cyclic
// dominance failure, and the confidence-verified ranking that fixes it.
import {
	sortByPairwise,
	sortByPairwiseWith,
	DEFAULT_MAX_PAIRS_PER_REQUEST,
} from "../dist/index.js";

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const MODEL = process.env.TYPESAFE_MODEL || "jev-latest";
// TypeSafe publishes $0.042 per million input tokens; output tokens are free.
const USD_PER_INPUT_TOKEN = 0.042 / 1_000_000;

const apiKey = process.env.TYPESAFE_API_KEY;
if (!apiKey) throw new Error("set TYPESAFE_API_KEY");

/** A JevClient that records every request, its latency, and its token usage. */
function recordingClient() {
	const calls = [];
	return {
		calls,
		client: {
			async evaluate({ state, questions }) {
				const started = performance.now();
				const response = await fetch(ENDPOINT, {
					method: "POST",
					headers: {
						authorization: `Bearer ${apiKey}`,
						"content-type": "application/json",
					},
					body: JSON.stringify({ model: MODEL, state, questions }),
					signal: AbortSignal.timeout(30_000),
				});
				const elapsed = performance.now() - started;
				if (!response.ok) {
					throw new Error(`TypeSafe request failed: ${response.status}`);
				}
				const body = await response.json();
				calls.push({
					questions: Object.keys(questions).length,
					ms: elapsed,
					inputTokens: body.usage?.input_tokens ?? 0,
					outputTokens: body.usage?.output_tokens ?? 0,
				});
				return body.answers ?? {};
			},
		},
	};
}

const percent = (values, p) => {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
};

/** Roll the recorded calls up into requests, comparisons, latency, tokens, cost. */
function summarize(calls) {
	const latencies = calls.map((call) => call.ms);
	const inputTokens = calls.reduce((sum, call) => sum + call.inputTokens, 0);
	return {
		requests: calls.length,
		comparisons: calls.reduce((sum, call) => sum + call.questions, 0),
		totalMs: Math.round(latencies.reduce((sum, ms) => sum + ms, 0)),
		medianMs: Math.round(percent(latencies, 0.5) ?? 0),
		p95Ms: Math.round(percent(latencies, 0.95) ?? 0),
		inputTokens,
		outputTokens: calls.reduce((sum, call) => sum + call.outputTokens, 0),
		usd: inputTokens * USD_PER_INPUT_TOKEN,
	};
}

/** Mean of several {@link summarize} results, for a noise-free cost table. */
function averageSummaries(runs) {
	const keys = ["requests", "comparisons", "totalMs", "medianMs", "p95Ms", "inputTokens", "outputTokens"];
	const mean = (key) =>
		runs.reduce((sum, run) => sum + run[key], 0) / runs.length;
	const averaged = Object.fromEntries(keys.map((key) => [key, mean(key)]));
	return {
		...averaged,
		totalMs: Math.round(averaged.totalMs),
		medianMs: Math.round(averaged.medianMs),
		p95Ms: Math.round(averaged.p95Ms),
		requests: Math.round(averaged.requests * 10) / 10,
		comparisons: Math.round(averaged.comparisons),
		inputTokens: Math.round(averaged.inputTokens),
		outputTokens: Math.round(averaged.outputTokens),
		usd: averaged.inputTokens * USD_PER_INPUT_TOKEN,
		runs: runs.length,
	};
}

const noulQuestion = (task, a, b) => ({
	type: "noul",
	instructions:
		`Does \`candidates[${a}]\` rank higher than \`candidates[${b}]\` ${task}? ` +
		`Answer true only if \`candidates[${a}]\` should come first.`,
	criteria: {
		true: `candidates[${a}] comes first`,
		false: `candidates[${b}] comes first, or the two tie`,
	},
});

/**
 * Ask Jev for a probability on every pair, batched 40 pairs per request and
 * sending each referenced item once (same shape as createPairComparator).
 */
async function askPairs(client, items, task, stateOf, pairs) {
	const probabilities = new Array(pairs.length).fill(0.5);
	for (let start = 0; start < pairs.length; start += DEFAULT_MAX_PAIRS_PER_REQUEST) {
		const part = pairs.slice(start, start + DEFAULT_MAX_PAIRS_PER_REQUEST);
		const localIndex = new Map();
		const candidates = [];
		const localize = (i) => {
			let local = localIndex.get(i);
			if (local === undefined) {
				local = candidates.length;
				localIndex.set(i, local);
				candidates.push(stateOf(items[i]));
			}
			return local;
		};
		const localPairs = part.map(([a, b]) => [localize(a), localize(b)]);
		const questions = {};
		localPairs.forEach(([a, b], k) => {
			questions[`c${k}`] = noulQuestion(task, a, b);
		});
		const answers = await client.evaluate({
			state: { candidates, pairs: localPairs },
			questions,
		});
		localPairs.forEach((_, k) => {
			const value = answers[`c${k}`];
			const probability = value && "noul" in value ? value.noul : undefined;
			if (typeof probability !== "number" || !Number.isFinite(probability)) {
				throw new Error("askPairs: Jev returned no answer for a comparison");
			}
			probabilities[start + k] = probability;
		});
	}
	return probabilities;
}

const allPairs = (n) => {
	const pairs = [];
	for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) pairs.push([i, j]);
	return pairs;
};

/**
 * Confidence-verified ranking: brute-force every pair, then order by the
 * confidence-weighted margin sum(p - 0.5). Confident comparisons dominate the
 * score, so near-ties cannot flip the result the way a single 0.51 answer can.
 */
async function rankByConfidence(client, items, { task, stateOf }) {
	const pairs = allPairs(items.length);
	const probabilities = await askPairs(client, items, task, stateOf, pairs);
	const score = new Map(items.map((item) => [item, 0]));
	pairs.forEach(([a, b], k) => {
		const margin = probabilities[k] - 0.5;
		score.set(items[a], score.get(items[a]) + margin);
		score.set(items[b], score.get(items[b]) - margin);
	});
	return [...items].sort((a, b) => score.get(b) - score.get(a));
}

// ── 1. usage example: reply-first inbox ────────────────────────────
async function inbox() {
	const mail = [
		{ from: "ceo@acme.com", subject: "契約書レビュー依頼", body: "金曜までに署名が必要です。" },
		{ from: "news@acme.com", subject: "週次ダイジェスト", body: "今週のトピックをまとめました。" },
		{ from: "alerts@acme.com", subject: "本番CPU使用率95%", body: "prod-web-3 がしきい値を超えています。" },
		{ from: "friend@acme.com", subject: "ランチ行きませんか", body: "特に用件はありません。今日の12時はどうですか。" },
		{ from: "customer@example.com", subject: "決済エラーが発生", body: "本番環境で決済が失敗しています。至急ご確認ください。" },
		{ from: "hr@acme.com", subject: "健康診断の案内", body: "来月の任意予約のご案内です。" },
		{ from: "ci@acme.com", subject: "ビルド失敗 #4212", body: "main のテストが2件失敗しました。" },
		{ from: "billing@vendor.com", subject: "未払いのお知らせ（期限超過）", body: "支払期限を3日過ぎています。至急ご対応ください。" },
	];
	const recorder = recordingClient();
	const ordered = await sortByPairwise(recorder.client, mail, {
		task: "for replying first",
		stateOf: (m) => ({ from: m.from, subject: m.subject, preview: m.body }),
	});
	return {
		order: ordered.map((m) => m.subject),
		...summarize(recorder.calls),
	};
}

// ── 2. cost and performance by n ───────────────────────────────────
// A plain deadline field keeps Jev's answers consistent, so the table shows the
// algorithm's batching cost rather than a degenerate adversarial input. Pivot
// choice is random, so each n is repeated and averaged.
async function scaling(repeats = 3) {
	const start = Date.parse("2026-09-19T09:00:00Z");
	const rows = [];
	for (const n of [8, 16, 32, 64]) {
		const items = Array.from({ length: n }, (_, i) => ({
			id: i,
			title: `チケット #${i}`,
			deadline: new Date(start + ((i * 37) % 365) * 86_400_000)
				.toISOString()
				.slice(0, 10),
		}));
		const runs = [];
		for (let repeat = 0; repeat < repeats; repeat++) {
			const recorder = recordingClient();
			await sortByPairwise(recorder.client, items, {
				task: "by how soon its deadline is",
				stateOf: (item) => ({ title: item.title, deadline: item.deadline }),
			});
			runs.push(summarize(recorder.calls));
		}
		rows.push({ n, ...averageSummaries(runs) });
	}
	return rows;
}

// ── 3. Pokemon: cyclic dominance ───────────────────────────────────
const TYPES = ["Fire", "Water", "Grass", "Electric", "Ground", "Flying", "Rock", "Fighting"];
// Single-type effectiveness (attacker -> defender); 2 = super, 0.5 = resisted, 0 = immune.
const CHART = {
	Fire: { Grass: 2, Water: 0.5, Rock: 0.5, Fire: 0.5 },
	Water: { Fire: 2, Ground: 2, Rock: 2, Grass: 0.5, Water: 0.5 },
	Grass: { Water: 2, Ground: 2, Rock: 2, Fire: 0.5, Grass: 0.5, Flying: 0.5 },
	Electric: { Water: 2, Flying: 2, Grass: 0.5, Electric: 0.5, Ground: 0 },
	Ground: { Fire: 2, Electric: 2, Rock: 2, Grass: 0.5, Flying: 0 },
	Flying: { Grass: 2, Fighting: 2, Electric: 0.5, Rock: 0.5 },
	Rock: { Fire: 2, Flying: 2, Fighting: 0.5, Ground: 0.5 },
	Fighting: { Rock: 2, Flying: 0.5 },
};
const effectiveness = (a, b) => (a === b ? 0.5 : (CHART[a]?.[b] ?? 1));
const beats = (a, b) => effectiveness(a, b) > effectiveness(b, a);

const pokemonTask =
	"in a single-type Pokemon battle, comparing only type effectiveness";
const pokemonState = (type) => ({ type });

async function pokemon() {
	const pairs = allPairs(TYPES.length);
	const recorder = recordingClient();
	const probabilities = await askPairs(
		recorder.client,
		TYPES,
		pokemonTask,
		pokemonState,
		pairs,
	);
	const matrix = pairs.map(([a, b], k) => ({ a, b, p: probabilities[k] }));
	const jevBeats = (a, b) => {
		const found = matrix.find(
			(entry) => (entry.a === a && entry.b === b) || (entry.a === b && entry.b === a),
		);
		return (found.a === a ? found.p : 1 - found.p) >= 0.5;
	};

	// Jev's answers, not the chart, decide the order; a cycle makes it arbitrary.
	// A triangle can cycle in either direction, so both orientations are checked.
	const findCycles = (winner) => {
		const found = [];
		for (let i = 0; i < TYPES.length; i++)
			for (let j = i + 1; j < TYPES.length; j++)
				for (let k = j + 1; k < TYPES.length; k++)
					for (const [x, y, z] of [[i, j, k], [i, k, j]])
						if (winner(x, y) && winner(y, z) && winner(z, x)) {
							found.push(`${TYPES[x]} > ${TYPES[y]} > ${TYPES[z]} > ${TYPES[x]}`);
							break;
						}
		return found;
	};
	const cycles = findCycles(jevBeats);

	const matrixLookup = new Map();
	matrix.forEach(({ a, b, p }) => {
		matrixLookup.set(`${a}|${b}`, p);
		matrixLookup.set(`${b}|${a}`, 1 - p);
	});
	const orderedFromMatrix = async (pairs) =>
		pairs.map(([a, b]) => matrixLookup.get(`${a}|${b}`) >= 0.5);

	const orders = [];
	for (const seed of [0, 0.5, 0.25]) {
		orders.push(
			await sortByPairwiseWith(TYPES, orderedFromMatrix, { random: () => seed }),
		);
	}

	// The textbook cycle the chart itself contains, independent of Jev.
	const chartCycles = findCycles((i, j) => beats(TYPES[i], TYPES[j]));

	return {
		jevCycles: cycles.length,
		jevCycleSample: cycles.slice(0, 3),
		chartCycles,
		orders: orders.map((order) => order.join(" > ")),
		distinctOrders: new Set(orders.map((order) => order.join(" > "))).size,
		...summarize(recorder.calls),
	};
}

// ── 4. confidence-verified ranking on a known ground truth ─────────
// 12 countries by population. Jev sees only the names; the true order is known.
const COUNTRIES = [
	["Japan", 124.5], ["Germany", 84.5], ["France", 68.2], ["United Kingdom", 67.7],
	["Italy", 58.9], ["Spain", 48.4], ["Canada", 40.1], ["Poland", 36.8],
	["Australia", 26.7], ["Chile", 19.6], ["Portugal", 10.5], ["Greece", 10.3],
];

const kendallTau = (a, b) => {
	let concordant = 0;
	let discordant = 0;
	for (let i = 0; i < a.length; i++)
		for (let j = i + 1; j < a.length; j++) {
			const ai = b.indexOf(a[i]);
			const aj = b.indexOf(a[j]);
			if (ai < aj) concordant++;
			else discordant++;
		}
	return (concordant - discordant) / (concordant + discordant);
};

async function confidence(trials = 5) {
	const names = COUNTRIES.map(([name]) => name);
	const truth = [...COUNTRIES].sort((a, b) => b[1] - a[1]).map(([name]) => name);
	const task = "by today's population, larger first";
	const stateOf = (name) => ({ country: name });

	const plainTau = [];
	const confidentTau = [];
	let plainCalls = [];
	let confidentCalls = [];
	let plainOrder = [];
	let confidentOrder = [];
	for (let trial = 0; trial < trials; trial++) {
		const plain = recordingClient();
		plainOrder = await sortByPairwise(plain.client, names, { task, stateOf });
		plainTau.push(kendallTau(plainOrder, truth));
		plainCalls = plain.calls;

		const verified = recordingClient();
		confidentOrder = await rankByConfidence(verified.client, names, { task, stateOf });
		confidentTau.push(kendallTau(confidentOrder, truth));
		confidentCalls = verified.calls;
	}

	const mean = (xs) => xs.reduce((sum, x) => sum + x, 0) / xs.length;
	return {
		truth: truth.join(" > "),
		plainTau: plainTau.map((t) => +t.toFixed(3)),
		plainTauMean: +mean(plainTau).toFixed(3),
		confidentTau: confidentTau.map((t) => +t.toFixed(3)),
		confidentTauMean: +mean(confidentTau).toFixed(3),
		lastPlainOrder: plainOrder.join(" > "),
		lastConfidentOrder: confidentOrder.join(" > "),
		plain: summarize(plainCalls),
		confident: summarize(confidentCalls),
	};
}

const report = {
	inbox: await inbox(),
	scaling: await scaling(),
	pokemon: await pokemon(),
	confidence: await confidence(),
};
console.log(JSON.stringify(report, null, 2));
