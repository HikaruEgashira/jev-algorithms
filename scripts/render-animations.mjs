#!/usr/bin/env node
// Renders docs/animations/*.gif from the real algorithms in dist.
// SVG frame -> rsvg-convert -> PNG -> ffmpeg -> GIF.  npm run animations
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	clusterWith,
	createMemoryClient,
	DEFAULT_MAX_CLUSTER_PAIRS_PER_REQUEST,
	DEFAULT_MAX_PAIRS_PER_REQUEST,
	findFirstTrue,
	selectTopKIndices,
	sortWith,
	UnionFind,
} from "../dist/index.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "docs", "animations");
const TMP_DIR = join(ROOT, ".animation-frames");

const W = 760;
const H = 440;
const FPS = 10;

const C = {
	bg: "#0f0f14",
	surface: "#1c1c24",
	line: "#33333d",
	text: "#e7e7ea",
	muted: "#6f6f7b",
	accent: "#6b76e0",
	accentDeep: "#3d4380",
	good: "#4ade80",
	bad: "#f87171",
	amber: "#fbbf24",
};

const FONT = "ui-sans-serif, -apple-system, 'Helvetica Neue', Arial, sans-serif";
const KIND = {
	normal: [C.surface, C.line],
	pivot: [C.accent, C.accent],
	good: [C.good, C.good],
	bad: [C.bad, C.bad],
	candidate: [C.accentDeep, C.accent],
	top: [C.accent, C.accent],
	muted: [C.surface, C.line],
	amber: [C.amber, C.amber],
};

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const text = (x, y, value, o = {}) =>
	`<text x="${x}" y="${y}" fill="${o.fill ?? C.text}" font-family="${FONT}" font-size="${o.size ?? 15}" font-weight="${o.weight ?? 400}" text-anchor="${o.anchor ?? "middle"}" opacity="${o.opacity ?? 1}">${esc(value)}</text>`;

const rect = (x, y, w, h, o = {}) =>
	`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${o.rx ?? 5}" fill="${o.fill ?? "none"}" stroke="${o.stroke ?? "none"}" stroke-width="${o.width ?? 1.5}" opacity="${o.opacity ?? 1}"/>`;

const line = (x1, y1, x2, y2, o = {}) =>
	`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${o.stroke ?? C.line}" stroke-width="${o.width ?? 1.5}"${o.dash ? ` stroke-dasharray="${o.dash}"` : ""} opacity="${o.opacity ?? 1}" stroke-linecap="round"/>`;

function svgFrame(title, subtitle, body) {
	return (
		`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
		rect(0, 0, W, H, { fill: C.bg, rx: 0 }) +
		text(32, 44, title, { size: 20, weight: 600, anchor: "start" }) +
		(subtitle ? text(32, 68, subtitle, { size: 13, fill: C.muted, anchor: "start" }) : "") +
		body +
		`</svg>`
	);
}

function legend(y, items) {
	return items
		.map(
			([color, label], i) =>
				`<circle cx="${40 + i * 160}" cy="${y}" r="5" fill="${color}"/>` +
				text(52 + i * 160, y + 4, label, { size: 12, fill: C.muted, anchor: "start" }),
		)
		.join("");
}

const framesOf = (steps) => steps.flatMap(({ svg, hold = 2 }) => Array(hold).fill(svg));

function toGif(name, steps) {
	const frames = framesOf(steps);
	const dir = join(TMP_DIR, name);
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	mkdirSync(OUT_DIR, { recursive: true });

	frames.forEach((svg, i) => writeFileSync(join(dir, `frame-${String(i).padStart(4, "0")}.svg`), svg));
	frames.forEach((_, i) => {
		const svg = join(dir, `frame-${String(i).padStart(4, "0")}.svg`);
		execFileSync("rsvg-convert", ["-w", String(W), "-h", String(H), svg, "-o", svg.replace(/\.svg$/, ".png")]);
	});

	execFileSync("ffmpeg", [
		"-y", "-loglevel", "error", "-framerate", String(FPS),
		"-i", join(dir, "frame-%04d.png"),
		"-vf", "split[s0][s1];[s0]palettegen=stats_mode=full:max_colors=256[p];[s1][p]paletteuse=dither=sierra2_4a",
		"-loop", "0", join(OUT_DIR, `${name}.gif`),
	]);
	if (!process.env.KEEP_FRAMES) rmSync(dir, { recursive: true, force: true });
	console.log(`  docs/animations/${name}.gif (${frames.length} frames)`);
}

function barChart(bars, o = {}) {
	const { baseline = 360, maxH = 200, gap = 12 } = o;
	const width = Math.min(o.width ?? 48, (W - 96 - (bars.length - 1) * gap) / bars.length);
	const startX = (W - (bars.length * width + (bars.length - 1) * gap)) / 2;
	return bars
		.map((bar, i) => {
			const [fill, stroke] = KIND[bar.kind] ?? KIND.normal;
			const dim = bar.kind === "muted";
			const x = startX + i * (width + gap);
			const h = Math.max(8, (bar.frac ?? 0.5) * maxH);
			return (
				rect(x, baseline - h, width, h, { fill, stroke, opacity: dim ? 0.3 : 1 }) +
				text(x + width / 2, baseline + 20, bar.label, { size: 12, weight: 600, fill: dim ? C.muted : C.text, opacity: dim ? 0.6 : 1 }) +
				(bar.tag ? text(x + width / 2, baseline - h - 10, bar.tag, { size: 12, weight: 600, fill: bar.tagFill ?? C.muted }) : "")
			);
		})
		.join("");
}

// ── pairwise sort ──────────────────────────────────────────────────

async function renderSort() {
	const values = [3, 7, 1, 5, 2, 8, 4, 6];
	const ids = values.map((_, i) => i);
	const max = Math.max(...values);

	const calls = [];
	const ordered = await sortWith(
		values.map((value, id) => ({ value, id })),
		async (pairs) => {
			const decisions = pairs.map(([a, b]) => values[a] > values[b]);
			calls.push({ pairs: pairs.map((p) => [...p]), decisions });
			return decisions;
		},
		{ random: () => 0 },
	);

	// Rebuild the split tree from the recorded per-level comparisons.
	const root = { ids, level: 0 };
	const byLevel = [[root]];
	let frontier = [root];
	for (const call of calls) {
		const groups = [];
		for (let k = 0; k < call.pairs.length; ) {
			const pivot = call.pairs[k][1];
			const others = [];
			const decisions = [];
			while (k < call.pairs.length && call.pairs[k][1] === pivot) {
				others.push(call.pairs[k][0]);
				decisions.push(call.decisions[k]);
				k++;
			}
			groups.push({ pivot, others, decisions });
		}
		let gi = 0;
		const next = [];
		for (const node of frontier) {
			if (node.ids.length <= 1) continue;
			const g = groups[gi++];
			node.pivot = g.pivot;
			node.high = [];
			node.low = [];
			g.others.forEach((id, j) => (g.decisions[j] ? node.high : node.low).push(id));
			node.highNode = node.high.length ? { ids: node.high, level: node.level + 1 } : null;
			node.lowNode = node.low.length ? { ids: node.low, level: node.level + 1 } : null;
			const children = [node.highNode, node.lowNode].filter(Boolean);
			(byLevel[node.level + 1] ??= []).push(...children);
			next.push(...children);
		}
		frontier = next;
	}

	const maxLevel = byLevel.length - 1;
	const inOrder = (node, depth) => {
		if (!node || node.level > depth) return node ? node.ids : [];
		if (node.pivot === undefined) return node.ids;
		return [...inOrder(node.highNode, depth), node.pivot, ...inOrder(node.lowNode, depth)];
	};
	const placedBefore = (depth) =>
		new Set(byLevel.slice(0, depth).flat().filter((n) => n.pivot !== undefined).map((n) => n.pivot));

	const barGap = 16;
	const barW = Math.min(64, (W - 96 - (ids.length - 1) * barGap) / ids.length);
	const baseX = (W - (ids.length * barW + (ids.length - 1) * barGap)) / 2;
	const baseline = 360;
	const barH = (id) => Math.max(16, (values[id] / max) * 220);
	const xOf = (order, id) => baseX + order.indexOf(id) * (barW + barGap) + barW / 2;

	function drawBars(order, roleOf, arcs = []) {
		const out = [];
		order.forEach((id, i) => {
			const [fill, stroke] = KIND[roleOf(id)] ?? KIND.normal;
			const h = barH(id);
			const x = baseX + i * (barW + barGap);
			out.push(rect(x, baseline - h, barW, h, { fill, stroke, rx: 5 }));
			out.push(text(x + barW / 2, baseline + 20, values[id], { size: 13, weight: 600 }));
		});
		for (const [a, b] of arcs) {
			out.push(line(xOf(order, a), baseline - barH(a) - 12, xOf(order, b), baseline - barH(b) - 12, { stroke: C.amber, width: 2, opacity: 0.85 }));
		}
		return out.join("");
	}

	const reqOf = (pairs) => Math.ceil(pairs.length / DEFAULT_MAX_PAIRS_PER_REQUEST);
	const totalRequests = calls.reduce((sum, call) => sum + reqOf(call.pairs), 0);

	const steps = [];
	for (let level = 0; level < calls.length; level++) {
		const reqs = reqOf(calls[level].pairs);
		const nodes = byLevel[level] ?? [];
		const pivots = new Set(nodes.filter((n) => n.pivot !== undefined).map((n) => n.pivot));
		const placed = placedBefore(level);
		const arcs = [];
		for (const node of nodes) {
			if (node.pivot === undefined) continue;
			for (const id of [...node.high, ...node.low]) arcs.push([node.pivot, id]);
		}
		steps.push({
			svg: svgFrame(
				"sort",
				`level ${level + 1}: ${calls[level].pairs.length} comparisons → ${reqs} request${reqs === 1 ? "" : "s"} (≤${DEFAULT_MAX_PAIRS_PER_REQUEST} per request)`,
				drawBars(inOrder(root, level - 1), (id) => (pivots.has(id) ? "pivot" : placed.has(id) ? "good" : "normal"), arcs) +
					legend(H - 26, [[C.accent, "pivot"], [C.amber, "compared"], [C.good, "in place"]]),
			),
			hold: 6,
		});
		const after = placedBefore(level + 1);
		steps.push({
			svg: svgFrame(
				"sort",
				"each pivot lands in its sorted slot",
				drawBars(inOrder(root, level), (id) => (after.has(id) ? "good" : "normal")),
			),
			hold: 4,
		});
	}
	steps.push({
		svg: svgFrame(
			"sort",
			`${ordered.length} items ordered in ${totalRequests} requests`,
			drawBars(inOrder(root, maxLevel), () => "good") + legend(H - 26, [[C.good, "sorted"]]),
		),
		hold: 10,
	});
	return steps;
}

// ── selectTopK ─────────────────────────────────────────────────────

async function renderTopK() {
	const values = [4, 9, 2, 7, 5, 8, 1, 6, 3];
	const k = 3;
	const max = Math.max(...values);
	const ids = values.map((_, i) => i);
	const frac = (id) => values[id] / max;

	const rounds = [];
	await selectTopKIndices(
		ids,
		k,
		async (pairs) => {
			const decisions = pairs.map(([a, b]) => values[a] > values[b]);
			rounds.push({ pairs: pairs.map((p) => [...p]), decisions });
			return decisions;
		},
		{ random: () => 0 },
	);

	let candidates = [...ids];
	let confirmed = [];
	const kinds = (mode, pivot, decisions, others) => {
		const map = new Map(ids.map((i) => [i, "muted"]));
		if (mode === "compare") {
			candidates.forEach((i) => map.set(i, "normal"));
			confirmed.forEach((i) => map.set(i, "good"));
			if (pivot !== undefined) map.set(pivot, "pivot");
			if (others) others.forEach((o, j) => map.set(o, decisions[j] ? "good" : "bad"));
		} else {
			candidates.forEach((i) => map.set(i, "candidate"));
			confirmed.forEach((i) => map.set(i, "good"));
		}
		return ids.map((i) => ({ id: i, label: values[i], frac: frac(i), kind: map.get(i) }));
	};

	const steps = [];
	for (const round of rounds) {
		const pivot = round.pairs[0][1];
		const others = round.pairs.map((p) => p[0]);
		const high = [];
		const low = [];
		round.pairs.forEach(([o], j) => (round.decisions[j] ? high : low).push(o));
		const remaining = k - confirmed.length;

		steps.push({
			svg: svgFrame(
				"selectTopK",
				`round ${steps.length / 2 + 1}: compare ${others.length} items against pivot ${values[pivot]}`,
				barChart(kinds("compare", pivot, round.decisions, others)) + legend(H - 26, [[C.accent, "pivot"], [C.good, "higher"], [C.bad, "lower"], [C.muted, "pruned"]]),
			),
			hold: 5,
		});

		if (high.length >= remaining) {
			candidates = high;
		} else {
			confirmed = [...confirmed, ...high, pivot];
			candidates = low;
		}
		steps.push({
			svg: svgFrame(
				"selectTopK",
				high.length >= remaining ? `top ${k} are inside the ${high.length} higher items — prune the rest` : `${high.length} finalists fixed — search the lower side`,
				barChart(kinds("prune")) + legend(H - 26, [[C.accentDeep, "in play"], [C.good, "locked"], [C.muted, "pruned"]]),
			),
			hold: 4,
		});
	}

	steps.push({
		svg: svgFrame(
			"selectTopK",
			`top ${k}: ${confirmed.slice(0, k).map((i) => values[i]).join(", ")} — ${rounds.length} rounds for ${ids.length} items`,
			barChart(ids.map((i) => ({ id: i, label: values[i], frac: frac(i), kind: confirmed.slice(0, k).includes(i) ? "good" : "muted", tag: confirmed.slice(0, k).includes(i) ? "top" : "", tagFill: C.good }))),
		),
		hold: 8,
	});
	return steps;
}

// ── findFirstTrue ──────────────────────────────────────────────────

async function renderBinarySearch() {
	const ages = Array.from({ length: 16 }, (_, i) => i * 2);
	const n = ages.length;
	const maxAge = ages[n - 1];
	const client = createMemoryClient(({ state }) => ({ is_true: { type: "noul", noul: state.candidate >= 20 ? 1 : 0 } }));
	const result = await findFirstTrue(client, ages, { stateOf: (age) => age, instruction: "Is the message at least 20 days old?" });

	const gap = 12;
	const width = Math.min(48, (W - 96 - (n - 1) * gap) / n);
	const startX = (W - (n * width + (n - 1) * gap)) / 2;
	const barX = (i) => startX + i * (width + gap) + width / 2;

	const steps = [];
	let low = 0;
	let high = n;
	for (const call of client.calls) {
		const mid = low + Math.floor((high - low) / 2);
		const isTrue = call.state.candidate >= 20;
		const bars = ages.map((age, i) => ({
			id: i,
			label: age,
			frac: age / maxAge,
			kind: i === mid ? "pivot" : i < low || i >= high ? "muted" : "normal",
		}));
		steps.push({
			svg: svgFrame(
				"findFirstTrue",
				`step ${steps.length + 1}: index ${mid} — window [${low}, ${high})`,
				barChart(bars) +
					line(barX(mid), 150, barX(mid), 360, { stroke: C.amber, width: 2, dash: "6 6" }) +
					legend(H - 26, [[C.accent, "asked"], [C.muted, "excluded"]]),
			),
			hold: 5,
		});
		if (isTrue) high = mid;
		else low = mid + 1;
	}
	steps.push({
		svg: svgFrame(
			"findFirstTrue",
			`boundary at index ${result.index} (age ${result.item}) — ${client.calls.length} requests for ${n} items`,
			barChart(
				ages.map((age, i) => ({
					id: i,
					label: age,
					frac: age / maxAge,
					kind: i >= result.index ? "amber" : "good",
					tag: i === result.index ? "boundary" : "",
					tagFill: C.amber,
				})),
			) + legend(H - 26, [[C.good, "false"], [C.amber, "true"]]),
		),
		hold: 8,
	});
	return steps;
}

// ── clusterByRelation ──────────────────────────────────────────────

async function renderCluster() {
	const labels = ["Ada", "Bo", "Cy", "Dee", "Eli", "Fay", "Gus", "Hana"];
	const group = [0, 0, 1, 1, 2, 2, 2, 3];
	const n = labels.length;

	const calls = [];
	await clusterWith(
		labels.map((_, i) => i),
		async (pairs) => {
			const probs = pairs.map(([a, b]) => (group[a] === group[b] ? 1 : 0));
			calls.push({ pairs: pairs.map((p) => [...p]), probs });
			return probs;
		},
		{ threshold: 0.5 },
	);

	const edges = calls[0].pairs.map(([a, b], i) => ({ a, b, same: calls[0].probs[i] >= 0.5 }));
	const pos = labels.map((_, i) => ({
		x: 130 + (i % 4) * 165,
		y: i < 4 ? 180 : 300,
	}));
	const palette = ["#6b76e0", "#4ade80", "#fbbf24", "#f87171"];

	function draw(revealed, finals) {
		const uf = new UnionFind(labels.map((_, i) => i));
		edges.slice(0, revealed).forEach((e) => e.same && uf.union(e.a, e.b));
		const color = new Map();
		uf.groups().forEach((members, i) => members.forEach((m) => color.set(m, palette[i % palette.length])));

		const out = [];
		edges.slice(0, revealed).forEach((e) => {
			if (e.same) out.push(line(pos[e.a].x, pos[e.a].y, pos[e.b].x, pos[e.b].y, { stroke: C.line, width: 4, opacity: 0.8 }));
		});
		if (revealed < edges.length) {
			const e = edges[revealed];
			out.push(line(pos[e.a].x, pos[e.a].y, pos[e.b].x, pos[e.b].y, { stroke: C.amber, width: 2.5, dash: "7 6" }));
		}
		labels.forEach((label, i) => {
			const fill = finals ? color.get(i) : C.surface;
			out.push(`<circle cx="${pos[i].x}" cy="${pos[i].y}" r="27" fill="${fill}" stroke="${finals ? fill : C.line}" stroke-width="2"/>`);
			out.push(text(pos[i].x, pos[i].y + 5, label, { size: 14, weight: 600, fill: finals ? C.bg : C.text }));
		});
		return out.join("");
	}

	const reqs = Math.ceil(edges.length / DEFAULT_MAX_CLUSTER_PAIRS_PER_REQUEST);
	const steps = [];
	const stride = Math.ceil(edges.length / 12);
	for (let i = 0; i <= edges.length; i += stride) {
		const e = edges[Math.min(i, edges.length - 1)];
		steps.push({
			svg: svgFrame(
				"clusterByRelation",
				`${edges.length} pairs → ${reqs} request${reqs === 1 ? "" : "s"} (≤${DEFAULT_MAX_CLUSTER_PAIRS_PER_REQUEST} per request) — compare ${labels[e.a]} vs ${labels[e.b]}`,
				draw(i, false),
			),
			hold: 3,
		});
	}
	const clusters = await clusterWith(
		labels.map((_, i) => i),
		async (pairs) => pairs.map(([a, b]) => (group[a] === group[b] ? 1 : 0)),
		{ threshold: 0.5 },
	);
	steps.push({
		svg: svgFrame(
			"clusterByRelation",
			`${clusters.length} clusters from ${edges.length} comparisons in ${reqs} request${reqs === 1 ? "" : "s"}`,
			draw(edges.length, true),
		),
		hold: 8,
	});
	return steps;
}

// ── main ───────────────────────────────────────────────────────────

const animations = [
	["sort-by-pairwise", renderSort],
	["select-top-k", renderTopK],
	["find-first-true", renderBinarySearch],
	["cluster-by-relation", renderCluster],
];

for (const [name, render] of animations) {
	console.log(`rendering ${name}...`);
	toGif(name, await render());
}
console.log("done");
