# PRD — Context Budget Visualizer (Observability)

**Project:** Archon — Remote Agentic Coding Platform
**Feature branch:** `feature/context-budget-visualizer`
**Status:** Draft for review (pre-implementation)
**Date:** 2026-06-05
**Companion doc:** [`IMPACT-ANALYSIS.md`](./IMPACT-ANALYSIS.md) (codebase touch-points, blast radius, commit order)
**Local-only inputs (not committed):** `.claude/docs/00 - Archon Features Proposal.md`, `.claude/docs/04 - Build a Context Budget Visualizer.md`

---

## 1. Executive Summary

Archon makes AI coding **workflows** repeatable, but the **information** each AI node actually works from is invisible. When an agent succeeds or fails, a developer cannot see what the agent was given, what it read, how many tokens it burned, or whether attention was spent on the right things. Output is visible; inputs are not.

The **Context Budget Visualizer** is a context-observability layer — a "nutrition label" for each workflow run's AI nodes. For every run it produces a report showing three layers: (L1) an **estimate of the prompt Archon assembled** before calling the provider, (L2) the **actual token usage and cost** the provider reported back, and (L3) the **files the agent actually read** during the run. It surfaces this as a Markdown artifact and a CLI command, raises **advisory, user-configurable warnings** (e.g. a lockfile was read, a node exceeded its declared token ceiling), and never alters execution.

Critically, this is a **low-blast-radius, additive** feature: ~90% of the required data already flows through Archon's existing workflow-event system. L3 is already persisted (`tool_called` events), L2 is already captured in memory (one line to persist), and the event schema accepts new event types with no migration. The MVP goal is to give developers and operators **visibility into agent inputs** so they can build trust and improve their workflows — without building the (separate, unbuilt) declarative context-selection engine.

---

## 2. Mission

**Mission:** Make the information an AI agent received before it acted as visible and inspectable as the work it produced — so humans can trust, debug, and improve agentic workflows.

**Core principles:**
1. **Observe, don't enforce.** Surface what happened; never change execution behavior or block runs.
2. **Truth over estimates.** Show provider-reported ground truth (actual tokens/cost) alongside, and clearly distinguished from, heuristic estimates.
3. **Ride existing rails.** Reuse Archon's workflow events, artifacts, and CLI patterns; avoid new subsystems, tables, and migrations until proven necessary.
4. **Honest to the architecture.** Archon's agents read files themselves; the visualizer reflects that reality rather than pretending Archon pre-bundles context.
5. **Opt-in cost, zero-cost off.** Measurement is cheap and on by default, but fully disableable with no residual overhead.

---

## 3. Target Users

**Primary persona — the AI-assisted developer (workflow author/operator).**
- Technical comfort: high (writes YAML workflows, runs the CLI, reads diffs).
- Needs: understand why a workflow run behaved as it did; confirm the agent looked at the right files and instructions; catch wasted context (junk reads, oversized prompts); iterate on workflow design with evidence.
- Pain points today: agent inputs are a black box; "I fixed it" with no visibility into what was consulted; no signal when a run quietly read a 10k-token lockfile.

**Secondary persona — the reviewer / team lead.**
- Technical comfort: medium-high.
- Needs: attach a context report to a PR as evidence; spot-check that sensitive or irrelevant files weren't pulled into agent attention; compare runs.
- Pain points: trusting agent output without seeing agent inputs; no audit trail of what informed a change.

**Tertiary persona — the non-programmer stakeholder.**
- Technical comfort: low.
- Needs: a plain answer to "did the AI look at the right stuff and follow the repo rules?"
- Pain points: cannot evaluate agent trustworthiness from output alone.

---

## 4. MVP Scope

### In Scope

**Core functionality**
- ✅ L1 — Pre-flight estimate of the assembled prompt (command/prompt text + substituted variables + `$nodeId.output` + issue context + system prompt) per AI node.
- ✅ L2 — Persist and report actual provider token usage (`input`/`output`/`total`) and USD cost per node.
- ✅ L3 — Reconstruct files the agent read (Read/Edit/Grep targets, Bash commands) from existing `tool_called` events.
- ✅ Per-node and per-run roll-up totals (estimated prompt tokens, actual tokens, cost).
- ✅ Advisory, user-configurable warnings: over declared token ceiling, low-value read (lockfile/generated file), missing expected context (heuristic).

**Technical**
- ✅ Token-estimator utility (chars/4 heuristic), clearly labeled as an estimate.
- ✅ New `context_budget_computed` workflow event (no DB migration; rides free-form `data`).
- ✅ Optional `contextBudget` config block at workflow and node level (backward compatible; absence = today's behavior).
- ✅ Pure, testable report-builder function (events → `ContextBudgetReport`).

**Integration / surfaces**
- ✅ Markdown report written to the run's artifacts directory.
- ✅ CLI command `archon workflow context <run-id>` (with `--json`).

**Verification**
- ✅ Deterministic golden-fixture unit suite (estimator, builder, classification, warnings, off-switch).
- ✅ Live before/after metrics harness (real-run effectiveness signal).

### Out of Scope (deferred)

**Follow-up PR (PR-2)**
- ❌ Web UI Context Budget panel (run-detail tab, SSE wiring, enriching emitter `tool_*` events with input).

**Later phases / separate efforts**
- ❌ Declarative context-selection engine (`context: include/exclude/budget`) — this is Proposal #3, a different feature.
- ❌ Hard budget **enforcement** (failing/aborting a node when over budget).
- ❌ Semantic **relevance scoring** ("high/medium/low value" via model judgement).
- ❌ Provider-exact tokenizers (per-model BPE counting).
- ❌ Dedicated `remote_agent_context_*` tables / analytics warehouse (Option B).
- ❌ Cross-run historical dashboards, context diffing, and context replay.

---

## 5. User Stories

1. **As a workflow author, I want** to see how many tokens each node's prompt and actual run consumed, **so that** I can find bloated nodes and tighten them.
   *Example:* `archon workflow context run_abc` shows `implement` used 34k actual tokens vs `plan` at 12k.

2. **As a developer debugging a bad run, I want** to see which files the agent actually read, **so that** I can tell whether it missed the relevant source or test file.
   *Example:* The report lists `src/auth/login.ts` and `tests/auth/login.test.ts` were read — confirming the agent had the right context.

3. **As a developer, I want** a warning when the agent reads a low-value file like `package-lock.json`, **so that** I can adjust repo guidance (AGENTS.md / ignores) to steer it away.
   *Example:* Report warns: `low_value_read: package-lock.json (≈10,800 tokens)`.

4. **As a reviewer, I want** a Markdown context report attached to the run's artifacts, **so that** I can include it in a PR as evidence of what informed the change.
   *Example:* `artifacts/.../context-budget-report.md` is opened and pasted into the PR description.

5. **As an operator, I want** to toggle context measurement and warnings on/off per workflow, **so that** I control overhead and noise.
   *Example:* `contextBudget: { enabled: false }` disables emission entirely for a hot-path workflow.

6. **As a workflow author, I want** to set an advisory token ceiling per node, **so that** I get a heads-up when a node trends oversized without my run being blocked.
   *Example:* `implement` node with `contextBudget.maxTokens: 50000` warns at 80%.

7. **As a non-programmer stakeholder, I want** a plain-language summary of whether the agent followed repo rules and looked at relevant files, **so that** I can gauge trust.
   *Example:* Report "Summary" line: "Read 4 relevant source/test files, followed AGENTS.md, no junk reads. Status: Healthy."

8. **(Technical) As a maintainer, I want** the report-builder to be a pure function over events, **so that** I can unit-test exact numbers without a live model or DB.

---

## 6. Core Architecture & Patterns

**High-level approach:** A measurement step and a post-hoc report builder layered onto Archon's existing DAG executor and workflow-event system. No changes to provider internals or execution semantics.

```
Workflow run
  ├── (per AI node) build finalPrompt ──► estimateTokens ──► emit context_budget_computed (L1)
  │                                         │
  │                                         └──► aiClient.sendQuery(...)  [unchanged]
  ├── (per AI node) result chunk ──► persist tokens in node_completed (L2)
  ├── (during run)  tool_called events already persisted (L3)
  └── (on completion) buildContextBudgetReport(events) ──► Markdown artifact
                                            │
                              CLI: archon workflow context <run-id>
                                            │
                              (PR-2) Web UI panel reads same report
```

**Directory structure (new/changed):**
```
packages/workflows/src/
  utils/token-estimate.ts            (new)  estimateTokens + source classification
  context-budget/
    report-builder.ts                (new)  pure: events → ContextBudgetReport
    report-markdown.ts               (new)  report → Markdown
  schemas/context-budget.ts          (new)  zod report/item/warning + config schemas
  schemas/dag-node.ts                (edit) + optional node-level contextBudget
  schemas/workflow.ts                (edit) + optional workflow-level contextBudget
  event-emitter.ts                   (edit) + ContextBudgetComputedEvent (for PR-2 live use)
  dag-executor.ts                    (edit) emit L1 event; persist L2 tokens; write artifact
packages/core/src/operations/
  workflow-operations.ts             (edit) getContextBudgetReport(runId)
packages/cli/src/commands/
  workflow.ts                        (edit) `workflow context` subcommand
examples/context-budget-demo/        (new)  golden fixture + live harness
docs/features/context-budget-visualizer/
  PRD.md, IMPACT-ANALYSIS.md         (docs)
```

**Key patterns (project-aligned):**
- **Zod-first types:** all new shapes are zod schemas with `z.infer`; schemas live under `packages/workflows/src/schemas/` per CLAUDE.md.
- **Free-form events, no migration:** new `event_type` strings + `data` keys ride `workflowEventRowSchema` (`event_type: z.string()`, `data: z.record(...)`).
- **Pure core / impure edges:** report computation is a pure function; I/O (event reads, artifact writes, CLI printing) lives at the edges.
- **Additive precedence:** node-level `contextBudget` overrides workflow-level (mirrors `persist_session` vs `persist_sessions`).
- **Fail-soft observability:** measurement/persist failures are logged and swallowed (fire-and-forget), never breaking a run — consistent with existing event persistence.

---

## 7. Features

### 7.1 Token estimator (`estimateTokens`)
- **Purpose:** approximate token count of arbitrary text pre-execution.
- **Behavior:** chars/4 heuristic; deterministic; labeled "estimate" everywhere it surfaces.
- **Non-goals:** model-exact tokenization (later enhancement).

### 7.2 Context source classification
- **Purpose:** tag each context item by layer and source type.
- **Operations:** map `tool_called.tool_name` → source type (`Read`/`Edit`→`file-read`, `Grep`→`grep`, `Bash`→`bash`); map prompt/system/issue/output → L1 source types; mark low-value paths (`*.lock`, `*-lock.json`, generated dirs) for warnings.

### 7.3 Report builder (`buildContextBudgetReport`)
- **Purpose:** pure aggregation of a run's events into the report data model.
- **Inputs:** array of workflow events for a run + resolved `contextBudget` config.
- **Outputs:** `ContextBudgetReport` (per-node L1/L2/L3 + warnings + totals).
- **Key feature:** fully unit-testable from synthetic events.

### 7.4 Markdown renderer + artifact
- **Purpose:** human-readable report persisted to the run artifacts dir.
- **Output:** `context-budget-report.md` (summary, per-node tables, warnings, recommendations).

### 7.5 CLI command `archon workflow context <run-id>`
- **Purpose:** terminal-native view of the report.
- **Features:** pretty table by default; `--json` for machine-readable output; reuses existing `get/status/runs` plumbing and cwd-scoping.

### 7.6 Advisory warnings (configurable)
- **Codes:** `over_budget` (≥ `warnAtPercent` of `maxTokens`), `low_value_read`, `no_test_context`.
- **Control:** `contextBudget.enabled`, `warnAtPercent`, `warnOnLowValueReads`. All advisory; none block.

---

## 8. Technology Stack

- **Runtime / language:** Bun + TypeScript (strict), per repo standard.
- **Validation:** `@hono/zod-openapi` zod schemas (`z.infer` derivation).
- **Logging:** `@archon/paths` Pino logger (`createLogger`), event naming `{domain}.{action}_{state}`.
- **Persistence:** existing `IWorkflowStore.createWorkflowEvent` over SQLite/PostgreSQL adapters (no new tables, no migration).
- **CLI:** existing `@archon/cli` command framework in `packages/cli/src/commands/workflow.ts`.
- **Providers:** unchanged; consume `TokenUsage` from the existing `MessageChunk` `result` variant (`@archon/providers`).
- **Testing:** `bun test` (per-package isolation per CLAUDE.md), pure-function fixtures + snapshot for Markdown.
- **Dependencies added:** none required for MVP (estimator is heuristic, no tokenizer lib).

---

## 9. Security & Configuration

**Configuration (`.archon/workflows/*.yaml`):**
```yaml
contextBudget:          # workflow-level defaults (all optional)
  enabled: true         # master switch for measurement + report
  maxTokens: 40000      # advisory ceiling for warnings (NOT enforced)
  warnAtPercent: 80
  warnOnLowValueReads: true
nodes:
  - id: implement
    contextBudget:
      maxTokens: 50000  # per-node override
```
- Absent block ⇒ identical to current behavior. `enabled: false` ⇒ no L1 emission, no artifact, zero overhead.

**Security scope:**
- **In scope:** the report records file *paths* the agent read and token *counts* — metadata already present in persisted `tool_called` events. No new data classes are collected.
- **Out of scope / explicitly avoided:** the report does **not** capture file *contents*, prompt *text bodies*, secrets, or environment values. Per CLAUDE.md logging rules, never log tokens/keys/PII; warnings reference paths and sizes only.
- **No new exposure surface:** no new HTTP endpoints in this PR (CLI + artifact only). The Web UI/API surface is PR-2 and will reuse existing authenticated run-detail routes.
- **Reversibility:** every change is additive and revertable; no execution path is altered.

---

## 10. API Specification

**No new HTTP API in MVP.** Surfaces are CLI + artifact file.

CLI contract:
```
archon workflow context <run-id> [--json]
```
- **Default output:** human table (per-node budget/used/remaining, top reads, warnings).
- **`--json` output:** the `ContextBudgetReport` object (see §11 data model in IMPACT-ANALYSIS).

**PR-2 (deferred) — anticipated API:** `GET /api/runs/:runId/context-budget` returning the same report JSON, consumed by the Web UI panel. Documented here only to keep the data model forward-compatible.

---

## 11. Success Criteria

**MVP is successful when** a developer can run any workflow and, afterward, see a truthful per-node breakdown of estimated prompt size, actual token/cost usage, and files the agent read — via both a CLI command and a Markdown artifact — with advisory warnings they can toggle, and when an automated test suite locks those numbers against regression.

**Functional requirements:**
- ✅ Running an AI node emits a `context_budget_computed` event with an L1 estimate (when enabled).
- ✅ `node_completed` events persist actual `tokens` (L2).
- ✅ The report reconstructs L3 reads from `tool_called` events including file paths.
- ✅ `archon workflow context <run-id>` prints a correct per-node + total report; `--json` matches schema.
- ✅ A `context-budget-report.md` artifact is written on run completion.
- ✅ Warnings fire per config thresholds; `enabled: false` suppresses all measurement/output.
- ✅ No change to existing run behavior; all current tests still pass; `bun run validate` green.

**Quality indicators:**
- Report-builder is a pure function with ≥ the 7 golden tests passing (T1–T7).
- Estimator within reasonable tolerance of expected heuristic on fixtures.
- Zero new ESLint warnings (CI `--max-warnings 0`), full type-checks, formatted.

**User-experience goals:**
- A non-programmer can read the report summary and answer "did it look at the right stuff?"
- A developer can act on a warning (e.g. exclude a lockfile via guidance) in one iteration.

---

## 12. Implementation Phases

### Phase 1 — Measurement primitives (foundation)
- **Goal:** the pure, testable core with no execution-path changes.
- **Deliverables:**
  - ✅ `token-estimate.ts` util + classification.
  - ✅ `schemas/context-budget.ts` (report/item/warning + config schemas).
  - ✅ `contextBudget` fields on node + workflow schemas.
  - ✅ `report-builder.ts` + `report-markdown.ts`.
- **Validation:** unit tests T1–T6 pass; no behavior change anywhere.

### Phase 2 — Wire into execution (additive)
- **Goal:** capture the three layers during real runs.
- **Deliverables:**
  - ✅ Persist `tokens` in `node_completed` (`dag-executor.ts`).
  - ✅ Emit `context_budget_computed` before `sendQuery` (regular + loop paths) + emitter union type.
  - ✅ Write the Markdown artifact on run completion.
  - ✅ Honor `contextBudget.enabled` off-switch.
- **Validation:** T7 (off-switch) passes; manual run produces an artifact; existing tests unaffected.

### Phase 3 — CLI surface
- **Goal:** developer-facing read path.
- **Deliverables:**
  - ✅ `getContextBudgetReport(runId)` core op.
  - ✅ `archon workflow context <run-id>` (+ `--json`).
- **Validation:** command output matches builder output on a recorded run; `--json` validates against schema.

### Phase 4 — Verification harness & docs
- **Goal:** prove correctness and effectiveness.
- **Deliverables:**
  - ✅ `examples/context-budget-demo/` golden fixture (useful + noisy files + workflow).
  - ✅ Live before/after metrics harness (noisy vs guided run, trend-delta assertions).
  - ✅ Docs updated; `bun run validate` green; PR with Impact Analysis + PRD.
- **Validation:** golden suite is a CI hard gate; live harness produces a before/after comparison report.

*(Web UI panel = separate PR-2, not part of this timeline.)*

---

## 13. Future Considerations

- **Web UI Context Budget panel (PR-2):** run-detail tab with budget bars, per-node breakdown, warnings; requires enriching live emitter `tool_*` events with input.
- **Provider-exact tokenizers:** replace chars/4 with per-model counting for tighter L1 estimates.
- **Relevance scoring:** model- or heuristic-based "value" rating per context item.
- **Historical analytics:** dedicated tables (Option B), cross-run comparison, context diffing, "successful vs failed run" context contrast.
- **Context replay:** re-run a node with an identical captured context snapshot.
- **Bridge to Proposal #3:** once a declarative selection engine exists, the visualizer becomes its feedback loop (define rules → run → visualize → refine).
- **Soft enforcement modes:** optional warn-louder / require-ack gates (still short of hard aborts).

---

## 14. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| **Estimator inaccuracy** (chars/4 ≠ real tokens) misleads users | Always label L1 as *estimate* and display L2 *actual* beside it; estimator is for relative/triage signal, not billing. Provider tokenizers are a documented later enhancement. |
| **`tool_input` shape varies** across tools/providers, breaking L3 extraction | Defensive extraction with per-tool keys (`file_path`, `pattern`, `command`) and a `tool_name`-only fallback; unit test against fixtures of each shape. |
| **Scope creep into Proposal #3** (selection engine) | PRD explicitly bounds MVP to observability; selection engine is called out as separate and out of scope in §4. |
| **Per-run overhead / event-blob growth** | Off-switch (`enabled: false`); fire-and-forget persistence; Option A (events) for MVP, dedicated tables only if analytics demand it. |
| **Live verification flakiness** (non-deterministic model runs) | Golden-fixture suite (synthetic events) is the CI hard gate; live before/after harness asserts *trend direction with tolerance* and is gated/optional. |
| **Silent failure of measurement** masking real issues | Log measurement/persist errors via Pino (`context_budget.*_failed`); never swallow without a logged warning, per CLAUDE.md fail-fast/observability rules. |

---

## 15. Appendix

**Related documents**
- [`IMPACT-ANALYSIS.md`](./IMPACT-ANALYSIS.md) — exact `file:line` touch-points, blast-radius table, report data model, 10-step commit order.
- Local-only inputs (not committed): `.claude/docs/00 - Archon Features Proposal.md`, `.claude/docs/04 - Build a Context Budget Visualizer.md`.

**Key code anchors (evidence)**
- Prompt assembly: `packages/workflows/src/executor-shared.ts:392,472`.
- Provider call site: `packages/workflows/src/dag-executor.ts:724` (loop `:1906`).
- Actual tokens captured / dropped: `dag-executor.ts:903` / persisted payload `:1187-1194`.
- L3 already persisted: `dag-executor.ts:853-861`, `:2048-2053`; chunk shape `packages/providers/src/types.ts:205-214`; `TokenUsage` `:167-172`.
- Event schema (no migration): `packages/core/src/schemas/workflow-event.ts:10-18`.
- Node/workflow schemas: `packages/workflows/src/schemas/dag-node.ts`, `schemas/workflow.ts`.
- CLI commands: `packages/cli/src/commands/workflow.ts`.

**Confirmed decisions** *(accepted by product owner, 2026-06-05)*
- D1: Token measurement defaults **on** (`enabled: true`); overhead is negligible and warnings honor thresholds. Users opt out via `enabled: false`.
- D2: Low-value path patterns are **hard-coded** for MVP (`*.lock`, `*-lock.json`, common generated dirs). Making them user-configurable is deferred to a later phase.
- D3: **One** context-budget report artifact per run (covering all nodes), not per-node files.
- D4: The `no_test_context` warning **is included** in MVP as a best-effort heuristic; revisit (tune or drop) if it proves noisy in the live harness.
