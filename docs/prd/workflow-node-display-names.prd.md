---
title: Workflow Node Display Names
status: draft
created: 2026-04-13
updated: 2026-04-13
---

# PRD: Workflow Node Display Names

## 1. Problem Statement

**Who has this problem:** Mase as the primary operator of Archon workflows, including
when running several workflows in parallel and needing to understand them quickly.
Secondary user: a technically capable observer who did not author the workflow — in
practice, future-Mase reviewing a completed run after some delay, or another observer
reviewing progress without deep knowledge of the workflow internals. They understand the
high-level goal but cannot be expected to decode raw YAML internals from the graph.

**What problem they face:** When opening the workflow execution graph today, node labels
are too generic or internal. For non-command nodes — loop, script, approval, bash,
prompt — the label shown is either the raw `node.id` (the machine identifier from the
YAML) or a hardcoded type string like "Prompt" or "Shell". Neither tells the observer
what the node *does* in this workflow. The pain is immediate: you can see nodes
executing but cannot tell what is happening or what each step's purpose is.

**Why it cannot be solved today by naming YAML better:** The display problem is not
purely about author discipline. Even with a descriptive `id`, the execution surface
does not reliably surface useful human-readable names for non-command nodes. Command
nodes get reasonable labels (the command name), but every other node type falls back
to the raw id or a hardcoded generic string. There is a structural gap: no schema
field exists to carry a human intent label distinct from the machine id, and no
inference logic exists to derive one from node content.

**Why now:** Archon workflows are in active daily use and this surfaced immediately as
a usability problem. Quick comprehension across multiple runs without reverse-engineering
node ids matters from the first day of use.

---

## 2. Evidence

- **Verified in code:** `dag-executor.ts` emits `nodeName: node.command ?? node.id`
  for command/prompt nodes and `node.id` for all other types (bash, script, loop,
  approval, cancel). Raw node id is the fallback for the majority of node types.
- **Verified in code:** `WorkflowCanvas.tsx` `resolveNodeLabel()` (line 25–29) only
  handles `'command'`, `'prompt'`, `'bash'`; returns hardcoded `'Prompt'` or `'Shell'`
  for non-command types. Loop, script, approval, cancel are not handled.
- **Verified in code:** `ExecutionDagNode.tsx` (line 59) renders `data.label` directly.
  For execution nodes, label is the same `data.label` field as the builder. Loop nodes
  only get a type badge `'LOOP'` with no descriptive label.
- **Verified in schema:** `packages/workflows/src/schemas/dag-node.ts` — no
  `display_name` field exists in any of the 7 node type schemas (CommandNode,
  PromptNode, BashNode, ScriptNode, LoopNode, ApprovalNode, CancelNode).
- **Verified in DB:** `migrations/012_workflow_events.sql` — `step_name` column stores
  `node.id`; no separate display label column in the events table.
- **Verified in events:** `event-emitter.ts` `NodeStartedEvent`, `NodeCompletedEvent`,
  `NodeFailedEvent`, `NodeSkippedEvent` all carry `nodeName` field; its value is
  populated by `dag-executor.ts` using the logic above.

---

## 3. Proposed Solution

Add an optional `display_name` field to the DAG node schema so workflow authors can
attach a human-readable label to any node. Wire that field through the execution event
pipeline and through the web UI graph components so both live and historical graph views
show the label. When `display_name` is absent, apply a resolution chain that infers a
meaningful label from available node content (phase 2) rather than falling back to the
raw id.

This extends existing primitives: the schema, event emitter, and graph components
already have the structural slots needed. No new tables, no new API endpoints, and no
changes to the `step_name` DB contract are required for the MVP.

---

## 4. Key Hypothesis

If workflow authors can optionally provide a `display_name` on any node, and the graph
view shows that name as the primary label, then operators and observers will be able to
understand what each node does without inspecting raw YAML or decoding internal ids.

The hypothesis is testable: after the change, open a workflow graph and ask whether
each node's label explains its purpose without additional context.

---

## 5. What We're NOT Building

- **Workflow Builder canvas changes.** The builder (`WorkflowBuilderPage`, `WorkflowCanvas.tsx`, `DagNodeComponent.tsx`) is phase 2. Phase 1 must not change builder rendering or editing behavior.
- **Non-graph execution surfaces.** The currently-executing banner, progress list, and log-derived step labels are phase 2. Phase 1 only changes labels on the execution graph node cards.
- **Database / event-contract changes.** `step_name` in `remote_agent_workflow_events`
  remains `node.id`. We do not add a `display_name` column to the events table. The
  display label is resolved at read/render time from the workflow definition, not stored
  in event history.
- **Sophisticated NLP inference.** Stripping boilerplate like "You are ..." or
  summarizing multi-paragraph prompts is out of scope for v1. Simple truncation only.
- **Retroactive relabeling of old runs.** Historical runs will benefit from inference
  fallbacks if the workflow YAML is still available, but there is no backfill job.
- **Per-platform display_name variants.** One label per node; no locale or platform
  override concept.
- **Approval / cancel node detailed labels** beyond what the display_name field or
  simple inference provides.

---

## 6. Success Metrics

**Primary (qualitative, operator-assessed):**
- When opening a workflow execution graph, every node has a label that explains its
  purpose without requiring the operator to inspect raw YAML or node ids.
- For workflows where `display_name` is set, no raw ids or generic hardcoded strings
  appear as primary labels.
- For workflows without `display_name`, the inferred label (phase 2) is more meaningful
  than the current fallback.

**Observable signal (phase 1):**
- 0 nodes in a display_name-annotated workflow show a raw `node.id` as their primary
  label in the execution graph.

**Observable signal (phase 2):**
- For prompt and loop nodes, the inferred label visibly reflects the intent from the
  first line of the prompt content (truncated to 80 chars), not "Prompt" or the node id.

---

## 7. Open Questions

| # | Question | Current Answer |
|---|----------|----------------|
| 1 | What truncation length for inferred labels? | 80 characters; adjust in a follow-on if needed. |
| 2 | Should boilerplate stripping be applied (e.g. "You are ...")? | No. Over-engineering for v1; skip. |
| 3 | How should loop nodes be labeled by inference? | Use the first 80 chars of `node.loop.prompt` (the inner prompt text). |
| 4 | How should script nodes be labeled by inference? | Use the script filename from `node.script` if it references a file, else first non-blank line. |
| 5 | Does `display_name` need to appear in Workflow Builder canvas? | Out of scope for this slice; follow-on. |
| 6 | Should `display_name` be stored in DB events for the observer path? | No — resolve at render time from the definition. Keeps DB contract clean. |

---

## 8. Users & Context

**Primary user:** Mase as Archon workflow operator. Runs workflows daily, sometimes
several in parallel. Needs quick comprehension of what is happening in any graph view,
including mid-run and post-run review after a delay.

**Secondary user:** Technically capable observer who did not author the workflow.
Understands the high-level goal. Should not need to know raw node ids or internal YAML
structure to read the graph.

**JTBD:**
> When I run an Archon workflow and open the graph view, I want to clearly understand
> what each node in the graph is doing or what its job is, so I can understand what the
> agent did or is doing — without decoding internal identifiers.

**Non-users / out of scope for this slice:**
- Non-technical stakeholders who need a narrative summary (not a graph)
- Workflow authors who want to edit display names in the builder canvas (follow-on)

---

## 9. Solution Detail

### MoSCoW Table

| Priority | Item | Notes |
|----------|------|-------|
| **Must** | `display_name?: string` field in `dagNodeSchema` | Optional; backward-compatible |
| **Must** | Execution graph node cards show `display_name` when present | Scope limited to graph node cards |
| **Must** | Execution graph shows meaningful static fallback labels for loop, script, approval, and cancel nodes | Keep this local to execution graph in phase 1 |
| **Should** | Inference fallback for prompt nodes: first 80 chars of `node.prompt` | Phase 2 |
| **Should** | Inference fallback for loop nodes: first 80 chars of `node.loop.prompt` | Phase 2 |
| **Should** | Inference fallback for bash nodes: first non-comment line of `node.bash` | Phase 2 |
| **Should** | Inference fallback for script nodes: filename or first non-blank line | Phase 2 |
| **Could** | Tooltip showing full prompt/script on hover when label is truncated | Phase 2 or 3 |
| **Won't** | Builder canvas display_name editing | Out of scope this slice |
| **Won't** | DB event contract changes | Out of scope |
| **Won't** | Boilerplate stripping from prompts | Over-engineering for v1 |

### MVP Definition

Phase 1 is the minimum viable increment:
1. Add `display_name?: string` to the schema.
2. Regenerate frontend API types so the web app receives the new field.
3. Resolve labels in the execution graph from the workflow definition, using `display_name` when present.
4. Keep simple static fallbacks for node kinds without `display_name`: command name, `Shell`, `Prompt`, `Loop`, `Script`, `Approval`, `Cancel`.

Phase 2 adds builder support, non-graph execution-surface updates, and optional inference so workflows without `display_name` still show more meaningful labels derived from content.

---

## 10. Technical Approach

All paths verified against the codebase at the time of writing.

### Schema Extension
**File:** `packages/workflows/src/schemas/dag-node.ts`

Add `display_name: z.string().optional()` to the shared `dagNodeBaseSchema` (the fields
common to all node types). This automatically makes it available on all 7 node type
schemas without touching each union branch. Because `dagNodeSchema` is a discriminated
union built on per-type schemas, the shared base approach is the lowest-change path.

Currently the schema has no `display_name` field. The `id` field is the stable
machine identifier and must not be changed or overloaded.

### Web UI — Execution Graph Label
**Primary files:** `packages/web/src/components/workflows/WorkflowDagViewer.tsx`, `packages/web/src/components/workflows/ExecutionDagNode.tsx`

Phase 1 should be execution-graph-only. The execution graph already receives the full workflow definition via `dagNodes`, so it can resolve a display label directly from the definition without changing workflow events, DB contracts, or non-graph execution surfaces.

Recommended phase-1 behavior:
- `display_name` wins when present
- otherwise use a simple static per-type fallback
- do not attempt prompt/script inference yet
- do not change builder rendering paths in this phase

Recommended execution-only resolver shape:
```typescript
function resolveExecutionNodeLabel(dn: DagNode): string {
  if (dn.display_name) return dn.display_name;
  if ('command' in dn && dn.command) return dn.command;
  if ('bash' in dn && dn.bash) return 'Shell';
  if ('loop' in dn && dn.loop) return 'Loop';
  if ('script' in dn && dn.script) return 'Script';
  if ('approval' in dn && dn.approval) return 'Approval';
  if ('cancel' in dn && dn.cancel) return 'Cancel';
  return 'Prompt';
}
```

`WorkflowDagViewer.tsx` can apply this resolver when building the execution node data from `dagNodes`.

`ExecutionDagNode.tsx` should be updated only as needed so the execution graph can show correct badges/colors for any newly distinguished node kinds used in phase 1.

### Builder Isolation
`packages/web/src/lib/dag-layout.ts` is shared by execution and builder loading. Because phase 1 must stay execution-only, avoid using a shared resolver there for this first slice. Keep builder rendering behavior unchanged until phase 2.

### DagNodeData Interface
**File:** `packages/web/src/components/workflows/DagNodeComponent.tsx`

If phase 1 keeps label resolution inside the execution graph path, builder-facing `DagNodeData` can stay unchanged. Only add new shared node-type values there in phase 1 if the execution implementation truly requires them. Prefer keeping this untouched until phase 2 if possible.

### Type Regeneration
**File:** `packages/web/src/lib/api.generated.d.ts`

After adding `display_name` to the schema and running the server, run:
```bash
bun --filter @archon/web generate:types
```
This regenerates `api.generated.d.ts` from the OpenAPI spec so the web package sees
the new field via `DagNode` from `@/lib/api`.

### Phase 2 — Inference Helpers
**New utility function** (suggest placing in `packages/workflows/src/utils/` or
inline in `dag-executor.ts`):

```typescript
function inferNodeLabel(node: DagNode, maxLen = 80): string {
  if (node.display_name) return node.display_name;
  if (node.command)      return node.command;
  if (node.prompt)       return node.prompt.slice(0, maxLen).trimEnd();
  if (node.loop?.prompt) return node.loop.prompt.slice(0, maxLen).trimEnd();
  if (node.bash)         return firstNonCommentLine(node.bash) ?? 'Shell';
  if (node.script)       return firstNonBlankLine(node.script) ?? 'Script';
  if (node.approval)     return node.approval.message?.slice(0, maxLen) ?? 'Approval';
  return node.id;
}
```

Apply in both `dag-executor.ts` (events) and the web UI label-building path.

### No DB or API Changes Required (Phase 1)
- `remote_agent_workflow_events.step_name` remains `node.id` — no migration needed in phase 1.
- No new API endpoints needed; `display_name` rides through the existing workflow definition returned by `GET /api/workflows/:name`.
- The existing `GET /api/workflows/:name` route already returns the full workflow definition including node fields, so `display_name` will be available in the response automatically after schema extension.
- Non-graph execution surfaces may still show raw ids after phase 1 because they are driven from workflow events, not from graph-definition label resolution. That is a deliberate phase-1 tradeoff.

---

## 11. Implementation Phases

### Phase 1 — Explicit display_name (MVP)

| # | Task | File(s) | Notes |
|---|------|---------|-------|
| 1.1 | Add `display_name?: string` to dagNodeBaseSchema | `packages/workflows/src/schemas/dag-node.ts` | Shared base; one change covers all types |
| 1.2 | Regenerate frontend API types | `packages/web/src/lib/api.generated.d.ts` | `bun --filter @archon/web generate:types` |
| 1.3 | Add execution-only label resolver using workflow definition | `packages/web/src/components/workflows/WorkflowDagViewer.tsx` | `display_name` first, then simple static fallback |
| 1.4 | Update execution node badges/colors only if needed for newly distinguished kinds | `packages/web/src/components/workflows/ExecutionDagNode.tsx` | Keep changes local to execution graph |
| 1.5 | Run `bun run validate` | All packages | type-check, lint, format, tests |

**Parallel opportunities in Phase 1:**
- Schema/type regeneration can proceed ahead of the execution-graph UI update, but the slice is small enough that sequential implementation is likely cleaner.

### Phase 2 — Inference Fallbacks

| # | Task | File(s) | Notes |
|---|------|---------|-------|
| 2.1 | Add builder compatibility for `display_name` and expanded node kinds | `packages/web/src/lib/dag-layout.ts`, `packages/web/src/components/workflows/DagNodeComponent.tsx`, builder surfaces | Shared builder/render path |
| 2.2 | Update non-graph execution surfaces to show display labels instead of raw ids | `packages/web/src/components/workflows/WorkflowExecution.tsx`, `DagNodeProgress.tsx`, `WorkflowLogs.tsx` | Currently executing banner, progress list, log labels |
| 2.3 | Decide whether to emit/persist display labels in events for better historical fidelity | executor/event/SSE/read models as needed | Optional, depends on how much post-hoc accuracy matters |
| 2.4 | Add simple inference fallback | shared helper + graph/render paths | 80-char truncation; no NLP |
| 2.5 | Optional: add truncation tooltip in ExecutionDagNode | `packages/web/src/components/workflows/ExecutionDagNode.tsx` | Show full text on hover |
| 2.6 | Run `bun run validate` | All packages | |

---

## 12. Decisions Log

| Decision | Rationale |
|----------|-----------|
| `display_name` is optional, not required | Backward-compatible; existing workflows continue to work unchanged |
| `step_name` in DB events stays as `node.id` | Preserves machine-stable identity for event correlation; display is a UI concern |
| Display label resolved at render time, not stored in events | Keeps DB contract clean; label can be updated by editing the workflow YAML without migrating historical data |
| Phase 1 skips inference | Reduces scope; explicit labeling is the highest-value unblocked step |
| Phase 1 is execution-graph-only | Keeps blast radius small and avoids shared builder/event paths |
| Builder canvas excluded from phase 1 | Separate creation surface; move to phase 2 with shared-rendering adjustments |
| Non-graph execution surfaces excluded from phase 1 | They depend on event-driven names and can be addressed coherently in phase 2 |
| Boilerplate stripping excluded | Over-engineering for v1; simple truncation at 80 chars is sufficient |
| `display_name` added to shared base schema, not per-type | One change covers all 7 node types; no per-type duplication |
| No new API endpoints needed | `display_name` rides through the existing workflow definition response |

---

## Validation Notes

**Validated against codebase at:** `packages/workflows/src/schemas/dag-node.ts`,
`packages/workflows/src/dag-executor.ts`, `packages/web/src/lib/dag-layout.ts`,
`packages/web/src/components/workflows/WorkflowDagViewer.tsx`,
`packages/web/src/components/workflows/ExecutionDagNode.tsx`,
`packages/web/src/components/workflows/DagNodeComponent.tsx`,
`packages/web/src/components/workflows/WorkflowCanvas.tsx`,
`packages/web/src/routes/WorkflowExecutionPage.tsx`,
`packages/workflows/src/schemas/loop.ts`,
`migrations/012_workflow_events.sql`

**Corrections made during validation:**

1. **Critical — wrong file for execution label building.** The PRD originally stated
   `WorkflowExecutionPage.tsx` constructs execution node labels. That page only renders
   `<WorkflowExecution>` (2 lines). Current execution labels come from shared web DAG
   helpers consumed by `WorkflowDagViewer.tsx`, but phase 1 was then narrowed further to
   avoid shared builder paths and keep label resolution local to the execution graph.

2. **`resolveNodeDisplay()` gap confirmed.** The function currently falls through loop,
   script, approval, cancel nodes to the `'Prompt'` branch — verified in source. This
   is the root cause of the display problem for those node types, but because the helper is shared with builder loading it should be handled in phase 2 unless phase 1 explicitly accepts builder impact.

3. **`loop.prompt` field name confirmed correct.** `loopNodeConfigSchema` in
   `packages/workflows/src/schemas/loop.ts` uses `prompt` as the field name. The
   inference reference `node.loop.prompt` in the PRD is accurate.

4. **`resolveNodeLabel()` in `WorkflowCanvas.tsx` is builder-only.** It is called only
   at lines 154 and 266 of `WorkflowCanvas.tsx` (drag-create paths). It is NOT used in
   the execution graph — `resolveNodeDisplay()` in `dag-layout.ts` is the execution
   path. PRD updated to clarify scope and defer builder changes.

5. **`dagNodeBaseSchema` name verified correct** at line 113 of `dag-node.ts`.

6. **`approval.message` field name verified correct** at line 249 of `dag-node.ts`.

7. **`packages/workflows/src/utils/` directory confirmed to exist** with existing
   utilities (variable-substitution, tool-formatter, idle-timeout). Phase 2 inference
   helper can be placed here.
