// Run after pnpm build; reads TYPESAFE_API_KEY from the environment.
// Supply .go/.js paths, or omit paths for the Go interface-dispatch example.
import { readFileSync } from "node:fs";
import Parser from "tree-sitter";
import Go from "tree-sitter-go";
import JavaScript from "tree-sitter-javascript";
import { buildProgramGraphs, createTypeSafeClient } from "../dist/index.js";

if (!process.env.TYPESAFE_API_KEY) throw new Error("Set TYPESAFE_API_KEY via your environment or dotenvx");
const demo = `package payments
type Charger interface { Charge(int) int }
type Card struct{}
type Cash struct{}
func (c Card) Charge(n int) int { return n }
func (c Cash) Charge(n int) int { return n }
func Checkout(c Charger, amounts []int) int {
 total := 0
 for _, n := range amounts {
  if n <= 0 { continue }
  total += c.Charge(n)
 }
 return total
}
func Example() int { return Checkout(Card{}, []int{10, 20}) }
`;
const paths = process.argv.slice(2);
const files = (paths.length ? paths : ["demo.go"]).map(path => {
	const language = path.endsWith(".go") ? "go" : /\.(?:[cm]?js)$/.test(path) ? "javascript" : null;
	if (!language) throw new Error(`Expected a .go or .js/.mjs/.cjs file: ${path}`);
	const text = paths.length ? readFileSync(path, "utf8") : demo;
	const parser = new Parser();
	parser.setLanguage(language === "go" ? Go : JavaScript);
	return { path, language, rootNode: parser.parse(text).rootNode };
});
const client = createTypeSafeClient({ apiKey: process.env.TYPESAFE_API_KEY, model: process.env.TYPESAFE_MODEL });
const started = performance.now();
let requests = 0;
const result = await buildProgramGraphs({ evaluate(input) { requests++; return client.evaluate(input); } }, files);
console.log(JSON.stringify({ model: process.env.TYPESAFE_MODEL ?? "jev-latest", requests, elapsedMs: Math.round(performance.now() - started), ...result }, null, 2));
