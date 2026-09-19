# jev-algorithms

## Gallery

![sortByPairwise](https://cdn.jsdelivr.net/npm/@hikae/jev-algorithms@0.1.0/docs/animations/sort-by-pairwise.gif)
![selectTopK](https://cdn.jsdelivr.net/npm/@hikae/jev-algorithms@0.1.0/docs/animations/select-top-k.gif)
![findFirstTrue](https://cdn.jsdelivr.net/npm/@hikae/jev-algorithms@0.1.0/docs/animations/find-first-true.gif)
![clusterByRelation](https://cdn.jsdelivr.net/npm/@hikae/jev-algorithms@0.1.0/docs/animations/cluster-by-relation.gif)

## Install

```sh
npm install @hikae/jev-algorithms
```

## Quick start

```ts
import { createTypeSafeClient, sortByPairwise } from "@hikae/jev-algorithms";

const jev = createTypeSafeClient({ apiKey: process.env.TYPESAFE_API_KEY! });

const inbox = [
  { id: "1", from: "ceo@acme.com", subject: "Contract", unread: true, body: "Please sign by Friday." },
  { id: "2", from: "news@acme.com", subject: "Weekly digest", unread: false, body: "This week in..." },
];

const ordered = await sortByPairwise(jev, inbox, {
  task: "for replying first",
  stateOf: (mail) => ({
    from: mail.from,
    subject: mail.subject,
    unread: mail.unread,
    preview: mail.body.slice(0, 300),
  }),
});
// [Contract mail, Weekly digest]
```

## The client contract

```ts
interface JevClient {
  evaluate(input: { state: JevState; questions: JevQuestions }): Promise<JevAnswers>;
}
```

| Adapter | Factory | Notes |
| --- | --- | --- |
| TypeSafe API | `createTypeSafeClient({ apiKey, model?, baseUrl?, fetch? })` | Runtime-agnostic default. Keep the key on the server. |
| Workers AI | `createWorkersAiClient(binding, model?)` | Pass `env.AI`. Structural, no Cloudflare types required. |
| In memory | `createMemoryClient(responder)` | Test double; records every `calls` evaluation. |

Question builders (`noul`, `choice`, `score`) and answer readers
(`readNoul`, `readChoice`, `readScore`) are exported for building your own
algorithms on the same contract.

## Algorithms

Every algorithm states its request cost in terms of `n` items. A request
carries up to 40 questions, so "one request" is rarely one comparison.

### Sorting and selection

| Function | What it does | Requests |
| --- | --- | --- |
| `sortByPairwise(client, items, options)` | Total order from pairwise "which ranks higher?" answers | `O((n/40) log n)` |
| `sortByPairwiseWith(items, compare)` | Same, with an injected comparator (no client) | `O((n/40) log n)` |
| `selectTopK(client, items, k, options)` | Top-k, ordered, via quickselect | `O(n/40 + (k/40) log k)` |
| `selectTopKWith(items, k, compare)` | Same, with an injected comparator | `O(n/40 + (k/40) log k)` |
| `createPairComparator(client, items, options)` | Build the comparator to plug Jev into any sort you own | — |

The sort is randomized quicksort whose recursion runs level by level. Nodes on
a level are disjoint, so a level's comparisons are batched into `⌈n/40⌉`
requests at `DEFAULT_MAX_PAIRS_PER_REQUEST` pairs each. The whole order costs
`O((n/40) log n)` requests instead of `n log n` individual comparisons.
`selectTopK` skips the side that cannot contain the k-th item.

### Threshold search

```ts
const cutoff = await findFirstTrue(jev, emailsByRecency, {
  stateOf: (mail) => ({ ageDays: mail.ageDays }),
  instruction: "Is `candidate` older than 30 days?",
});
```

`findFirstTrue` binary-searches a monotone predicate in `O(log n)` calls.

### Ranking from noisy comparisons

Pairwise answers can cycle (A > B > C > A). `elo` and `bradleyTerry` turn a
list of `Comparison`s into one score per id; `rankByElo` and
`rankByBradleyTerry` order them. `winner` is `"first" | "second" | "draw"`,
named by position so a player called `"a"` or `"b"` is never ambiguous.

### Clustering

```ts
const groups = await clusterByRelation(jev, tickets, {
  relation: "duplicate support ticket",
  stateOf: (t) => ({ subject: t.subject, body: t.body.slice(0, 300) }),
});
```

Union-find over pairwise equivalence. Every unordered pair is compared once;
`threshold` controls how confident Jev must be to merge, and `maxComparisons`
caps sampling for large inputs.

### Classification and scoring

- `classifyChoice(client, state, { instruction, labels, abstainBelow })` —
  Choice with an abstain band, so uncertain cases can be escalated instead of
  guessed.
- `booleanDecision(client, state, { instruction, threshold })` — Noul plus a
  thresholded verdict.
- `rubricScore(client, state, { instruction, levels })` — Score normalized to
  `0..1`, with the nearest level label.

### Matching

`stableMatching(proposers, receivers, proposerPrefs, receiverPrefs)` is a pure
Gale-Shapley implementation. `buildPreferences(client, choosers, candidates, options)`
builds each side's preference order with pairwise comparisons first.

### Call graphs and control flow graphs (Go / JavaScript)

`buildProgramGraphs(client, files, options?)` consumes actual tree-sitter roots.
It constructs statement-level CFGs from syntax and asks Jev which declared
functions each explicit call might invoke. The package stays runtime-agnostic:
install the parser and grammars in the application that owns parsing.

```sh
npm install tree-sitter tree-sitter-go
```

```ts
import Parser from "tree-sitter";
import Go from "tree-sitter-go";
import { buildProgramGraphs, createTypeSafeClient } from "@hikae/jev-algorithms";

const parser = new Parser();
parser.setLanguage(Go);
const tree = parser.parse(`package main
func double(n int) int { return n * 2 }
func run(n int) int {
  if n <= 0 { return 0 }
  return double(n)
}`);
const graphs = await buildProgramGraphs(
  createTypeSafeClient({ apiKey: process.env.TYPESAFE_API_KEY! }),
  [{ path: "main.go", language: "go", rootNode: tree.rootNode }],
);
console.log(graphs.callGraph.edges, graphs.controlFlowGraphs);
```

Pass `tree-sitter-javascript` roots with `language: "javascript"` for JavaScript.
Multiple files and both languages can share one analysis; candidate edges never
cross languages. Files are supplied explicitly; imports are not loaded from disk.

1. Index functions, methods, closures, and explicit call sites with file/offset
   identities. Nested functions own their calls; each file has a module node.
2. Build each CFG backwards from its exit, threading the next statement and the
   enclosing loop's break/continue targets. `if`, Go's three `for` forms,
   JavaScript `for`/`while`/`do`, early return, and explicit JS throw are supported.
3. Enumerate call/function pairs within each language. Batch independent Noul
   questions, retaining every probability in `callGraph.candidates` and those at
   or above `threshold` (default `0.8`) in `callGraph.edges`. Multiple targets are
   allowed, including interface dispatch. Calls without an accepted target remain
   in `unresolved`; this also includes calls to external functions.

These call edges are **model hypotheses, not a sound static analysis**. An empty
`unresolved` list does not prove completeness. Scope, aliases, receivers, imports,
and dynamic dispatch are assessed by Jev from the supplied source, without a type
checker, treating each function as a possible entry point with type-compatible
arguments. Reflection, implicit callbacks, property accessors, runtime registration,
and dependencies outside the supplied files may be missing. Noul probability is
belief in a target, not its execution frequency. CFG edges never depend on Jev.

CFGs describe intraprocedural normal flow with atomic expressions, including
short-circuit and conditional expressions; they do not expand expression-level
branches, parameter initializers, implicit exceptions/panics, or non-returning
callees. A Go `go` statement continues in the caller; its call is marked `go`.
Scheduling and synchronization are not modeled. `defer`, `switch`, `select`,
`goto`, labeled jumps, JS `try`/`finally`, `for…in/of`, classes at module scope,
and `await`/`yield` produce a diagnostic and an empty CFG for the affected body.
Other functions and explicit call sites (including `defer`) remain available.
Invalid syntax aborts analysis before any request.

For `C` calls, `F` functions, and `B = maxPairsPerRequest` (default/maximum 40),
candidate evaluation costs at most `C × F` questions and `ceil(C × F / B)`
requests. Source context is repeated per request. `maxComparisons` (default 2000)
and `maxSourceChars` (default 60000) reject oversized inputs before any request;
no sampling or truncation hides lost candidates. Large repositories need symbol
and type-based candidate filtering before this prototype is suitable. Missing or
invalid probabilities abort rather than inventing edges.

The supplied source is sent to the configured Jev provider. From this checkout,
run the Go interface-dispatch example or analyze your own files:

```sh
pnpm build
dotenvx run -- node scripts/experiment-program-graphs.mjs
dotenvx run -- node scripts/experiment-program-graphs.mjs main.go helpers.go
```

The implementation follows the official [tree-sitter node API](https://github.com/tree-sitter/node-tree-sitter),
[Go grammar](https://github.com/tree-sitter/tree-sitter-go),
[JavaScript grammar](https://github.com/tree-sitter/tree-sitter-javascript), and
[TypeSafe Noul contract](https://docs.typesafe.ai/primitives).

Live smoke check (2026-09-19, `jev-latest`, the bundled Go example): one request
evaluated eight pairs in 1274 ms. `Example -> Checkout` scored `0.93`; the two
interface targets scored `0.66` and `0.62`, so both stayed below the default
threshold and the call remained unresolved. This verifies API integration and
abstention, not analysis accuracy; calibrate thresholds on labeled examples.

## Design notes

- **Batch by default.** Every algorithm packs up to 40 questions into one
  `evaluate` call and references items through a chunk-local index so a shared
  item travels once.
- **Fail loud, not wrong.** If Jev omits an answer, algorithms throw. They
  never persist a fabricated order. The one exception is up to the caller:
  `classifyChoice` can abstain by design.
- **Persistence is yours.** Algorithms return orders and scores; storing them
  (for example, an integer priority column) is a schema decision, not a library
  one.

## Testing and mutation testing

```sh
npm test        # build + node:test
npm run typecheck
npm run mutation # build + Stryker
```

Tests are judged by mutation coverage, not line coverage: a test only earns its
place if it kills a mutant. Stryker runs with the `command` test runner against
the built `dist` and a break threshold of 80; the latest full local run scored 87.76%.

Two policies keep the signal honest and the suite lean:

- `StringLiteral` mutants are excluded. Prompts and error wording are content,
  not logic; asserting exact prompt text would make the suite brittle without
  catching real bugs.
- Survivors include equivalent mutations in union-find and pivot selection, as
  well as coverage gaps in diagnostics and less common syntax paths. Inspect
  `reports/mutation.json`; a passing threshold does not mean every survivor is
  equivalent or that Jev's predictions are accurate.

## License

MIT
