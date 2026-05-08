# V3+ candidates — friction worth redesigning

A running list of things that hurt while authoring or running Archie workflows on the current Archon runtime. The shape of each entry is: **what the friction is**, **why it exists**, **what the right primitive would look like**, and (where useful) **a concrete example**. Append-only — populate as you hit pain.

This doc is for v3 / v4 / whenever you decide to rewrite the bones. v2 keeps the architecture; this is the parking lot for "things I'd do differently if I were optimizing for exactly what Archie needs."

---

## Design lens 0: one primitive — the node — and "workflow" is just a recipe

Today Archon has a sprawl of related-but-not-identical primitives:

- DAG workflows
- Loop nodes (special: break out of DAG)
- Approval nodes (special: pause for human)
- Cancel nodes (special: terminate workflow)
- Bash / prompt / command / script nodes (overlapping shapes, different schemas)
- Commands as standalone callable units (markdown + frontmatter, callable from workflows)
- Workflows that can call commands but cannot call other workflows

Each carve-out has a reason it was added but the cumulative complexity is real. There are a lot of "this kind of node can't do this thing" rules. The composition rules between primitives are partial: workflows call commands, but commands don't call workflows; loops can't have tool hooks; approvals can't be inside a parallel block; etc.

The reduction: **there is one primitive — the node.** A workflow isn't a primitive; it's a named recipe of nodes wired together. Saying "this is the recipe I want to use in this situation" doesn't introduce a new kind of thing — it's just notation for a reusable subgraph.

The engine cares about exactly one concept: **a node executes, with typed inputs and typed outputs, using some implementation (bash / AI / script / HTTP / wait-for-event / sub-recipe / ...).** Everything composes from that. A "workflow" is the file or block where a recipe is named for reuse; the engine processes the expanded graph at run time and the name is essentially metadata.

Everything currently a primitive becomes either a node implementation or a recipe:

| Today | In v3+ |
|---|---|
| Bash node | Node, implementation = bash |
| Prompt node | Node, implementation = ai-prompt |
| Command (the markdown file thing) | Recipe of one node, implementation = ai-prompt |
| Script node | Node, implementation = script-bun / script-uv |
| Loop node (current "iterate AI until signal") | A node with iteration semantics in its run config, OR a recipe that calls itself |
| Approval node | Node, implementation = wait-for-event (event being a human action) |
| Cancel node | Node that returns a "terminate" error of a known shape; the recipe handler interprets it |
| Workflow | Recipe of nodes — same shape whether it has 1 node or 50 |

And recipes call recipes the same way they call any other node. From the calling recipe's point of view, "run the task-implement recipe" is just a node — declare inputs, declare outputs, the engine handles it. There's no special "sub-workflow" concept; it's just a node whose implementation expands to other nodes.

What this kills, in one move:

- "Loop nodes can't have tool hooks" — there's no special loop node; every node has the same hook surface.
- "Commands can be invoked from workflows but workflows can't be invoked from workflows" — the asymmetry disappears; both are recipes, and both are callable as nodes.
- "Different node types have different schemas" — one node schema.
- "The `loop:` primitive doesn't fit my iteration shape" — iteration is a property of a node's run config (or a self-calling recipe), not a hardcoded primitive.
- "Workflows have a lifecycle separate from node execution" — they don't; a "workflow run" is just the coordinated execution of the nodes in the recipe.

What this needs to get right:

- **Implementation registry.** The engine has a registry of "how to run a node": bash, ai-prompt, ai-command, script-bun, script-uv, http, wait-for-event, recipe (i.e. expand and run another named recipe). Adding a new one (e.g. `mcp-tool-call`) is a registration, not a schema change.
- **Calling-a-recipe-as-a-node.** Same node schema as anything else; the implementation field points at a named recipe; the engine expands and runs it, rolls up cost / events back to the calling node.
- **Composition rules collapse.** A node has typed I/O. Recipes are graphs of nodes. That's the entire surface.
- **Naming.** "Workflow" might not stay the right word once recipes are this lightweight. Possibly "recipe," "procedure," "task," or just nothing — a file with a list of nodes might not need its own concept name. Don't bikeshed during the rewrite; the right word will suggest itself.

Why this isn't trivial to retrofit:

- Today's loop node has implementation magic (the `until:` evaluator, the iteration accounting) that can't just become a generic "node with repeat semantics" without engine work. Same for approval (event waiting) and cancel (workflow termination).
- The `command:` markdown-file format has a lot of authored content (frontmatter description, argument-hint, AI prompt body). Migrating those to "a recipe of one node" is mechanical but touches every command file.
- Recipes-calling-recipes means the engine needs to handle nested run state. Resume, cost rollup, observability all need to work across the boundary — but because the calling site is "just a node," the engine code path stays uniform; it's the implementation of the recipe-call that does the expansion.

This is the most aggressive of the lenses; it's also the most clarifying. If you make this call, almost every other lens (sugar over DAG, typed I/O, etc) follows naturally because there are fewer special cases for them to negotiate with.

---

## Design lens 1: surface sugar over a DAG core

A recurring tension is that Archon enforces strict DAG purity at the YAML level — every node is independently visible to the engine, dependencies are explicit, no implicit iteration. That's correct as an _execution_ model: it's what gives us per-node observability, resumability, `when:`-pruning, early-convergence skipping, and per-node cost accounting. It's the right shape for the engine to consume.

It's the wrong shape for **authoring**. A workflow author wants to express "we go back and forth between these three nodes up to 5 times until both gates pass" as one declarative unit. Today they have to hand-unroll that into 10–15 nodes wired with conditional `when:` clauses, and a sixth attempt is a YAML edit in many places.

The fix is sugar, not a new execution model:

- **Author** writes a higher-level construct (loop, parallel-with-rendezvous, retry-with-backoff, fan-out / fan-in over a list, etc).
- **Engine** unrolls / desugars it into the same strict DAG it already executes.
- **Runtime observability** still shows the unrolled nodes — `dev-loop.attempt-1.review`, `dev-loop.attempt-2.validate`, etc — so debugging, resume, cost-per-attempt, and skipped-on-early-convergence all work identically to today.
- **The author never sees the unrolled form** unless they want to (a `archon workflow show --expanded my-workflow.yaml` command would render the desugared DAG for inspection).

The DAG-purity property the engine cares about (every executable unit is a node with declared dependencies and observable state) is preserved. The DAG-purity tax the author pays (writing every node by hand) is gone.

---

## Design lens 2: one node type, with a clean input/output contract

Today, Archon has many node types (`command:`, `prompt:`, `bash:`, `script:`, `loop:`, `approval:`, `cancel:`) and each has its own schema fields, its own substitution rules, its own way of producing output. To pass data downstream, a `bash:` node has to print JSON to stdout; a `command:` node has to coerce its AI output through `output_format`; a `script:` node uses stdout. The author has to remember which type takes which fields, which fields produce structured output, how `$node.output.field` resolves for each.

The simplification: **there is one node**. Every node is a function: `(typed inputs) → (typed outputs)`. What's inside the node — bash, TypeScript, AI prompt, HTTP call, anything — is an implementation detail. The author treats nodes as interchangeable building blocks.

```yaml
- id: validate
  inputs:
    feedback_path: $test-N.output.report_path     # typed: string
    contract: $contract.output                    # typed: object
  outputs:
    passed: boolean
    failure_categories: string[]
  run:
    bash: |
      bash /home/user/Archon/.archon/scripts/task-run-validation.sh
    # or:
    # ai: { command: archon-review-dev-attempt }
    # or:
    # script: { runtime: bun, code: "..." }
    # or:
    # http: { method: POST, url: "..." }
```

**What the engine does with this:**

- Validates inputs against declared types at run time, rejects with a clear error before the node body executes.
- Runs the body via whatever implementation it uses (bash / AI / script / HTTP / etc).
- Validates outputs against the declared schema before publishing them. A bash node that prints garbage gets caught here, not three nodes downstream.
- Substitution into the body uses typed access — booleans don't get shell-quoted, strings don't get double-wrapped, missing fields produce an explicit error rather than silently empty.

**Why this matters for Archie specifically:**

- The duplicate-quoting bug from WOR-87 (`failure_scope = "'tests'"` vs `tests`) was structurally a type-system failure: an opaque string flowed from a JS classifier through engine substitution into a bash comparison and got mangled along the way. With typed I/O the engine knows the value is a string-enum and inserts it appropriately for the consumer (no shell-quoting when reading into a JS context, proper escaping when reading into bash).
- The `set -u` interaction with skipped-node references was structurally the same problem: the engine substituted `$validate-4.output.passed` into bash where the node was skipped, leaving a literal that bash then errored on. With typed I/O the consumer node declares it _expects_ a boolean from validate-4; if validate-4 was skipped, the engine has a clear policy ("missing → null" or "missing → error") and applies it before bash sees anything.
- Reviewer hallucinations where the JSON body doesn't match the declared shape currently fail late (at the next bash node that tries to read a missing field). With output validation, they'd fail at the reviewer node itself.

**What the author writes:**

```yaml
- id: classify-failure
  inputs:
    review: $dev-review-final.output    # typed: { passed: boolean, required_repairs: Repair[] }
  outputs:
    failure_scope: enum[none, production, tests, mixed]
    repair_count: integer
  run:
    script:
      runtime: bun
      code: |
        const review = process.env.INPUT_REVIEW_JSON;  // engine sets this
        // ... classify ...
        console.log(JSON.stringify({ failure_scope, repair_count }));
```

The `inputs:` and `outputs:` are declared once. The body reads from `process.env.INPUT_*` (or whatever the convention is) and writes to stdout in the declared shape. The engine does the rest — type checking, substitution, error handling, observability.

**What changes for the engine:**

- A registry of "implementations" instead of "node types": `bash`, `ai-command`, `ai-prompt`, `script-bun`, `script-uv`, `http`, `wait-for-event`, `human-approval`. Each implementation knows how to take a typed inputs object, run, and return a typed outputs object. Adding a new implementation (e.g. `mcp-tool-call`) doesn't require changing any author-facing API.
- The substitution layer goes away as a concept. The engine constructs each implementation's environment from the resolved inputs at execution time, using a per-implementation adapter (bash gets envvars, AI gets prompt-substituted text, HTTP gets templated URL/body). No shell-quote layer; no JSON-stringify layer; no `$node.output.field` regex pass.
- Outputs are JSON Schema (or Zod, or whatever) and validated at write time. A workflow with mismatched types is rejected at load time before any node runs.

**Why this isn't trivial:**

- Today's substitution-everywhere model is very flexible. The cost of typed I/O is that a workflow author has to declare every input and output. That's friction to write, but it pays off the first time a typed workflow catches a substitution bug at load time instead of run time.
- The `bash:` body convention today is "print JSON to stdout, set output_format if you want to be strict." A typed model formalizes that contract — you can no longer print JSON-ish text and hope downstream agents tolerate it. Strictness is the goal but it's also a behavior change.
- Existing workflows would need conversion. Probably a one-time mechanical translation script ("for every node, infer inputs from the bash body's `$x.output.y` references; infer outputs from the JSON keys it prints") plus hand-fixing the ambiguous cases.

---

## "Try this 5 times" should be one node, not ten

**Friction:** The dev loop today is 10 hand-authored nodes — `dev-attempt-1..5` and `review-dev-attempt-1..5` — wired with a chain of `when:` conditions and `parse-dev-review-N` outputs. Adding a sixth attempt is a YAML edit; changing what "attempt" means is a YAML edit in 5 places; understanding the loop requires reading a couple hundred lines.

**Why it exists:** Archon's `loop:` primitive is for "iterative AI prompt until completion signal," which doesn't fit "try N times with a deterministic gate after each, give up on convergence or after N." So Archie unrolls the loop manually as a DAG. That makes the loop visible to the engine (each attempt is a real node, can be skipped via `when:`, has its own retry/cost) but at the cost of authoring.

**What the right primitive looks like:** something like

```yaml
- id: dev-loop
  attempt:
    - id: dev-attempt
      run:
        ai:
          command: archon-dev-attempt
    - id: validate
      run:
        bash: bash /home/user/Archon/.archon/scripts/task-run-validation.sh
      outputs:
        passed: boolean
    - id: review
      run:
        ai:
          command: archon-review-dev-attempt
      outputs:
        passed: boolean
  until: "$validate.passed && $review.passed"
  max_attempts: 5
```

The engine desugars this at load time into `dev-loop.attempt-1.dev-attempt`, `dev-loop.attempt-1.validate`, `dev-loop.attempt-1.review`, `dev-loop.attempt-2.dev-attempt`, … — each a real DAG node with a `when:` condition derived from the `until:` expression. Author sees one node; engine sees 15. `$dev-loop.output` is exposed as the final state.

**Caveats / things to preserve:** per-attempt cost recovery, resumability mid-loop, the ability to skip later attempts when an earlier one converges. These are all properties of the unrolled DAG today — the desugaring has to keep them intact. Also, the `when:` on each attempt's nodes is currently authored explicitly; the desugarer would derive it from `until:` and `max_attempts`.

---

## Design lens 3: control flow is `goto` from a node's output

Today the engine has multiple control-flow mechanisms baked in: `when:` clauses, `trigger_rule` for fan-in, implicit branching via paired `when:`, "skipped" state propagation, and the `cancel:` primitive. Each adds engine surface and authoring complexity.

The reduction: **a node can emit `goto: <node-id>` as part of its output, and the runner moves the cursor there.** That's it. No special loop primitive, no `until:`, no `when:`, no `trigger_rule`.

**The whole runtime model:**

1. Maintain a cursor pointing at "the current node."
2. Run the node. Get its output.
3. If the output has `goto: X`, set the cursor to X.
4. Otherwise advance to the next node.
5. Loop until terminal (no more nodes, or output has `terminate: true`).
6. Log every execution so observability can see "node 3 ran 4 times this run."

That's the engine. No DAG traversal, no `when:` evaluator, no skip-propagation rules, no `trigger_rule` lookup tables. Just a cursor and a goto.

**Concrete: the dev loop becomes one chain, no unrolling:**

```
0. contract creator    → emits the contract
1. test creator        → reads contract, writes tests
2. test evaluator      → emits {ok: true} or {goto: 1, feedback: "..."}
3. code generator      → reads contract + tests; writes code
4. tester              → runs vitest/lint/tsc; emits {ok, failures}
5. code evaluator      → emits {ok: true} or {goto: 3, feedback: "..."}
6. PR creator          → opens PR
```

If node 2 is unhappy with the tests, `goto: 1` and node 1 re-runs. If node 5 is unhappy, `goto: 3` and the dev loop runs again. If node 4 finds gate failures, the author can have it `goto: 3` directly (skipping the AI evaluator) — the workflow's choice. Early convergence isn't a special "skip" feature; it's just the evaluator emitting `ok: true` and the cursor advancing normally.

This collapses most of what makes the current task-implement workflow complicated:

- The 5 hand-authored attempts disappear. There's one chain; the loop happens because an evaluator points back.
- "Early convergence skips later attempts" isn't a special engine feature — the evaluator says `ok: true`, the cursor moves on.
- `trigger_rule` semantics for "wait for attempts 1–5" don't apply because there's only one of each node.
- `parse-dev-review-N` doesn't exist — node 5 IS the evaluator and emits its decision directly.
- "Max attempts" becomes a property of the evaluator: it keeps a counter, and on the Nth failure emits `{ terminate: true, reason: "max attempts" }` or `{ goto: 6, force: true }` (depending on which terminal behavior you want).

**Things to think through (not blockers, but real):**

- **Parallel nodes.** Even cleaner than fan-out-as-a-node: drop the explicit fan-out concept entirely. Nodes publish outputs; other nodes subscribe to whatever outputs they need. Parallelism happens because 5 reviewers all subscribe to the same `pr-diff` output and wake up concurrently when it publishes. The author never writes a "fan-out" anywhere — they just write 5 nodes with the same subscription. Synchronization is also emergent: a node that subscribes to several outputs runs when all of them have published. The engine's responsibility is "track who has published what, wake up subscribers when all their inputs are present, advance the cursor on goto." See "Subscriptions over edges" below.

- **Cycle protection.** With `goto` you can write infinite loops. Runtime needs a budget — total executions per run, max iterations through any one node, total wall time, total $ — and emits terminate when exceeded. Cheap to add; a few lines in the runner.

- **Resume after crash.** With cursors, resume is just "where was the cursor last." Simpler than today's "find the last completed DAG node and re-derive the frontier."

- **State across iterations.** When node 5 says `goto: 3`, does node 3 re-run with fresh state or with state from prior iterations? Probably the latter (the AI agent "remembers" what it tried). Either the engine threads prior outputs through automatically (last K iterations of node 3 are available as `prior_attempts`), or the node declares what it consumes from history.

- **Forward goto only or backward only?** Forward gotos add expressiveness (skip a node entirely) but also add the ability to write hard-to-understand workflows. Probably restrict to backward only; forward "skipping" can be expressed as an evaluator that emits `{ skip_to: X }` which the runner handles distinctly from `goto`. Or: forbid forward goto, require an explicit terminate signal for early exit.

- **Error handling.** Today a node that throws causes downstream `when:`-conditional nodes to skip, which is handled by the engine. In a goto model, a node that throws either:
  - (a) returns control to the recipe author via a wrapper node ("on error, goto: error-handler") — clean but more authoring;
  - (b) the engine has a "default goto on error" option per node — pragmatic compromise.
  Either works; (a) is more honest, (b) is more ergonomic.

This is where the redesign stops being a refactor and becomes a different kind of system: **the runtime is a sequenced node executor with goto, not a DAG traversal engine.** Control is data, control is local (one node decides where the cursor goes next), and the engine has almost no concepts of its own. Most of today's primitives (when, trigger_rule, skipped propagation, cancel, loop) collapse into "an evaluator node emits a goto or a terminate signal."

---

## Synthesis: nodes as observables

After lenses 0–3, the model is converging on something with a deep prior art: **observables (RxJS / ReactiveX semantics) applied to workflow execution.**

Each node is an `Observable<T>`. It subscribes to upstream observables. It emits values to anyone subscribed to it. The whole runtime is just a scheduler that drives the observable graph.

How the lenses collapse into this:

- **One primitive (lens 0):** the primitive is an observable. A "workflow" is just a graph of observables. The carve-outs (`loop`, `approval`, `cancel`, `command` vs `workflow`, etc) are observable patterns, not new constructs.
- **Sugar over a strict graph (lens 1):** the "strict graph" the engine sees is the observable subscription graph. The "sugar" the author writes is whatever higher-level construct desugars cleanly to observables (a `repeat` operator, a `combineLatest` block, a `retry` operator).
- **Typed I/O (lens 2):** observables are typed. `Observable<{passed: boolean, repairs: Repair[]}>`. Subscriptions type-check at workflow load — wrong shape, fail fast.
- **Control as data, cursor + goto (lens 3):** no cursor needed. Iteration is just an observable emitting more values over time. "Goto" is the observable emitting again, possibly with new internal state. Termination is `complete()`. Errors are `error()`.
- **Subscriptions over edges (lens 4 — see below):** literally the observable contract. Author declares "this node subscribes to X"; the engine wires the rest.

What this gives you for free, because it's observable semantics:

- `merge` — interleave two streams (a node that subscribes to multiple upstreams and emits whichever fires first).
- `combineLatest` — wake up whenever any input changes (the reactive synthesizer pattern).
- `forkJoin` — wait for all inputs to complete (today's `trigger_rule: all_done`).
- `switchMap` — when an upstream emits, cancel the in-flight downstream and start a new one (useful for "user clicked retry, abandon what's running").
- `retry`, `repeat`, `take`, `takeUntil` — iteration patterns that authors compose, not engine-baked primitives.
- `share` / multicast — multiple subscribers see the same emissions without re-running upstream (so 5 reviewers don't each cause `open-pr` to re-run).
- Error propagation that the author can intercept (`catchError` returns a fallback observable) instead of engine-policy "skip downstream nodes."

What you give up vs. today's DAG model:

- **Static analysis is harder.** With observables, the runtime graph isn't fully knowable at workflow load — a node can `switchMap` to a dynamically chosen downstream observable, and the engine doesn't know which one until runtime. Today's DAG is fully static at load time. This is mostly a tooling cost (you can't draw a complete picture of "what will run" before running). For Archie's use case probably fine.
- **Cycle protection is the author's problem.** A node that always emits `goto: prior-node` is an infinite loop, and the engine doesn't stop it. That's the right call — JS, Python, every general-purpose language ever lets you write infinite loops. The runtime gives you primitives; the author chooses how to use them. If they want a budget, they observe cost / iteration count and have a node terminate the workflow when it exceeds. That's author code, not engine policy.
- **Observability is different.** With reactive semantics, "what ran" is a stream of emissions over time, not a list of completed nodes. Showing a workflow run in a UI means showing the emission timeline, not a static DAG with checkmarks. Different (probably better) — but a bigger UI rewrite.

The mental model an author needs to write workflows in this system is "I'm composing observables." That's a real cognitive load shift from today's "I'm writing nodes in a DAG." But it's a load shift to a model that's been mainstream for a decade (RxJS, RxJava, Combine, Kotlin Flow), so the docs / tutorials / mental scaffolding all already exist. You're not inventing a paradigm; you're applying one.

This synthesis suggests v3+ isn't "rewrite Archon" — it's **"pick a reactive runtime (Node + RxJS, or just write a small one) and express each node as an observable."** The whole engine becomes an observable graph executor with persistence, observability, and the implementation registry from lens 2. That's a much smaller piece of code than today's Archon engine.

---

## Design lens 4: subscriptions over edges (no DAG declared by the author)

Today the workflow author writes `depends_on: [a, b]` for every node. The engine builds a DAG from those edges and traverses it. Parallelism is emergent (two nodes with non-overlapping `depends_on` happen to run concurrently), but it's also implicit and easy to mis-author.

The reduction: **nodes don't depend on other nodes; they subscribe to outputs.**

```yaml
- id: review-code
  subscribes:
    pr_diff: $open-pr.pr_diff
  publishes:
    code_review: { passed: boolean, ... }
```

- The author never writes `depends_on`. The engine derives the dependency graph from the subscription lattice.
- Two nodes that subscribe to the same upstream output run **concurrently** when that output publishes — no fan-out declaration. The 5 reviewers all wake up the moment `open-pr` publishes `pr-diff`.
- A node that subscribes to several outputs runs when **all** are present — no fan-in declaration. The synthesize node just lists the 5 reviewers' outputs and runs when they're all there.
- Combined with cursor + goto (lens 3), this gives you: **the cursor advances forward through nodes; subscriptions cause concurrent and joining behavior to fall out for free; goto handles iteration.**

**What's appealing:**

- Authors describe **what each node needs**, not **who runs in what order**. The "run in parallel" / "wait for all" / "wait for any" decisions vanish from the author's surface.
- Adding a 6th reviewer is one new node with the same subscription as the others. No edits to anything else; no fan-out updates; no `trigger_rule` re-tuning.
- Refactoring is easy. Want to drop a node? Delete it; if no one subscribes to its output, nothing else cares. Want to insert a transformation step between two nodes? Insert the transformer with the upstream's subscription, change the downstream to subscribe to the transformer's output. Surgical, no DAG bookkeeping.

**What changes for the engine:**

- The engine maintains a published-outputs registry (effectively a key-value store, channel-style). A node "publishes" by writing to keys; "subscribes" by declaring what keys it reads.
- A node is runnable when (a) the cursor reaches it OR (b) all its subscribed inputs have published since its last run. (The OR is the reactive bit; without it, you have linear-with-implicit-parallelism. With it, you have full reactive — any node can wake up the moment its inputs are ready.)
- Goto interacts with subscriptions: when the cursor jumps back to node 3, the engine clears any "stale" published outputs from nodes 4–N (so the next run of node 4 sees the fresh output of node 3, not the old one). Or: outputs are versioned, and subscribers always read the latest version. Implementation detail.

**Things to think through:**

- **Is the cursor still needed?** If subscriptions handle "who runs when," maybe the engine just runs whatever's runnable until nothing is. The cursor is useful for ordering and for goto; without it, the model is purely reactive (any node can fire when ready). A purely reactive model is simpler but harder to reason about for sequential pipelines like the dev loop. The cursor + subscriptions hybrid is probably the right balance: cursor drives forward motion and goto, subscriptions cause concurrent behavior to emerge.
- **Versioning of published outputs.** When node 3 (code-generator) publishes a new version of `code` after a goto, what happens to the prior `tester` and `code-evaluator` outputs that were derived from the old `code`? Either the engine versions them (and subscribers always pull latest), or the goto explicitly invalidates them. Cleaner if explicit: a goto invalidates all outputs published after the goto target.
- **Naming conflicts.** If two nodes publish to the same output key (`code` from node 3 and `code` from node 14 auto-fix), is that a feature (auto-fix overwrites) or a bug (collision)? Probably a feature, but worth being explicit. The dev loop's auto-fix node IS expected to publish to the same `code` channel as the original code-generator.

**This pairs with the cursor + goto model from lens 3:**

- Cursor + goto: linear forward motion plus iteration.
- Subscriptions: implicit parallelism plus implicit synchronization.

Together: the author writes nodes with subscriptions and occasional gotos. The engine runs the cursor forward, fires subscribers reactively as outputs publish, and handles iteration when an evaluator emits a goto. There's no DAG declared by the author, no `depends_on`, no `when:`, no `trigger_rule`, no fan-out, no fan-in, no loop primitive — just nodes that publish, subscribe, and occasionally goto.

---

---

# Part 2 — Platform redesigns

The lenses above redesign the **execution model** (what a workflow is, how it runs, how nodes compose). The items here redesign the **platform** that surrounds it: logging, AI integration shape, and the harness. Different category — these are about what holds the runtime up day-to-day, not about how authors express workflows.

## Harness: transparent tool-call interception, owned by the runtime

**Problem.** Today the dev-attempt cage uses the Claude Agent SDK's `PreToolUse` hook. You write `archie-pretooluse-tests-only.ts`, declare it on a node, the SDK calls your script before each tool use, the script permits or denies. It works for Claude. It does not work for Codex or Pi — those providers don't have an equivalent hook surface, or have a different one. So the cage is real on Claude nodes and aspirational elsewhere; CLAUDE.md says "the cage is the authoritative authority" but that's only true for one provider.

It's also fragile: the hook script runs *inside the SDK's process model*, with the SDK's lifecycle, with the SDK's semantics. If Anthropic ships a breaking change to the hook API, the cage breaks. The runtime depends on a feature it doesn't own.

**The reframe.** The runtime doesn't own tool *execution* — Claude's built-in `Edit` / `Write` / `Read` / `Bash` tools still do the actual file-editing and shell-running. The runtime owns the **request stream**: the bytes flowing from agent ("I want to call tool X with args Y") to the provider's tool implementation, and back. Sit in that stream as a transparent middleman; intercept every tool-call request before it executes; decide what happens.

**The shape.** Every provider's adapter surfaces tool-call requests as a typed event before the underlying tool runs:

```ts
type ToolCallEvent = {
  agentId: string;
  nodeId: string;
  toolName: string;       // "Edit", "Bash", etc — provider-native names
  args: unknown;
  callId: string;
};
```

Hooks are functions: `(event: ToolCallEvent) => HookDecision`. The decision is one of:

- `{ kind: "allow" }` — let it through unchanged
- `{ kind: "deny", reason: string }` — block; the agent receives a synthesized tool_result with the reason; the actual tool never runs
- `{ kind: "rewrite", args: unknown }` — let it through with modified args
- `{ kind: "substitute", result: unknown }` — pretend it ran, return this result; the actual tool never runs

Hooks compose as a chain. First non-allow decision wins, or compose differently (chain of rewriters then a gate, etc).

**Concrete patterns this enables:**

```ts
// Today's "dev-attempt cage" — no test edits
function denyTestEdits(event: ToolCallEvent): HookDecision {
  if (["Edit", "Write"].includes(event.toolName)) {
    const path = (event.args as any).file_path as string;
    if (path && /(^|\/)(tests?|e2e|__tests__)\//.test(path)) {
      return {
        kind: "deny",
        reason: "You are not allowed to edit test files in this node. " +
                "Test repair happens in a separate node. Focus on production code.",
      };
    }
  }
  return { kind: "allow" };
}

// The inverse cage for test-repair
// Same shape; opposite predicate

// A logging hook
function logEveryTool(event: ToolCallEvent): HookDecision {
  metrics.toolCalls.inc({ node: event.nodeId, tool: event.toolName });
  events.append({ type: "tool_call", ...event });
  return { kind: "allow" };
}

// A budget hook
function denyAfterBudget(event: ToolCallEvent): HookDecision {
  if (runState.toolCallCount++ > 200) {
    return { kind: "deny", reason: "Tool call budget exceeded for this node." };
  }
  return { kind: "allow" };
}

// A redirection hook — pin all file ops to the worktree
function pinToWorktree(event: ToolCallEvent): HookDecision {
  if (["Edit", "Write", "Read"].includes(event.toolName)) {
    const args = event.args as any;
    if (args.file_path && !args.file_path.startsWith(WORKTREE_ROOT)) {
      return {
        kind: "rewrite",
        args: { ...args, file_path: path.join(WORKTREE_ROOT, args.file_path) },
      };
    }
  }
  return { kind: "allow" };
}

// A substitution hook — for unit-testing workflows without actually shelling out
function fakeBashForTesting(event: ToolCallEvent): HookDecision {
  if (event.toolName === "Bash") {
    return {
      kind: "substitute",
      result: { stdout: TEST_FIXTURES[event.args.command] ?? "", exit_code: 0 },
    };
  }
  return { kind: "allow" };
}
```

**Why this is meaningfully better than today's PreToolUse:**

- **Provider-agnostic.** Claude, Codex, Pi all flow through the same harness; same hook surface for every model.
- **Runtime owns the bytes.** Cannot be broken by an SDK API change because the runtime is the one routing the call.
- **Composable, testable, first-class.** Hooks are normal functions, not provider-configured scripts. Apply per-node, per-workflow, globally. Order them. Test them in isolation.
- **"Deny with feedback" is clean.** Synthesize the `tool_result` shape the agent expects, with a human-readable reason; agent reads it like any other tool error and adjusts.
- **Substitution unlocks testing.** Run a workflow in a test environment where Bash is intercepted and answered with fixtures. Currently no clean way to do that.

**What it doesn't try to do:**

- **Doesn't reimplement tools.** Claude's `Edit` still does the editing; the harness inspects, allows, denies, rewrites, or substitutes. Man-in-the-middle, not a tool author.
- **Doesn't replace the provider's prompt-level features.** Skills, MCP, system prompts unchanged. The harness intercepts at the tool-call layer, not at the prompt-construction layer.
- **Doesn't require the agent to know the harness exists.** Same prompt, same tools, same SDK from the agent's view. Some calls just return errors or modified results; agent adapts as it would to any tool result.

**The hard part:** per-provider implementation cost. Each provider's SDK streams tool-use events differently. For Claude: intercept `content_block_delta` events with `tool_use`-typed blocks; synthesize `tool_result` content blocks for denies and substitutes. For Codex: function-call events. For Pi: whatever Pi does. Each adapter is its own ~300 lines and has to track SDK evolution. But this isn't strictly new work — Archon already has provider-specific code for translating tool definitions across providers. You're trading one piece of provider-specific code for a different piece, not adding net work.

## Logging — to fill in later

Open thread. Today's logging is four overlapping systems (Pino structured logs from Archon modules; JSONL workflow event files; SQLite `remote_agent_workflow_events` rows; AI provider tool-call traces in conversation message history). They have different lifecycles, different schemas, and aren't joinable. Cross-run analysis ("how does dev-loop attempt count trend over the last 30 runs?", "which reviewer fails most often?") is multi-query pain.

Sketch of where this should land: **append-only event log as the canonical source**, with the DB row, the JSONL file, and the AI provider trace as projections. Standard event types covering workflow lifecycle, node lifecycle, tool calls, AI streaming chunks, rate limits, retries, cost-per-event. Real query layer (DuckDB on Parquet, or ClickHouse, or well-indexed Postgres). Cost / attempts / time-per-node / tool-call distribution all fall out as aggregations.

Highest day-to-day quality-of-life win available. Worth a real lens write-up when there's time.

## AI integration shape — to fill in later

Open thread. The current `IAgentProvider` interface accreted around Claude's shape — "skills," "agents," "MCP," "hooks" leak into the workflow surface. Codex no-ops some of them; Pi works around more. Adding a fourth provider would be more accretion.

Sketch: **a provider-agnostic protocol** that's expressive enough for what Archie actually needs (typed prompts, typed tools with Zod schemas, structured response, optional streaming, normalized cost/rate-limit signals) and no more. Adapters are each ~200 lines: protocol → SDK call, SDK response → protocol, errors mapped to a common taxonomy. Provider-specific features (Claude skills, MCP) live behind extension points but don't shape the core protocol. The hard call is how much of Claude's specifics to surface; lean toward portability, accept that 5% of nodes might use a Claude-specific implementation.

Pairs naturally with the harness lens above — once tool calls are intercepted at the runtime layer, the provider only has to tell the runtime "the agent wants to call X" and the runtime does the rest. That simplifies the protocol substantially.

---

_(append more friction items here as they hit)_
