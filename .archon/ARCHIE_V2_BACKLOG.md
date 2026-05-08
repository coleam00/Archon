# Archie v2 — engine and workflow enhancements

**When to read this:** when planning v2 work that touches the Archon engine or shared workflow infrastructure. These are concrete in-scope improvements with implementation steps, distinct from `ARCHIE_V3_CANDIDATES.md` (the bigger architectural rethinks).

---

## Unify AI-invocation: one path, called from anywhere

Archon currently has two separate codepaths for "invoke an AI agent with these options":

- **AI-node path** (command, prompt nodes): around `dag-executor.ts:360-470`. Reads every supported field from the node — `allowed_tools`, `denied_tools`, `hooks`, `mcp`, `skills`, `agents`, `systemPrompt`, `output_format`, `effort`, `thinking`, `maxBudgetUsd`, `fallbackModel`, `sandbox`, `betas` — resolves them (loads MCP configs from disk, resolves hook script paths, applies skill wrappers as inline agents), and produces a `SendQueryOptions` object.

- **Loop-node path** (`buildLoopNodeOptions` at `dag-executor.ts:1700`): a 22-line function that forwards only `model`, `env`, `assistantConfig`, and a small subset of workflow-level options. None of the per-node AI fields are forwarded.

The schemas reflect this split: `LOOP_NODE_AI_FIELDS` lists fields the loop path drops, the loader emits a warning when those fields are set on loop nodes, the executor silently ignores them. A loop node with `hooks:` doesn't get the cage at runtime.

That's the visible symptom. The underlying issue: there are two functions doing the same conceptual job, and they accreted independently. There's no architectural reason loops can't have hooks; there's just no code that forwards them.

### The fix

Have one function that builds AI-invocation options. Call it from everywhere that invokes an AI agent: the AI-node executor, the loop-node executor, the approval-node's `on_reject` retry, anywhere else added later.

```ts
async function buildAiInvocationOptions(
  ctx: AiInvocationContext  // node, workflow config, cwd, run context
): Promise<SendQueryOptions> {
  // Read every supported field from ctx.
  // Resolve hooks, MCP, skills, agents.
  // Apply workflow-level option fallbacks.
  // Return options.
}
```

Per-call differences (the loop's per-iteration session threading, the AI-node's first-call vs resume distinction) are at the call site, not in option-building. Option-building is one function.

### Implementation steps

1. Extract the AI-node path's option-building logic from `dag-executor.ts:360-470` into a shared helper (probably a separate file, `packages/workflows/src/ai-invocation-options.ts`).
2. Refactor the AI-node executor to call it.
3. Refactor `executeLoopNode` to call it instead of `buildLoopNodeOptions`. Delete `buildLoopNodeOptions`.
4. Drop `LOOP_NODE_AI_FIELDS` from the schema; loader stops warning about hooks/skills/etc on loop nodes.
5. Add a test that a loop node with `hooks: { PreToolUse: ... }` fires the hook on each iteration's tool calls.

For Claude-only deployments the capability-warning machinery (provider supports hooks? skills? MCP?) is unnecessary — Claude supports every field. The shared helper can drop those checks or keep them as no-ops. About a half-day of work.

### What this unlocks

- **State-driven loops with cages.** The dev loop in `task-implement` can collapse from 10 hand-unrolled nodes to one state-driven loop while keeping the test-write cage. Adding a 6th attempt becomes a `max_iterations: 6` config bump instead of a 5-place YAML diff.
- **Loop nodes can use commands.** Today `loop:` only accepts inline `prompt:`; once option-resolution is unified, a loop iteration can run a named command file.
- **Future AI invocation surfaces inherit features automatically.** When approval-node's `on_reject` retry, or any new construct, needs to invoke an AI agent, it calls the same function and gets every supported field for free.

---

## Generic dispatcher hook: policies as data, not as user-authored scripts

Today's cage on the dev agent is a user-authored TypeScript file (`archie-pretooluse-tests-only.ts`) registered as a `PreToolUse` hook on a specific node. The SDK invokes that script before each tool call; the script returns allow/deny. It works, but the user has to author a TS file per cage variant, and the cage exists only on nodes where `node.hooks` is set and forwarded to the SDK.

The cleaner shape: **a single generic dispatcher hook installed on every Claude invocation, plus per-node policy data the dispatcher reads at decision time.**

### The architecture

When Archon registers the dispatcher with the SDK for a given `query()` call, it closes over the current node's policy config. The SDK invokes the dispatcher before each tool use. The dispatcher reads the policies, evaluates them in order, and returns the first non-allow decision (or allow if no policy objected). The SDK acts on the decision: allow lets the tool run; deny synthesizes a tool-result error the agent reads; rewrite modifies the args before the tool runs; substitute returns a fake result without running the tool.

```
Claude subprocess          Archon dispatcher
    │                           │
    │ tool call request         │   read node.policies
    ├─── PreToolUse ───────────▶│   evaluate each policy in order
    │                           │   { allow } | { deny, reason } |
    │◀───── decision ───────────┤   { rewrite, args } | { substitute, result }
    │                           │
    │ act on decision           │
```

### Rules: the user surface

The workflow author doesn't write "policies" or "hooks" — they declare **rules** on the node, in domain language:

```yaml
- id: dev-attempt
  command: archon-dev-attempt
  rules:
    no_edit:
      - "tests/**"
      - "e2e/**"
      - "**/*.test.{ts,tsx,js,jsx}"
    max_tool_calls: 200
    pin_cwd: $worktree
    log_all_writes: true

- id: test-repair
  command: archon-test-repair
  rules:
    no_edit:
      - "src/**"
      - "convex/**"
    max_tool_calls: 100
```

Each rule is its own typed field. The schema validates the shape at workflow-parse time, not at runtime. Names express intent (`no_edit`, `max_tool_calls`, `pin_cwd`) rather than engine internals (`deny-paths`, `budget`, `rewrite-args`). The author is saying what the node must obey; the engine figures out how to enforce it.

Rules can take richer config when needed:

```yaml
rules:
  no_edit:
    - pattern: "tests/**"
      reason: "Dev agent must not edit tests in this node — see contract for which files are scoped."
```

Short form (string) and long form (object with `reason`) coexist; the loader desugars the short form to the long form with defaults.

Workflow-level rules apply to every node unless overridden:

```yaml
name: task-implement
rules:
  pin_cwd: $worktree
  log_all_writes: true

nodes:
  - id: dev-attempt
    command: archon-dev-attempt
    rules:
      no_edit: ["tests/**"]
      max_tool_calls: 200
      # inherits pin_cwd and log_all_writes from workflow level
```

### The dispatcher is the engine; rules are the surface

Below the user surface, the dispatcher reads `node.rules`, translates each rule into a policy implementation, composes them, and registers the composed function as the SDK's `PreToolUse` hook. From the workflow author's perspective there is no dispatcher, no policy layer — just rules on nodes. From the engine's perspective, rules compile to policies that the dispatcher executes.

Built-in rule kinds (each backed by a policy implementation):

- `no_edit: [glob...]` / `allow_edit: [glob...]` — file-write restrictions
- `no_read: [glob...]` / `allow_read: [glob...]` — read restrictions
- `no_bash: [pattern...]` — shell command denials
- `no_tools: [tool_name...]` / `allow_tools: [tool_name...]` — tool-level allow/deny
- `pin_cwd: <path>` — rewrite Bash/Read/Write/Edit args to anchor at this path
- `max_tool_calls: <n>` — count and deny after threshold
- `max_cost_usd: <n>` — enforce budget against run metadata
- `log_all_writes: true` / `log_all_tool_calls: true` — emit structured events
- `custom: <script-path>` — escape hatch for project-specific rules that don't match a built-in

Adding a new built-in rule is one place to add it: register a policy implementation, schema entry, docs entry. Authors get the new rule for free across every workflow.

Rule precedence: workflow-level rules apply, then node-level rules override or add. Within a single rule type (e.g. `no_edit`), patterns are unioned. Across rule types, deny rules win over allow rules.

### What this replaces

- **The current `node.hooks` field** (path to user-authored script). Stays as a legacy code path for compatibility; new work uses `policies: [...]`.
- **The `archie-pretooluse-tests-only.ts` and `archie-pretooluse-no-tests.ts` scripts.** Replaced by `policies: [{ kind: deny-paths, ... }]` on the relevant nodes.

### What this enables

- **Universal cage coverage.** The dispatcher is registered for every `query()` call regardless of node type (AI node, loop iteration, future approval-retry). No "loop nodes don't have hooks" bug; the hook is universal, the policies are per-node config.
- **Provider-agnostic policy enforcement.** When Codex or Pi adapters wire similar dispatchers (or when v3's transparent harness lens lands), the same policy data applies. Today's per-provider hook differences (Claude has them, Codex doesn't) become an adapter implementation detail, not a workflow-author concern.
- **Composable, testable cages.** Policies compose by listing them. A node can have a deny-paths policy AND a budget policy AND a logging policy. Each is independently testable.
- **Rewrite and substitute, not just allow/deny.** The current SDK hook can deny but can't (cleanly) rewrite or substitute. The dispatcher pattern handles all four decisions because the dispatcher controls the response.
- **Observability for free.** A built-in `log-all` policy emits structured events per tool call. Cross-run analysis (which tools fail most often, which agents loop on which calls) becomes a SQL query.

### Policies are arbitrary code we own — that's the real unlock

The dispatcher is a JS function Archon owns. Claude has no idea what rules exist; it makes a request, the SDK pauses and asks us, we say yes or no, it proceeds. That means policies aren't limited to path patterns — they're ordinary code with full access to the run context. Examples of what's trivial in this model and impossible in a prompt:

- **Stateful policies.** "No more than 5 file writes in this run." Counter on run context.
- **Cross-call policies.** "Deny Edit if this file was edited 3 times already this session — agent's looping." Read prior tool-call events from the run's event log; decide on history.
- **Contract-enforcing policies.** "Edits to `convex/schema.ts` are denied unless the ticket's contract names it." Read the ticket's contract artifact; compare against the proposed edit. The cage automatically enforces the contract.
- **Cost policies.** "If this run has spent $20, deny further sub-agent invocations." Read cost-so-far; deny Task tool calls.
- **Cross-policy invariants.** "Deny Edit if the agent hasn't Read the file first this session." Inter-policy dependency, stops a whole class of agent misbehavior.
- **Dynamic policies derived from artifacts.** A policy reads `$ARTIFACTS_DIR/contract.json` at decision time and validates the proposed edit against the contract's allowed exports.
- **Adversarial sanity-check policies.** Catch the WOR-87-class reviewer hallucination: when the reviewer claims production code is correct, a policy diff-checks the claim against actual files; denies the gate decision if the claim doesn't hold.
- **Test-harness correctness (project-rules-driven).** A policy that runs against test-gen's output. Reads the project's declared testing-rules artifact (each project owns its own — Convex projects say "convex-test for runtime tests"; Postgres projects say "use a real test database"; etc). Checks each test file against those rules: e.g., for ConflictCoach, if a test file imports from `convex/values`/`convex/server`/`@convex/...` but doesn't use convex-test, deny the commit with a specific reason. The policy mechanism is generic; the patterns it checks come from the project's rules. Catches "low-fidelity tests against mocked runtime" as a class without making Archie carry knowledge of every possible stack.

The dispatcher is the right place for anything that requires multi-tool-call awareness, run state, or project policy. The agent can't reliably enforce those rules because the agent only knows its conversation; the dispatcher has the workflow's full context.

This is also a cheap escape hatch for misbehaving agents. If an agent develops a specific failure pattern, write a policy that catches it. The agent's deliberation adjusts because each denied call comes back as a synthetic tool-result-error the agent reads and responds to. No retraining, no re-prompting.

### Discipline — when NOT to reach for a policy

Policies start cheap and accumulate. A 50-policy system is opaque; debugging "why did the agent fail" requires checking everything. The discipline:

- Prefer fixing the prompt, fixing the contract, fixing the workflow shape FIRST.
- Reach for a policy when a structural fix is wrong-shape or too expensive.
- A policy that catches a *specific* bug class is worth keeping; a policy for a *general* misbehavior pattern probably means the prompt or the contract is wrong.
- Audit policies periodically — remove ones whose underlying problem has been fixed structurally.

The dispatcher is the safety net, not the design.

### Implementation sketch

1. **Policy interface**: `(toolName, args, runContext) => Promise<Decision>`. Return type is `{ allow: true }` | `{ deny: string }` | `{ rewrite: args }` | `{ substitute: result }`.
2. **Policy registry**: a map of `kind` → policy implementation. Add a new policy kind by registering a new entry.
3. **Dispatcher**: composes a list of policies into a single hook callback. First non-allow decision wins, or allow if none object.
4. **Wire into the unified AI-invocation path** (the first v2 enhancement). When that path builds `SendQueryOptions`, it always installs the dispatcher hook with the node's resolved policies. Whether `policies: []` is empty or full, the dispatcher runs and either passes through or enforces.
5. **Schema update**: add `policies: PolicyConfig[]` to the dag-node base schema. Each policy has a discriminated `kind` field plus kind-specific config.
6. **Migrate the existing dev-attempt cage** from `node.hooks` to `node.policies` in `task-implement.yaml`. Keep `node.hooks` as legacy.
7. **Tests**: per-policy unit tests; integration test of the dispatcher composing several policies.

Couple days of work end to end; depends on the unified AI-invocation enhancement landing first (so the dispatcher has one place to be installed, not two).

### What stays out of scope

- **Anthropic-API changes.** This is using the SDK's existing hook surface. No changes to how Archon talks to the model; just better use of what's there.
- **Engine rewrite.** This is composable on top of today's executor; doesn't require changing DAG semantics.
- **The full v3 transparent-harness vision** (own the request stream, work across providers). That's a v3 lens. The v2 dispatcher is provider-specific (Claude SDK hook for now), but the *policy data* is provider-agnostic, so when the v3 harness lands, the policies survive and the dispatcher implementation becomes the harness.

This is the "harness" idea from `ARCHIE_V3_CANDIDATES.md`, but at v2 scope: don't replace the SDK's hook system, just standardize how Archon uses it. The full v3 harness — Archon owning the request stream regardless of provider — supersedes this when it lands. Until then, this version delivers most of the practical wins.

---

## Replace generalist stack expert with focused per-stack experts

**Observed in mark1 run.** The single `stack-expert-pass` node was given the whole tech stack (Convex, React, Vite, Tailwind, shadcn, Vitest, Playwright, TypeScript) and asked to author per-task practices for all of it. Result: patchy coverage. Of 9 backend tasks that author real Convex mutations/queries/actions, only 1 (the explicitly-named cost-tracking hardening task) had `convex-test` in its stack practices. The other 8 (case CRUD, invite flow, private coaching, synthesis, joint chat, draft coach, case closure, etc.) silently inherited the generalist's lack of attention.

This is the same failure class as run-1's "tests are broad but not high-fidelity" finding from the Codex review — the canonical test harness gets lost when one prompt has to cover too many stacks at once.

**The fix:** decompose the single stack-expert pass into a pipeline of focused per-stack expert passes. Each pass targets a specific stack layer with a tight, opinionated prompt:

**The expert doesn't author tickets.** It produces a single canonical document — call it `stack-rules.md` — that states how this stack is built and tested. Once. Attached to the plan as a peer artifact, not edited into every ticket.

Mark1 got this wrong: it told the stack expert to append `stack_practices` per task. That puts the expert at the wrong granularity, doing per-task work, where it inevitably under-attends to specifics. The expert's job should be the *project-level statement of how this stack works*, not the per-ticket sprinkling.

The right shape:

- **Stack expert authors `stack-rules.md` once per workflow run.** Statements like "this project uses Convex + React + Vite + Vitest + Playwright"; "for Convex mutations/queries/actions, tests use convex-test"; "for pure utility modules with zero Convex runtime imports in test files, tests use Vitest only"; "for React components, tests use Vitest + React Testing Library"; "function references vs JS exports — `internal.x.y` not the imported function". One document. Per-stack expert authors the slice they own (backend, frontend, e2e, etc.) — composes via concatenation or sequential editing, not per-task scattering.
- **Compose-tickets loop reads `stack-rules.md` alongside the plan.** When authoring each ticket, the loop consults both: per-task entry from the plan (cuts, ACs, deps) and project-wide rules from `stack-rules.md`. The loop's prompt says "apply the relevant rules from `stack-rules.md` to this task's Test-Gen Brief." Per-ticket application happens where per-ticket context lives.
- **Dispatcher policies enforce the rules at runtime.** `stack-rules.md` is also the source the policy reads to know what's required. When a Convex project's rule says "test files importing the runtime must use convex-test," the policy enforces that against test-gen's output. Same source of truth, different consumer.

This separation matters because **the rules are constant across the project; the application is per-ticket**. The expert shouldn't spend tokens trying to figure out which ticket needs which rule — that's wasted work and a place for under-attention. The compose-tickets agent has full per-ticket context and applies the rules where they fit.

The expert's product is short, declarative, and reusable. The compose-tickets agent's product is per-ticket and varied. Each does its own job.

**Why this fits v2 (not v3):** It's pure prompt-and-yaml change to `v2-epic-decomposition-mark1.yaml`. No engine work; no new primitives. Replace one expert node with three or four. Each new node uses the existing `command:` or inline `prompt:` shape. Half a day of work; immediate measurable improvement (every backend Convex task carries `convex-test` instead of one in nine).

**Risk:** the per-stack passes might over-author for tasks that don't touch their stack (a Convex expert adding Convex notes to a pure-frontend task). Mitigation: each pass's prompt explicitly says "skip tasks that don't touch your stack; leave their stack_practices unchanged."

---

_(append more v2 enhancements here as they're identified)_
