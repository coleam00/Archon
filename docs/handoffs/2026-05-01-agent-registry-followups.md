# Handoff — agent-registry follow-ups

_Created 2026-05-01 by the agent-registry session._

This document hands off two pieces of work that were intentionally deferred from the agent-registry implementation. They are independent; either can be picked up alone in a fresh session.

---

## 1. Workflow Builder rewrite — vertical step chain on dot-grid canvas

### Why it was deferred

The agent-registry session approved a **full rewrite** of the workflow builder UI (per the plan at `~/.claude/plans/ok-lets-update-the-cached-fox.md`, "Workflow scope: Full rewrite to dot-grid step chain"). The current builder uses `@xyflow/react` and the rewrite swaps it for a vertical step chain over a dot-grid background, matching the Bridges design at `/tmp/agent-registry-design/skill-editor/project/Workflow Registry.html` (the design bundle from `https://api.anthropic.com/v1/design/h/5bzHRRFHrIvf6uJnNg0bCA`).

The session shipped the **integration point** — `agent_ref` picker in the existing NodeInspector — but the canvas rewrite itself spans roughly 25k lines of existing code (`WorkflowBuilder.tsx`, `WorkflowCanvas.tsx`, `DagNodeComponent.tsx`, `ExecutionDagNode.tsx`, `NodeInspector.tsx`) and is genuinely a separate effort. Squeezing it in would have produced a half-working canvas.

### What is already true

These pieces of the larger plan are merged on this branch and need no rework:

- `agent_ref?: string` field on the DAG node schema (`packages/workflows/src/schemas/dag-node.ts:151–169`).
- Loader-side validator hard-fails on missing agent files (`packages/workflows/src/validator.ts:408–425`).
- Executor overlays the agent's frontmatter onto the node config at run time (`packages/workflows/src/dag-executor.ts:333–500`, search for `agentOverlay`).
- `loadAgentFile` reader in `packages/providers/src/claude/load-agent.ts`.
- NodeInspector AdvancedTab gained an `Agent (agent_ref)` picker that live-lists from the agents registry (`packages/web/src/components/workflows/NodeInspector.tsx`, search for `AgentRefField`).
- WorkflowsPage header repainted in the Bridges palette (`packages/web/src/routes/WorkflowsPage.tsx`).

### What still needs to ship

**Reference design** (read first):

- `/tmp/agent-registry-design/skill-editor/project/Workflow Registry.html` — entry point.
- Imports (in load order): `primitives.jsx`, `tweaks-panel.jsx`, `data.jsx`, `workflows-data.jsx`, `Sidebar.jsx`, `SkillList.jsx`, `WorkflowList.jsx`, `WorkflowEditor.jsx`, `WorkflowRunPanel.jsx`, `confirm-dialog.jsx`, `WorkflowsApp.jsx`.
- `colors_and_type.css` defines the dot-grid pattern at `:265` — `radial-gradient(circle, #DCDCE0 1px, transparent 1px)` on a 16×16 grid. Use the existing `--bridges-*` palette in `packages/web/src/index.css` for colors.

If `/tmp/agent-registry-design/` was cleaned up, refetch via:

```bash
mkdir -p /tmp/agent-registry-design && \
  curl -s 'https://api.anthropic.com/v1/design/h/5bzHRRFHrIvf6uJnNg0bCA' | \
  tar -xzf - -C /tmp/agent-registry-design
```

(WebFetch reports the response as binary — see `~/.claude/projects/-Users-desha-archon-symphony/memory/anthropic-design-handoff.md` for why.)

**Implementation outline**:

1. **`packages/web/src/routes/WorkflowsPage.tsx`** — split-pane: rebuilt `WorkflowList` on the left (mirror `AgentList.tsx` patterns: search, status chips, status-dot rows), `WorkflowChain` on the right.
2. **`packages/web/src/components/workflows/WorkflowList.tsx`** — replace card grid with the row layout from `AgentList.tsx`. Status-dot + tools-used + step-count + last-edited per row.
3. **`packages/web/src/components/workflows/WorkflowBuilder.tsx`** (or a new `WorkflowChain.tsx` alongside) — replace the `@xyflow/react` canvas with a vertical step chain on dot-grid:
   - Trigger node fixed at top.
   - Generic StepNode card with name, summary, per-step notes, status pill, top/bottom connectors.
   - Specialized renderers: `SkillStep`, `AgentStep`, `ConditionStep` (then/otherwise side-by-side), `WaitStep`, `EndNode`.
   - `AddStepButton` between steps; opens a bottom-sheet picker (Step Type → Skill / Agent / Condition / Wait → entity picker).
   - When the YAML's DAG isn't linear-with-branches (multiple roots, true diamond), show a "Complex DAG — open YAML view" notice and fall back to the YAML side panel. Don't try to render every shape.
4. **`packages/web/src/components/workflows/NodeInspector.tsx`** — keep the existing `AgentRefField`; rebuild the surrounding chrome to match the design's right-rail (see `WorkflowEditor.jsx`).
5. **`packages/web/src/components/workflows/{QuickAddPicker,NodeLibrary}.tsx`** — repurpose as the bottom-sheet step pickers.
6. **`packages/web/src/components/workflows/YamlCodeView.tsx`** — keep the YAML side-panel toggle; power users still want it.
7. After the chain ships, audit `WorkflowCanvas.tsx`, `DagNodeComponent.tsx`, `ExecutionDagNode.tsx` for unreferenced exports and delete. Keep `WorkflowDagViewer.tsx` if `WorkflowExecutionPage.tsx` still needs it.

**Out of scope on this rewrite**:

- Removing `@xyflow/react` from package.json (keep installed; only the builder uses it today).
- The runs/wk telemetry on workflow rows (placeholder zeros are fine).
- Any engine-level behavioral change. The DAG semantics, YAML on disk, and execution path are unchanged — this is purely a UI projection.

**Verification checklist after implementation**:

- `bun run dev` — backend on `:3090`, web on `:5173`.
- Visit `/workflows` — list shows existing workflows in the new row layout.
- Pick a linear workflow → chain renders Trigger → steps → End.
- Click "+ Add step" between two steps → picker opens → "Agent" → pick `code-reviewer` → step renders with the agent's name; YAML side panel shows `agent_ref: code-reviewer`.
- Pick a workflow with a true diamond DAG → see the "Complex DAG — open YAML view" fallback.
- `bun run validate` should be **the same number of failures as before** (see section 2 below — there's a baseline).

---

## 2. Pre-existing `@archon/workflows` loader test failures on `dev`

### What's broken

`bun test packages/workflows/src/loader.test.ts` reports **65 failing tests** on a clean `dev` checkout (verified 2026-05-01 via `git stash` + retest). They cluster around `parseWorkflow` parsing of:

- `interactive: true` / `interactive: false` (test reads `result.workflows[0].workflow.interactive`, gets `undefined` instead of the YAML value)
- `worktree.enabled: true` / `worktree.enabled: false`
- `tags` array (explicit, empty, dedupe, non-string, non-array variants)
- `mutates_checkout`
- "DAG Loader -- cycle detection" (fan-out + when, inline prompt nodes, unknown top-level fields)

Sample failure (representative of the whole class):

```
(fail) Workflow Loader > parseWorkflow > should parse interactive: true when present
   78 |   const yaml = `name: test\ndescription: test\ninteractive: true\nnodes:\n  - id: n\n    prompt: p\n`;
   79 |   await writeFile(join(workflowDir, 'test.yaml'), yaml);
   80 |   const result = await discoverWorkflows(testDir, { loadDefaults: false });
   81 |   expect(result.workflows[0].workflow.interactive).toBe(true);
   error: expect(received).toBe(expected)
   Expected: true
   Received: undefined
```

`bun run validate` is therefore non-zero on clean branches. We've been working around this for weeks.

### What's been ruled out

- Not a regression from agent-registry work — failures reproduce on a `git stash`-clean checkout.
- Not a flake — fails deterministically on every run, count is stable at 65.
- Not a single-file issue — all failing tests live in `packages/workflows/src/loader.test.ts`, but the underlying behavior is in `loader.ts` and `workflow-discovery.ts`.

### Where to look first

The `interactive` failure is the easiest entry point — it's the simplest field and the wiring is shallow:

1. **`packages/workflows/src/loader.ts:357`** — `interactive` is parsed correctly:
   ```typescript
   const interactive = typeof raw.interactive === 'boolean' ? raw.interactive : undefined;
   ```
   And returned at line 436 as part of the workflow object. So the loader output looks right when read in isolation.

2. **`packages/workflows/src/workflow-discovery.ts:203–347`** — `discoverWorkflows` wraps the loader. The shape it returns is `{ workflows: WorkflowWithSource[] }` where each entry is `{ workflow, source }`. The test does `result.workflows[0].workflow.interactive`, which matches. But `Received: undefined` means either:
   - The loader output is being wrapped/cloned through something that strips unknown keys (Zod `.parse()` with `.strict()` somewhere upstream?).
   - The test's `result.workflows[0]` is the bundled-default workflow rather than the test fixture, even with `loadDefaults: false`.
   - The loader is bailing out before reaching line 436 and a stub is being substituted.

   The cheapest first diagnostic: add `console.log(result.workflows.map(w => ({ name: w.workflow.name, source: w.source })))` at the top of one failing test and see what's actually being returned.

3. **No `workflowDefinitionSchema.parse()` is called on the loader output** today (verified via `grep` for `\.parse\|safeParse` in loader.ts/workflow-discovery.ts). So the schema isn't stripping fields. But it's worth checking whether one of the recent refactors silently introduced one — relevant commits worth bisecting:
   - `7be4d0a3 feat(paths,workflows): unify ~/.archon/{workflows,commands,scripts}` (#1315)
   - `bf1f471e refactor(workflows): trust the SDK for model validation` (#1463)
   - `5ed38dc7 feat(isolation,workflows): worktree location + per-workflow isolation policy` (#1310)
   - `3868f892 feat(workflows): support explicit tags in workflow YAML` (#1190)

### Suggested approach

```bash
# 1. Capture the current failure count as baseline.
bun test packages/workflows/src/loader.test.ts 2>&1 | grep -cE '\(fail\)'  # expect 65

# 2. Bisect against the suspect commits above.
git bisect start
git bisect bad HEAD
git bisect good <commit-before-the-suspect-window>
# bisect with a script that runs the loader.test.ts and exits 0 on green / 1 on any failure.

# 3. Once a culprit is identified, the fix is likely either:
#    (a) a missing field passthrough in a refactored loader path, or
#    (b) a Zod schema that gained `.strict()` and now drops unknown keys.

# 4. After the fix, re-run all packages: bun --filter '*' test
#    Confirm the per-package count drops to 0 and no other package regressed.
```

### How to validate the fix

- `bun test packages/workflows/src/loader.test.ts` exits 0 with all tests passing.
- `bun run validate` exits 0 across the workspace (this would be the first time in weeks — meaningful signal for the whole repo).
- Update `~/.claude/projects/-Users-desha-archon-symphony/memory/dag-loader-test-failures.md` to mark the breakage resolved (or just delete that memory file and remove its line from `MEMORY.md`).

---

## Cross-cutting notes

- The agents stuff this session shipped is independent of both follow-ups. Nothing here blocks merging the agent registry to `main`. Treat both follow-ups as new branches from `dev`.
- The `~/.claude/agents/_templates/default.md` template auto-bootstraps on first `/agents` visit — don't be surprised when a future session sees it appear without an explicit commit.
- See `~/.claude/projects/-Users-desha-archon-symphony/memory/MEMORY.md` for the wider context on this project; the two follow-ups are also referenced from there.
