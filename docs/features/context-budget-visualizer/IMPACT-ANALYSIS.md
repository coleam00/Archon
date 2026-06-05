# Context Budget Visualizer — Codebase Impact Analysis & Implementation Plan

**Status:** Proposal / pre-implementation
**Branch:** `feature/context-budget-visualizer`
**Author:** (brainstorm session)
**Scope decision:** Full-picture **observability** (no new context-selection engine)

> This document is the PR-facing impact analysis. It records the design decisions,
> the exact code touch-points (with `file:line` evidence), the blast radius, the
> risks, and the verification strategy. The two `.claude/docs/` reference files
> (`00 - Archon Features Proposal.md`, `04 - Build a Context Budget Visualizer.md`)
> are local-only inputs and are intentionally **not** committed.

---

## 1. What we are (and are not) building

### 1.1 The architectural reality that shapes scope

The original proposal (doc 04) frames the feature like a RAG system: it assumes
Archon *pre-selects a bundle of files* (AGENTS.md, README, `src/auth/login.ts`,
`package-lock.json`, …) and injects them into each AI node, so the visualizer's job
is to show "which files we packed and which wasted space."

**Archon does not work this way.** Archon's providers wrap *agentic* SDKs
(Claude Code, Codex, Pi). Those agents read files **themselves at runtime** via their
own `Read`/`Grep`/`Bash` tools. Archon never assembles a file bundle and never injects
`package-lock.json` into a prompt. The declarative `context: include/exclude/budget`
layer the proposal leans on is a **different, unbuilt feature** (Proposal #3,
"declarative context engineering").

Consequently this feature is scoped as **observability of what already happens**, not
a budgeting/selection engine. We measure three layers:

| Layer | Definition | Pre/Post execution |
|---|---|---|
| **L1 — Static prompt** | The prompt Archon assembles and hands to the provider (command-file text + substituted variables + `$nodeId.output` + issue context + system prompt) | Pre-flight estimate |
| **L2 — Actual usage** | Real input/output/total tokens + USD cost the SDK reports back | Post-hoc (ground truth) |
| **L3 — Dynamic reads** | Files the agent actually read during the run (`Read`/`Grep`/`Edit`/`Bash` targets) | During run (reconstructed post-hoc) |

### 1.2 Locked design decisions

1. **Observability only**, with **advisory (non-blocking) warnings** that are
   **user-configurable** (enable/disable). No hard budget enforcement / no aborting runs.
2. **First surface (this PR):** Markdown artifact written to the run's artifacts dir
   **+** a CLI command. **Web UI panel is explicitly deferred to a sequential PR.**
3. **Verification:** deterministic golden-fixture test suite with assertions **and**
   a live-metrics signal over real runs (both, see §6).

---

## 2. Where the data already lives (evidence)

This is why the feature is low-impact: most of L2 and all of L3 already flow through
the existing event system.

### 2.1 L3 — Dynamic reads: **already fully persisted**

The executor already persists a `tool_called` workflow event carrying the tool's input
(which includes the file path for file tools):

- `packages/workflows/src/dag-executor.ts:853-861` (regular nodes) and `:2048-2053` (loops)
  ```ts
  deps.store.createWorkflowEvent({
    workflow_run_id: workflowRun.id,
    event_type: 'tool_called',
    step_name: node.id,
    data: { tool_name: msg.toolName, tool_input: msg.toolInput ?? {} },
  });
  ```
- The chunk shape guarantees `toolInput` is available:
  `packages/providers/src/types.ts:205-214` (`type: 'tool'` has `toolInput?: Record<string, unknown>`).

➡️ **No new instrumentation needed for L3.** The report builder reads `tool_called`
events for a run and extracts `tool_input.file_path` / `pattern` / `command`.

> Caveat: `tool_called` is **persisted** but is **not** part of the in-memory
> `WorkflowEmitterEvent` union (`event-emitter.ts:116-129` only defines
> `tool_started`/`tool_completed`, which omit input). That only matters for the
> later **live** Web UI; the post-hoc artifact/CLI report reads from the DB and is fine.

### 2.2 L2 — Actual usage: **captured in memory, dropped on persist**

- `TokenUsage` type: `packages/providers/src/types.ts:167-172` (`input`, `output`, `total?`, `cost?`).
- Captured per node: `packages/workflows/src/dag-executor.ts:903` → `if (msg.tokens) nodeTokens = msg.tokens;`
- **Gap:** the persisted `node_completed` event omits the token counts —
  `packages/workflows/src/dag-executor.ts:1187-1194` persists `duration_ms`, `node_output`,
  `cost_usd`, `stop_reason`, `num_turns`, `model_usage` but **not** `nodeTokens`.

➡️ **One additive change for L2:** include `nodeTokens` in the persisted `node_completed`
`data`. Backward-compatible (new optional key in a free-form record).

### 2.3 L1 — Static prompt estimate: the only genuinely new measurement

- The final prompt is assembled then sent at `packages/workflows/src/dag-executor.ts:724`:
  ```ts
  aiClient.sendQuery(finalPrompt, cwd, resumeSessionId, nodeOptionsWithAbort)
  ```
  (loop variant at `:1906`). `finalPrompt` is produced by `buildPromptWithContext(...)`
  (`executor-shared.ts:472-498`) + `substituteNodeOutputRefs(...)`.

➡️ **New work for L1:** a token-estimator util applied to `finalPrompt` (and the resolved
system prompt), emitted as a new `context_budget_computed` event right before the
`sendQuery` call.

### 2.4 Event system imposes **no schema cost**

- `packages/core/src/schemas/workflow-event.ts:10-18`: `event_type` is `z.string()` and
  `data` is `z.record(z.string(), z.unknown())`. New event types and new `data` keys
  require **no migration and no schema edit**.
- Store write path: `IWorkflowStore.createWorkflowEvent(...)` (`packages/workflows/src/store.ts`).

---

## 3. Codebase Impact Analysis (blast radius)

Legend: 🟢 additive/new file · 🟡 additive edit to existing file · 🔴 behavior change.
There are **no 🔴 changes** — nothing alters existing execution behavior.

### 3.1 `@archon/workflows`

| File | Change | Type |
|---|---|---|
| `src/utils/token-estimate.ts` *(new)* | `estimateTokens(text): number` (chars/4 heuristic) + `classifyContextSource(...)` | 🟢 |
| `src/context-budget/report-builder.ts` *(new)* | Pure function: `buildContextBudgetReport(events, config) → ContextBudgetReport`. Reads `node_completed` (L2) + `tool_called` (L3) + `context_budget_computed` (L1) events. | 🟢 |
| `src/context-budget/report-markdown.ts` *(new)* | `renderReportMarkdown(report) → string` for the artifact | 🟢 |
| `src/schemas/context-budget.ts` *(new)* | `contextBudgetReportSchema`, `contextBudgetItemSchema`, `contextBudgetWarningSchema` (+ re-export from `schemas/index.ts`) | 🟢 |
| `src/schemas/dag-node.ts` | Add optional `contextBudget` block to `dagNodeBaseSchema` (~line 180, after `maxBudgetUsd`) | 🟡 |
| `src/schemas/workflow.ts` | Add optional workflow-level `contextBudget` to `workflowBaseSchema` (~line 93, after `persist_sessions`) | 🟡 |
| `src/event-emitter.ts` | Add `ContextBudgetComputedEvent` to the union (~line 145) for future live use | 🟡 |
| `src/dag-executor.ts` | (a) Add `tokens` to `node_completed` `data` at `:1187`. (b) Before `sendQuery` at `:724` (+ loop `:1906`): estimate prompt, emit `context_budget_computed`. (c) On run completion, write the Markdown artifact. | 🟡 |

### 3.2 `@archon/core`

| File | Change | Type |
|---|---|---|
| `src/operations/workflow-operations.ts` | New `getContextBudgetReport(runId)` reading events via the store, delegating to the pure builder | 🟡/🟢 |

(No DB migration. No new tables — Option A from the proposal: ride existing workflow events.)

### 3.3 `@archon/cli`

| File | Change | Type |
|---|---|---|
| `src/commands/workflow.ts` | New subcommand `archon workflow context <run-id>` (+ `--json`), reusing `get/status/runs` plumbing | 🟡 |

### 3.4 Defaults / fixtures

| File | Change | Type |
|---|---|---|
| `.archon/workflows/defaults/...` | (Optional) none required for MVP | — |
| `examples/context-budget-demo/` *(new)* | Golden demo fixture repo + workflow for the verification harness (§6) | 🟢 |

### 3.5 Explicitly **out of scope** for this PR (sequential PRs)

- Web UI Context Budget panel (`packages/web`, `packages/server` web adapter, SSE wiring,
  enriching emitter `tool_*` events with input). Tracked as **PR-2**.
- Relevance scoring / "high/medium/low value" semantic judgement.
- Declarative `context: include/exclude` selection engine (Proposal #3).
- Dedicated `remote_agent_context_*` tables (Option B) — only if analytics demand it later.

---

## 4. Proposed schema / config additions

All optional; absence preserves today's behavior exactly.

```yaml
# workflow-level (defaults for all nodes)
name: archon-bugfix
contextBudget:
  enabled: true            # master switch for measurement + report
  maxTokens: 40000         # advisory ceiling for warnings (not enforced)
  warnAtPercent: 80        # emit advisory warning at/above this fraction
  warnOnLowValueReads: true # warn when lockfiles/generated files are read

nodes:
  - id: implement
    command: implement-issue
    contextBudget:
      maxTokens: 50000     # per-node override
```

- `enabled` defaults to **true** for measurement (cheap, additive) but warnings honor
  `warnAtPercent`/`warnOnLowValueReads`. A global off-switch (`enabled: false`) skips the
  estimate+event entirely for users who want zero overhead.
- Node-level overrides win over workflow-level (same precedence pattern as
  `persist_session` vs `persist_sessions`).

---

## 5. Data model (report shape)

```ts
type ContextBudgetItem = {
  nodeId: string;
  layer: 'static-prompt' | 'actual-usage' | 'dynamic-read';
  sourceType: 'command-file' | 'variable' | 'node-output' | 'issue-context'
            | 'system-prompt' | 'file-read' | 'grep' | 'bash' | 'usage';
  label: string;            // e.g. 'src/auth/login.ts' or 'implement node prompt'
  estimatedTokens?: number; // L1/L3 (estimated)
  actualTokens?: number;    // L2 (ground truth)
  detail?: string;          // path / pattern / command
};

type ContextBudgetWarning = {
  nodeId: string;
  code: 'over_budget' | 'low_value_read' | 'no_test_context';
  message: string;
};

type ContextBudgetReport = {
  workflowRunId: string;
  nodes: Array<{
    nodeId: string;
    budgetTokens?: number;
    estimatedPromptTokens: number;  // L1
    actualTokens?: TokenUsage;      // L2
    reads: ContextBudgetItem[];     // L3
    warnings: ContextBudgetWarning[];
  }>;
  totals: { estimatedPromptTokens: number; actualTokens?: number; costUsd?: number };
};
```

---

## 6. Verification strategy (how we prove it works *and* is effective)

Two complementary mechanisms, per the decision.

### 6.1 Deterministic golden-fixture suite (correctness guardrail)

A committed demo repo (`examples/context-budget-demo/`) with intentionally useful and
noisy files (per doc 04 §"Demo setup"). Tests assert the *measurement plumbing*
without invoking a real model:

- **T1 — estimator unit test:** `estimateTokens("x".repeat(4000)) ≈ 1000` (±tolerance).
- **T2 — report builder from synthetic events:** feed a known array of `node_completed`
  + `tool_called` + `context_budget_computed` events → assert exact per-node and total
  numbers, item classification, and warning codes. (Pure function, no DB, no model — fast.)
- **T3 — dynamic-read reconstruction:** given `tool_called` events with
  `tool_input.file_path = src/auth/login.ts`, assert it appears as an L3 `file-read` item.
- **T4 — warning thresholds:** `maxTokens: 10000`, measured 8500, `warnAtPercent: 80`
  → assert one `over_budget` warning; below threshold → none.
- **T5 — low-value detection:** a `Read` of `package-lock.json` with
  `warnOnLowValueReads: true` → assert `low_value_read` warning; disabled → none.
- **T6 — markdown render snapshot:** stable Markdown artifact for a fixed report.
- **T7 — config off-switch:** `contextBudget.enabled: false` → no `context_budget_computed`
  event emitted, no artifact written, execution otherwise identical.

These run in CI (`bun run test`) and lock the numbers against regression.

### 6.2 Live-metrics signal over real runs (effectiveness)

Beyond "does it compute right," we want evidence the visibility **changes behavior**.
A small, scriptable harness (runnable locally / optionally in CI-nightly) that executes
the demo workflow against a real provider twice and compares the emitted reports:

- **Run A (noisy):** task that tempts the agent to read junk (large lockfile present, no
  exclusion guidance). Capture report.
- **Run B (guided):** same task after adding AGENTS.md guidance / `.gitignore`-style hints
  steering the agent away from junk. Capture report.
- **Assert the effectiveness deltas** (the metrics table from doc 04 §"How we test"):

  | Metric | Direction |
  |---|---|
  | Low-value file reads (lockfile/generated) | ↓ |
  | Related-test reads | ↑ (present) |
  | `over_budget` / `low_value_read` warnings | ↓ |
  | Actual input tokens for the node | ↓ |

  The harness writes a `before/after` comparison Markdown (the demo artifact in doc 04
  §"Demo before/after comparison") so a human can eyeball the improvement, and emits a
  machine-readable JSON the test can assert trend direction on.

> Because real-model runs are non-deterministic, §6.2 asserts **trend direction with
> tolerance**, not exact counts, and is gated/optional so it never flakes the core PR CI.
> §6.1 is the hard gate.

---

## 7. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Estimator (chars/4) diverges from real tokenization | Label L1 explicitly as *estimate*; show L2 *actual* side-by-side. Provider-specific tokenizers are a later enhancement. |
| `tool_input` shape varies by tool/provider | Extract defensively (`file_path` for Read/Edit, `pattern` for Grep, `command` for Bash); unknown tools fall back to `tool_name` only. |
| Report builder reads large event sets | Pure, in-memory aggregation per run; runs are bounded. Stream/paginate only if needed. |
| Scope creep toward Proposal #3 | This PR is observability-only; selection engine is a separate, separately-approved effort. |
| Overhead on every run | `contextBudget.enabled: false` cleanly disables L1 emit + artifact (T7). |
| Free-form `data` blobs grow | Acceptable for MVP (Option A). Revisit dedicated tables only if querying/analytics demand it. |

---

## 8. Suggested implementation order (small, reviewable commits)

1. `token-estimate.ts` util + **T1**.
2. `schemas/context-budget.ts` (report types) + node/workflow `contextBudget` schema fields.
3. `report-builder.ts` pure function + **T2/T3/T4/T5**.
4. `report-markdown.ts` + **T6**.
5. Persist `tokens` in `node_completed` (`dag-executor.ts:1187`).
6. Emit `context_budget_computed` before `sendQuery` (`:724`, `:1906`) + emitter union type + **T7**.
7. Write Markdown artifact on run completion.
8. `getContextBudgetReport` core op + `archon workflow context <run-id>` CLI (+ `--json`).
9. `examples/context-budget-demo/` fixture + live-metrics harness (§6.2).
10. `bun run validate` green; update docs.

Each step is independently revertable; no step changes existing execution behavior.
