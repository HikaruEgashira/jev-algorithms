import assert from "node:assert/strict";
import test from "node:test";
import Parser from "tree-sitter";
import Go from "tree-sitter-go";
import JavaScript from "tree-sitter-javascript";
import { buildProgramGraphs, createMemoryClient } from "../dist/index.js";

const source = (text, language = "go", path = language === "go" ? "main.go" : "main.js") => ({
	path, language, rootNode: new Parser().setLanguage(language === "go" ? Go : JavaScript).parse(text).rootNode,
});
const oracle = (score = () => 0) => createMemoryClient(({ state, questions }) => Object.fromEntries(
	Object.entries(questions).map(([id, q]) => {
		const [, call, target] = q.instructions.match(/calls\[(\d+)\].*functions\[(\d+)\]/);
		return [id, { noul: score(state.calls[call], state.functions[target], state) }];
	}),
));
const cfg = (result, name) => result.controlFlowGraphs.find(graph => graph.function === result.functions.find(fn => fn.name === name).id);
const links = (graph) => {
	const nodes = new Map(graph.nodes.map(node => [node.id, node.text]));
	assert.equal(nodes.size, graph.nodes.length, "node ids must be unique");
	return graph.edges.map(edge => {
		assert.ok(nodes.has(edge.from) && nodes.has(edge.to), "edge endpoints must exist");
		return [nodes.get(edge.from), edge.kind, nodes.get(edge.to)];
	});
};
const link = (graph, from, kind, to) => assert.ok(links(graph).some(row => row[0] === from && row[1] === kind && row[2] === to), JSON.stringify([from, kind, to]));

test("Go CFG preserves initialization, loop update, nested branches, and early return", async () => {
	const file = source(`package main
func run(x int) int {
 if y := x; y > 0 { x-- } else { x++ }
 for i := 0; i < x; i++ {
  if i == 1 { continue }
  if i == 2 { break }
  x--
 }
 return x
 x++
}`);
	const client = oracle();
	const result = await buildProgramGraphs(client, [file]);
	const graph = cfg(result, "run");
	assert.deepEqual(graph.diagnostics, []);
	assert.equal(client.calls.length, 0);
	link(graph, "entry", "next", "y := x");
	link(graph, "y := x", "next", "y > 0");
	link(graph, "y > 0", "true", "x--");
	link(graph, "y > 0", "false", "x++");
	link(graph, "x++", "next", "i := 0");
	link(graph, "i := 0", "next", "i < x");
	link(graph, "i < x", "true", "i == 1");
	link(graph, "i < x", "false", "return x");
	link(graph, "continue", "continue", "i++");
	link(graph, "i++", "next", "i < x");
	link(graph, "break", "break", "return x");
	link(graph, "return x", "return", "exit");
	const ret = graph.nodes.find(node => node.text === "return x");
	assert.equal(graph.edges.filter(edge => edge.from === ret.id).length, 1);
	assert.deepEqual(links(cfg(result, "<module>")), [["entry", "next", "exit"]]);
});

test("Go range, condition-only and infinite loops route continue and nested break correctly", async () => {
	const result = await buildProgramGraphs(oracle(), [source(`package main
func run(xs []int) {
 for _, v := range xs { if v == 0 { continue }; use(v) }
 for ready() { tick() }
 for { for { break }; continue }
 after()
}`)]);
	const graph = cfg(result, "run");
	link(graph, "entry", "next", "xs");
	link(graph, "xs", "next", "_, v := range xs");
	link(graph, "_, v := range xs", "true", "v == 0");
	link(graph, "_, v := range xs", "false", "ready()");
	link(graph, "continue", "continue", "_, v := range xs");
	link(graph, "ready()", "true", "tick()");
	link(graph, "tick()", "next", "ready()");
	link(graph, "break", "break", "continue");
	assert.equal(graph.edges.filter(edge => edge.kind === "false").length, 3);
	assert.equal(graph.edges.filter(edge => edge.to === graph.nodes.find(node => node.text === "after()").id).length, 0);
});

test("JavaScript CFG models do/while, for, if/else, throws, and arrow returns", async () => {
	const result = await buildProgramGraphs(oracle(), [source(`
export function run(x) {
 for (let i = 0; i < x; i++) { if (i) continue; else x--; }
 do { x++; if (x > 3) break; continue; } while (x < 2);
 while (x) { x--; }
 if (x < 0) throw Error('bad');
 return x;
}
const twice = x => x * 2;
function forever() { for (;;) {} }
function assigned() { for (i = 0; i < 1; i++) {} }
`, "javascript")]);
	const graph = cfg(result, "run");
	assert.deepEqual(graph.diagnostics, []);
	link(graph, "entry", "next", "let i = 0;");
	link(graph, "continue;", "continue", "i++");
	link(graph, "i++", "next", "i < x");
	link(graph, "(i)", "false", "x--;");
	link(graph, "i < x", "false", "x++;");
	link(graph, "continue;", "continue", "(x < 2)");
	link(graph, "(x < 2)", "true", "x++;");
	link(graph, "break;", "break", "(x)");
	link(graph, "throw Error('bad');", "throw", "exit");
	assert.deepEqual(links(cfg(result, "twice")), [["entry", "next", "x * 2"], ["x * 2", "return", "exit"]]);
	assert.equal(cfg(result, "forever").edges.filter(edge => edge.kind === "false").length, 0);
	link(cfg(result, "assigned"), "i = 0", "next", "i < 1");
});

test("unsupported control flow is explicit and cannot leak into a seemingly valid CFG", async () => {
	const files = [source(`package main
func later() { defer cleanup(); return }
func branch() { switch x { case 1: return } }
func jump() { goto done; done: return }
func selectOne() { select {} }
func external()
func outer() { f := func() { defer cleanup() }; f() }
`), source(`function attempt() { try { a() } finally { b() } }
async function wait() { await a() }
function* generator() { yield 1 }
function labeled() { loop: while (true) { break loop; } }
function forOf() { for (const x of xs) {} }
export default 42;`, "javascript")];
	const result = await buildProgramGraphs(oracle(), files);
	for (const name of ["later", "branch", "jump", "selectOne", "external", "attempt", "wait", "generator", "labeled", "forOf"]) {
		const graph = cfg(result, name);
		assert.ok(graph.diagnostics.length > 0, name);
		assert.equal(graph.entry, null);
		assert.equal(graph.exit, null);
		assert.deepEqual(graph.nodes, []);
		assert.deepEqual(graph.edges, []);
	}
	assert.deepEqual(cfg(result, "outer").diagnostics, []);
	assert.ok(result.callGraph.calls.some(call => call.kind === "defer"));
});

test("Jev call candidates are batched, multilingual, multi-target, and thresholded without losing uncertainty", async () => {
	const files = [source(`package main
func one() {}
func two() {}
func run(f func()) { f(); one(); external(); go one(two()) }
`), source("function one() {} const f = () => one(); new one();", "javascript")];
	const client = oracle((call, fn) => {
		if (call.callee === "f" && ["one", "two"].includes(fn.name)) return 0.8;
		return call.callee === fn.name ? 1 : 0.2;
	});
	const result = await buildProgramGraphs(client, files, { maxPairsPerRequest: 2 });
	const { calls, candidates, edges, unresolved } = result.callGraph;
	const goCall = calls.find(call => call.kind === "go");
	assert.equal(goCall.callee, "one");
	assert.equal(calls.find(call => call.callee === "two").kind, "call");
	assert.ok(calls.some(call => call.kind === "construct"));
	const dynamic = calls.find(call => call.callee === "f");
	assert.equal(edges.filter(edge => edge.call === dynamic.id).length, 2);
	assert.equal(candidates.length, 19);
	assert.equal(client.calls.length, 10);
	assert.deepEqual(client.calls.map(call => Object.keys(call.questions).length), [2, 2, 2, 2, 2, 2, 2, 2, 2, 1]);
	assert.equal(client.calls[0].state.calls.length, 1);
	assert.equal(client.calls[0].state.functions.length, 2);
	assert.equal(unresolved.length, 1);
	assert.equal(calls.find(call => call.id === unresolved[0]).callee, "external");
	const functions = new Map(result.functions.map(fn => [fn.id, fn]));
	for (const candidate of candidates) {
		assert.equal(functions.get(candidate.from).language, functions.get(candidate.to).language);
		assert.equal(functions.get(candidate.to).kind, "function");
	}
	const arrowCall = calls.find(call => call.file === "main.js" && call.callee === "one" && call.kind === "call");
	assert.equal(functions.get(arrowCall.caller).name, "f");
	assert.deepEqual(client.calls[0].state.sources.map(file => file.text), files.map(file => file.rootNode.text));
	assert.equal(client.calls[0].state.functions.find(fn => fn.name === "one").source, "func one() {}");
	const repeat = await buildProgramGraphs(oracle(), files);
	assert.deepEqual(repeat.functions, result.functions);
	assert.deepEqual(repeat.controlFlowGraphs, result.controlFlowGraphs);
});

test("cross-file Go methods and nested functions have distinct identities and call ownership", async () => {
	const result = await buildProgramGraphs(oracle(() => 1), [
		source("package p\ntype A struct{}\nfunc (a A) Run() { a.Run() }\nfunc outer() { f := func() { inner() }; go f() }", "go", "a.go"),
		source("package p\ntype B struct{}\nfunc (b B) Run() {}", "go", "b.go"),
	]);
	assert.equal(new Set(result.functions.map(fn => fn.id)).size, result.functions.length);
	assert.equal(result.functions.filter(fn => fn.name === "Run").length, 2);
	const call = result.callGraph.calls.find(call => call.callee === "inner");
	assert.equal(result.functions.find(fn => fn.id === call.caller).name, "<anonymous>");
	assert.equal(result.callGraph.edges.filter(edge => edge.call === call.id).length, 4);
});

test("empty candidate sets preserve unresolved calls without calling Jev", async () => {
	const client = oracle();
	assert.deepEqual(await buildProgramGraphs(client, []), { functions: [], callGraph: { calls: [], candidates: [], edges: [], unresolved: [] }, controlFlowGraphs: [] });
	const result = await buildProgramGraphs(client, [source("external();", "javascript")]);
	assert.deepEqual(result.callGraph.unresolved, result.callGraph.calls.map(call => call.id));
	assert.equal(client.calls.length, 0);
});

test("default batching stays within 40 questions and snapshots trees before awaiting Jev", async () => {
	const file = source(`package p\nfunc f() { ${"f();".repeat(41)} }`);
	const client = oracle(() => {
		file.rootNode = null;
		return 0.9;
	});
	const result = await buildProgramGraphs(client, [file]);
	assert.deepEqual(client.calls.map(call => Object.keys(call.questions).length), [40, 1]);
	assert.equal(result.callGraph.edges.length, 41);
	assert.equal(result.controlFlowGraphs.length, 2);
});

test("input validation and budgets fail before any remote evaluation", async () => {
	const client = oracle();
	const file = source("package p\nfunc f(){ f() }");
	for (const options of [
		{ threshold: -0.1 }, { threshold: 1.1 }, { threshold: NaN },
		{ maxPairsPerRequest: 0 }, { maxPairsPerRequest: 41 }, { maxPairsPerRequest: 1.5 },
		{ maxComparisons: 0 }, { maxComparisons: Infinity }, { maxSourceChars: -1 },
		{ maxSourceChars: 1 },
	]) await assert.rejects(buildProgramGraphs(client, [file], options));
	await assert.rejects(buildProgramGraphs(client, [file, file]), /unique/);
	await assert.rejects(buildProgramGraphs(client, [{ ...file, path: "" }]), /nonempty/);
	await assert.rejects(buildProgramGraphs(client, [{ ...file, language: "python" }]), /Unsupported/);
	await assert.rejects(buildProgramGraphs(client, [{ ...file, language: "javascript" }]), /Unsupported/);
	await assert.rejects(buildProgramGraphs(client, [source("package p\nfunc {")]), /Syntax error/);
	await assert.rejects(buildProgramGraphs(client, [source("package p\nfunc f(){f(); f()}")], { maxComparisons: 1 }), /maxComparisons/);
	assert.equal(client.calls.length, 0);
	const exact = await buildProgramGraphs(oracle(() => 1), [file], { threshold: 1, maxComparisons: 1, maxSourceChars: file.rootNode.text.length });
	assert.equal(exact.callGraph.edges.length, 1);
	assert.equal((await buildProgramGraphs(oracle(() => 0), [file], { threshold: 0 })).callGraph.edges.length, 1);
});

test("invalid or missing Jev answers and API failures never fabricate edges", async () => {
	const files = [source("package p\nfunc f(){ f() }")];
	for (const answer of [undefined, { choice: "f" }, { noul: NaN }, { noul: Infinity }, { noul: -0.1 }, { noul: 1.1 }, { noul: "1" }]) {
		await assert.rejects(buildProgramGraphs(createMemoryClient(() => ({ p0: answer })), files), /Invalid Jev/);
	}
	await assert.rejects(buildProgramGraphs(createMemoryClient(() => { throw new Error("offline"); }), files), /offline/);
});
