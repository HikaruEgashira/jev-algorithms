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
	UnionFind,
	DEFAULT_MAX_PAIRS_PER_REQUEST,
} from "../dist/index.js";

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const MODEL = process.env.TYPESAFE_MODEL || "jev-latest";
// TypeSafe publishes $0.042 per million input tokens; output tokens are free.
const USD_PER_INPUT_TOKEN = 0.042 / 1_000_000;
// A stage-1 comparison is ambiguous when its probability sits within this
// distance of 0.5. Tunable so the cluster sizes can be inspected.
const AMBIGUITY = Number(process.env.AMBIGUITY ?? 0.2);
// Number of repeated runs for the accuracy comparison.
const TRIALS = Number(process.env.TRIALS ?? 20);

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
 * Confidence-weighted order of a subset, given already-asked probabilities.
 * Confident comparisons dominate; near-ties barely move the score.
 */
function rankSubset(items, subset, pairs, probabilities) {
	const score = new Map(subset.map((index) => [items[index], 0]));
	pairs.forEach(([a, b], k) => {
		const margin = probabilities[k] - 0.5;
		score.set(items[a], score.get(items[a]) + margin);
		score.set(items[b], score.get(items[b]) - margin);
	});
	return [...subset]
		.sort((a, b) => score.get(items[b]) - score.get(items[a]))
		.map((index) => items[index]);
}

/**
 * Two-stage sort. Stage 1 is the normal quicksort and records each comparison's
 * probability. Pairs whose answer was ambiguous (p near 0.5) are unioned into
 * clusters; stage 2 brute-forces every pair inside those clusters and re-ranks
 * them by confidence. Clusters are far smaller than the input, so the exhaustive
 * second pass stays cheap. All clusters share one batched round of requests.
 */
async function twoStageSort(client, items, { task, stateOf, ambiguity }) {
	const comparisons = [];
	const compare = async (pairs) => {
		const probabilities = await askPairs(client, items, task, stateOf, pairs);
		comparisons.push({ pairs, probabilities });
		return probabilities.map((probability) => probability >= 0.5);
	};
	const stage1 = await sortByPairwiseWith(items, compare);

	const uf = new UnionFind(items.map((_, index) => index));
	for (const { pairs, probabilities } of comparisons)
		pairs.forEach(([a, b], k) => {
			if (Math.abs(probabilities[k] - 0.5) < ambiguity) uf.union(a, b);
		});
	const members = uf.groups().filter((cluster) => cluster.length >= 2);

	const stage2Pairs = [];
	for (const cluster of members)
		for (let i = 0; i < cluster.length; i++)
			for (let j = i + 1; j < cluster.length; j++)
				stage2Pairs.push([cluster[i], cluster[j]]);
	const stage2Probabilities = stage2Pairs.length
		? await askPairs(client, items, task, stateOf, stage2Pairs)
		: [];

	const stage2PairIndex = new Map();
	stage2Pairs.forEach(([a, b], k) => stage2PairIndex.set(`${a}|${b}`, k));
	const stage2ProbabilityOf = (a, b) => {
		const key = a < b ? `${a}|${b}` : `${b}|${a}`;
		const value = stage2Probabilities[stage2PairIndex.get(key)];
		return a < b ? value : 1 - value;
	};

	const order = [...stage1];
	for (const cluster of members) {
		const clusterPairs = [];
		for (let i = 0; i < cluster.length; i++)
			for (let j = i + 1; j < cluster.length; j++) clusterPairs.push([cluster[i], cluster[j]]);
		const probabilities = clusterPairs.map(([a, b]) => stage2ProbabilityOf(a, b));
		const reranked = rankSubset(items, cluster, clusterPairs, probabilities);
		const slots = cluster
			.map((index) => order.indexOf(items[index]))
			.sort((a, b) => a - b);
		slots.forEach((slot, k) => {
			order[slot] = reranked[k];
		});
	}

	const stage1Comparisons = comparisons.reduce(
		(sum, entry) => sum + entry.pairs.length,
		0,
	);
	return {
		order,
		clusters: members.map((cluster) => cluster.map((index) => items[index])),
		stage1Comparisons,
		stage2Comparisons: stage2Pairs.length,
		stage2Requests: stage2Pairs.length
			? Math.ceil(stage2Pairs.length / 40)
			: 0,
	};
}

/** Reference point: brute-force every pair over the whole input. */
async function fullRoundRobin(client, items, { task, stateOf }) {
	const indices = items.map((_, i) => i);
	const pairs = allPairs(items.length);
	const probabilities = await askPairs(client, items, task, stateOf, pairs);
	return rankSubset(items, indices, pairs, probabilities);
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
const TYPES = ["ほのお", "みず", "くさ", "でんき", "じめん", "ひこう", "いわ", "かくとう"];
// Single-type effectiveness (attacker -> defender); 2 = super, 0.5 = resisted, 0 = immune.
const CHART = {
	ほのお: { くさ: 2, みず: 0.5, いわ: 0.5, ほのお: 0.5 },
	みず: { ほのお: 2, じめん: 2, いわ: 2, くさ: 0.5, みず: 0.5 },
	くさ: { みず: 2, じめん: 2, いわ: 2, ほのお: 0.5, くさ: 0.5, ひこう: 0.5 },
	でんき: { みず: 2, ひこう: 2, くさ: 0.5, でんき: 0.5, じめん: 0 },
	じめん: { ほのお: 2, でんき: 2, いわ: 2, くさ: 0.5, ひこう: 0 },
	ひこう: { くさ: 2, かくとう: 2, でんき: 0.5, いわ: 0.5 },
	いわ: { ほのお: 2, ひこう: 2, かくとう: 0.5, じめん: 0.5 },
	かくとう: { いわ: 2, ひこう: 0.5 },
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

// ── 4. two-stage sort on a known ground truth ──────────────────────
// 12 countries by population. Jev sees only the names; the true order is known.
const COUNTRIES = [
	["日本", 124.5], ["ドイツ", 84.5], ["フランス", 68.2], ["イギリス", 67.7],
	["イタリア", 58.9], ["スペイン", 48.4], ["カナダ", 40.1], ["ポーランド", 36.8],
	["オーストラリア", 26.7], ["チリ", 19.6], ["ポルトガル", 10.5], ["ギリシャ", 10.3],
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

	const taus = { plain: [], twoStage: [], full: [] };
	const summaries = { plain: [], twoStage: [], full: [] };
	const clusterSizes = [];
	const stage2 = [];
	let lastOrders = { plain: [], twoStage: [], full: [] };
	for (let trial = 0; trial < trials; trial++) {
		const plain = recordingClient();
		lastOrders.plain = await sortByPairwise(plain.client, names, { task, stateOf });
		taus.plain.push(kendallTau(lastOrders.plain, truth));
		summaries.plain.push(summarize(plain.calls));

		const staged = recordingClient();
		const twoStage = await twoStageSort(staged.client, names, {
			task,
			stateOf,
			ambiguity: AMBIGUITY,
		});
		lastOrders.twoStage = twoStage.order;
		taus.twoStage.push(kendallTau(twoStage.order, truth));
		summaries.twoStage.push(summarize(staged.calls));
		clusterSizes.push(...twoStage.clusters.map((cluster) => cluster.length));
		stage2.push({
			comparisons: twoStage.stage2Comparisons,
			requests: twoStage.stage2Requests,
		});

		const full = recordingClient();
		lastOrders.full = await fullRoundRobin(full.client, names, { task, stateOf });
		taus.full.push(kendallTau(lastOrders.full, truth));
		summaries.full.push(summarize(full.calls));
	}

	const mean = (xs) => xs.reduce((sum, x) => sum + x, 0) / xs.length;
	const round = (xs) => xs.map((t) => +t.toFixed(3));
	const average = (runs) => {
		const averaged = averageSummaries(runs);
		return {
			comparisons: averaged.comparisons,
			requests: +averaged.requests.toFixed(1),
			usd: +averaged.usd.toFixed(6),
		};
	};
	return {
		truth: truth.join(" > "),
		tau: {
			plain: round(taus.plain),
			plainMean: +mean(taus.plain).toFixed(3),
			twoStage: round(taus.twoStage),
			twoStageMean: +mean(taus.twoStage).toFixed(3),
			full: round(taus.full),
			fullMean: +mean(taus.full).toFixed(3),
		},
		lastOrders: {
			plain: lastOrders.plain.join(" > "),
			twoStage: lastOrders.twoStage.join(" > "),
			full: lastOrders.full.join(" > "),
		},
		plain: average(summaries.plain),
		twoStage: average(summaries.twoStage),
		full: average(summaries.full),
		stage2: {
			clustersPerTrial: +(clusterSizes.length / trials).toFixed(1),
			meanClusterSize: clusterSizes.length
				? +mean(clusterSizes).toFixed(1)
				: 0,
			comparisonsMean: +mean(stage2.map((s) => s.comparisons)).toFixed(1),
			requestsMean: +mean(stage2.map((s) => s.requests)).toFixed(1),
		},
	};
}

const report = {
	inbox: await inbox(),
	scaling: await scaling(),
	pokemon: await pokemon(),
	confidence: await confidence(TRIALS),
};
console.log(JSON.stringify(report, null, 2));
