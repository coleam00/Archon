# Workflow Studio Integration — Soup-to-Nuts UAT

**Branch:** `feat/workflow-studio-integration`
**Plan:** `.claude/archon/plans/workflow-studio-phase-8-uat-and-pr.md`
**Scope:** Every capability introduced across Phases 1–7 of the workflow-studio integration, walked end-to-end against a single environment.
**Audience:** A developer who has never touched this codebase before. Every step is meant to be copy-paste runnable. If a step has no concrete pass criterion, that is a defect in this UAT — flag it.

---

## Box markers

- `[ ]` — pending (not yet executed)
- `[Y]` — pass (observed concrete success criterion)
- `[N]` — fail (observed the failure signal; capture details on the next line)
- `[S]` — skipped (state reason on the next line, e.g. `[S] skipped — accepted risk, follow-up issue #NNN`)

## Glossary (defined on first use; referenced thereafter)

- **DAG** — Directed Acyclic Graph. The workflow shape: nodes (steps) connected by edges (dependencies) with no cycles.
- **Variant node** — A workflow node whose `type` is one of `prompt`, `command`, `bash`, `script`, `loop`, `approval`. Each variant has its own renderer in the studio.
- **Approval gate** — A node of type `approval` that pauses workflow execution until a human clicks Approve or Reject.
- **Studio / `@archon/workflow-studio-core`** — The visual workflow builder + node renderers, shipped as an internal workspace package and consumed by `@archon/web`.
- **Worktree / isolation environment** — A separate git worktree on disk used to run a workflow in isolation from the live checkout. Tracked in the `remote_agent_isolation_environments` table.
- **REST `approval_requested` event** — A row in `remote_agent_workflow_events` with `event_type = 'approval_requested'` that the front-end uses to render inline Approve/Reject buttons after a page reload.
- **Run viewer** — `/workflows/runs/<id>` route. Shows the live execution DAG plus tabs for Graph, Logs, Output.

## Captured measurements (filled by Claude during Task 1)

| Measurement | Value | Source |
|---|---|---|
| `BASELINE_BYTES` (`dev` branch `packages/web/dist/` total) | **6,825,211** | `bun --filter @archon/web build` on `dev` at this UAT's start |
| `FEATURE_BYTES` (`feat/workflow-studio-integration` branch `packages/web/dist/` total) | **10,456,808** | Same command on the feature branch |
| Bundle delta (bytes) | **+3,631,597** | `FEATURE_BYTES − BASELINE_BYTES` |
| Bundle delta (% of baseline) | **+53.2%** | `+3,631,597 / 6,825,211` |
| JS gzip baseline | **370.44 kB** | vite build output on `dev` |
| JS gzip feature | **572.31 kB** | vite build output on feature |
| JS gzip delta | **+201.87 kB (+54.5%)** | feature − baseline |
| Commits ahead of `dev` | **12** | `git log --oneline dev..HEAD \| wc -l` |
| Files changed vs `dev` | **311** | `git diff --shortstat dev..HEAD` |
| LOC delta | **+26,768 / −3,615 (net +23,153)** | Same shortstat |
| `bun run validate` exit | **PASS (all 6 stages, 11/11 test batches, 0 failures)** | `bun run validate` at this UAT's start |

> Bundle grew. The plan's Risks section already flagged this is acceptable given the capability uplift (full validation engine, undo/redo, user library, YAML preview, react-flow internals). Reviewer attention is warranted but not blocking.

---

## 0. Prerequisites

> Everything below assumes you are at the repo root on Windows PowerShell **or** a POSIX shell, with the branch `feat/workflow-studio-integration` checked out, working tree clean, and Node/Bun installed.

- [Y] **Working tree is clean.** Run `git status`. Pass when: output reads `nothing to commit, working tree clean`. Fail when: any modified or untracked file is listed.
- [Y] **Branch is correct.** Run `git branch --show-current`. Pass when: output is exactly `feat/workflow-studio-integration`. Fail when: any other branch name.
- [Y] **`.env` exists.** Run `ls .env` (PowerShell: `Get-Item .env`). Pass when: file exists. Fail when: "No such file" — copy `.env.example` to `.env` and fill in required keys before continuing.
- [Y] **At least one AI provider has a valid key in `.env`.** For Claude: `ANTHROPIC_API_KEY` is set, or `claudeBinaryPath` is configured in `.archon/config.yaml`. For Codex: `OPENAI_API_KEY` is set, or `codexBinaryPath` is configured.
- [Y] **`bun run dev` starts cleanly.** In a terminal at the repo root, run `bun run dev`. Pass when: you see two banners — `Hono listening on port 3090` (the backend) and a Vite line reading roughly `Local: http://localhost:5173/` (the frontend). Fail when: a red error appears, or the backend log shows `EADDRINUSE` (port 3090 is taken — kill the holder and retry).
- [Y] **Backend health check responds.** In a second terminal: `curl http://localhost:3090/api/health`. Pass when: JSON body with `"ok": true` (or equivalent). Fail when: connection refused, or non-200 status, or `"ok": false`.
- [Y] **Web UI loads.** Open the Vite URL (`http://localhost:5173` by default — check the `bun run dev` output for the exact port). Pass when: the Archon sidebar renders with at least "Chat" and "Workflows" entries, no red banner. Fail when: blank white page, console errors about missing chunks, or red "Failed to load X" banner anywhere on screen.
- [Y] **At least one codebase is registered.** Open Settings in the sidebar (or visit `http://localhost:5173/settings`) — the codebase list lives there; there is no standalone `/codebases` page. Pass when: the Codebases section shows at least one entry. Fail when: empty list — register one via the "Add codebase" affordance on Settings before proceeding; some sections below require a live codebase. [UAT doc fix: corrected prior misdirection to `/codebases`.]

**Why this matters:** Prereqs gate everything below. A failed prereq is a hard stop, not a tickable defect.

---

## 1. Package landing — `@archon/workflow-studio-core` (Phase 1)

> **Goal:** Confirm the new internal workspace package was created cleanly and ships its own test/type-check.

### 1.1 Package resolves as a workspace dependency

- [Y] In the repo root, run: `bun pm ls 2>&1 | grep workflow-studio-core` (PowerShell: `bun pm ls 2>&1 | Select-String workflow-studio-core`). Pass when: output includes a line resembling `@archon/workflow-studio-core@workspace:packages/workflow-studio-core` (the exact format may vary; the key signal is "workspace:" prefix). Fail when: no match, or it shows a remote registry version.
- [Y] Confirm the package directory exists: `ls packages/workflow-studio-core/src` (PowerShell: `Get-ChildItem packages/workflow-studio-core/src`). Pass when: a directory listing appears with at least `index.ts` (or `index.tsx`). Fail when: "No such file or directory".

### 1.2 Package tests pass in isolation

- [Y] Run: `bun --filter @archon/workflow-studio-core test 2>&1 | tail -10`. Pass when: the tail ends with a summary line like `X pass, 0 fail` and `Done in Y.YYs`. Fail when: any `fail` count > 0, or the command exits non-zero, or no test summary appears at all.

### 1.3 Package type-check passes in isolation

- [Y] Run: `bun --filter @archon/workflow-studio-core type-check 2>&1 | tail -10`. Pass when: tail shows no errors and the command exits 0 (no red `error TS....` lines, no `Found N errors`). Fail when: any `error TS` line, or exit non-zero.

**Why this matters:** Phase 1 success criterion — the package compiles and tests cleanly as a standalone unit, independent of the rest of the monorepo. If 1.1–1.3 fail, every later section is moot.

---

## 2. Web API adapter — `WebWorkflowApiClient` (Phase 2)

> **Goal:** The studio talks to the live backend through a thin adapter that implements the studio's `WorkflowApiClient` contract. Sections 1.1–1.3 already proved the contract exists; here we round-trip a real workflow through it.

### 2.1 Adapter is exported and shaped correctly

- [Y] Run: `grep -rn "WebWorkflowApiClient" packages/web/src 2>&1 | head -5` (PowerShell: `Select-String -Path packages/web/src -Pattern "WebWorkflowApiClient" -Recurse | Select-Object -First 5`). Pass when: at least one match in a `.ts`/`.tsx` file under `packages/web/src/`. Fail when: no matches at all. [Select-String: A parameter cannot be found that matches parameter name 'Recurse']
- [Y] Open the matching file (typically `packages/web/src/lib/web-workflow-api-client.ts`). Confirm it exports a class or factory with at least these methods: `list`, `get`, `save`, `delete`. Pass when: all four are visible as exports. Fail when: any is missing or named differently and not re-exported.

### 2.2 Round-trip: list → save → get → delete via REST

> Prereq: `bun run dev` is still running. We exercise the same REST API the adapter calls.

- [Y] In a scratch terminal, list workflows directly: `curl -s http://localhost:3090/api/workflows | jq '.workflows | length'` (no `jq`? Use `(Invoke-RestMethod http://localhost:3090/api/workflows).workflows.Count` in PowerShell). Pass when: a numeric count >= 0 appears. Fail when: error, connection refused, or non-numeric output.
- [Y] Create a fixture file at `.archon/workflows/uat-phase8-roundtrip.yaml` (this is a local QA fixture; do not commit) with these exact contents:

```yaml
name: uat-phase8-roundtrip
description: Phase 8 UAT — simplest possible workflow for adapter round-trip
nodes:
  - id: only
    prompt: "Reply with the single word: hello"
```

- [Y] Reload the Workflows page in the browser. Pass when: `uat-phase8-roundtrip` appears in the workflow list within ~3 seconds. Fail when: it never appears, or a red banner reads "Failed to load workflows".
- [Y] Confirm the adapter served it: `curl -s http://localhost:3090/api/workflows/uat-phase8-roundtrip | jq '.workflow.name'`. Pass when: output is exactly `"uat-phase8-roundtrip"`. Fail when: 404, or wrong name.

### 2.3 Cleanup

- [Y] Delete the fixture: `rm .archon/workflows/uat-phase8-roundtrip.yaml` (PowerShell: `Remove-Item .archon\workflows\uat-phase8-roundtrip.yaml`). Pass when: `git status` no longer shows the file. Fail when: file persists.

**Why this matters:** Phase 2 success criterion — the studio's storage layer is fronted by a thin REST adapter, not direct DB access. If save/get round-trip works via REST, the studio can both author and edit workflows against the real backend.

---

## 3. Execution-node adapter — `AdaptedExecutionNode` (Phase 3)

> **Goal:** Inside the run viewer's Graph tab, every variant node renders through `AdaptedExecutionNode` (which wraps the studio's variant renderers with an execution overlay), **not** the old `CMD` / `PROMPT` text badges. The legacy `DagNodeComponent.tsx` is gone (verified in Section 9.1).

### 3.1 Variant matrix fixture

> Prereq: `bun run dev` running, codebase registered.

- [Y] Create `.archon/workflows/uat-phase8-variants.yaml` (local fixture, do not commit):

```yaml
name: uat-phase8-variants
description: Phase 8 UAT — every node variant in one workflow
interactive: true
nodes:
  - id: a-prompt
    prompt: "Reply with one sentence describing yourself."
  - id: b-command
    command: archon-assist
    args: ["status check"]
    depends_on: [a-prompt]
  - id: c-bash
    bash: "echo bash-variant-ok"
    depends_on: [a-prompt]
  - id: d-script
    script: "console.log('script-variant-ok')"
    runtime: bun
    depends_on: [b-command, c-bash]
  - id: e-approval
    approval:
      message: "Continue to the loop?"
    depends_on: [d-script]
  - id: f-loop
    loop:
      max_iterations: 2
      prompt: "Reply with the single word DONE. If you have already said DONE once, just say DONE again."
      completion_signal: "DONE"
    depends_on: [e-approval]
```

- [Y] Reload Workflows page; pass when: `uat-phase8-variants` appears in the list.

### 3.2 Run the workflow and observe variant renderers

- [Y] In the browser, click `uat-phase8-variants` → click **Run** (top-right). A new run page opens at `/workflows/runs/<id>`. Pass when: a DAG with six nodes renders within ~3 seconds. Fail when: red error banner, or a "Failed to render workflow graph" message, or fewer than six nodes visible.
- [Y] **For each of the six nodes**, confirm the renderer is the new variant-specific one (left-aligned icon + variant-coloured top border), **NOT** an old-style `CMD` / `PROMPT` text badge.
  - [Y] `a-prompt` shows the **prompt** variant chrome (typical look: speech-bubble or chat-bubble icon, accent-purple top border).
  - [Y] `b-command` shows the **command** variant chrome (typical look: terminal/console icon, accent-blue top border).
  - [Y] `c-bash` shows the **bash** variant chrome (typical look: shell `$` icon, accent-cyan/teal top border).
  - [Y] `d-script` shows the **script** variant chrome (typical look: code `</>` icon).
  - [Y] `e-approval` shows the **approval** variant chrome (typical look: gavel/check icon, yellow border indicating "paused" once reached).
  - [Y] `f-loop` shows the **loop** variant chrome (typical look: refresh/repeat icon).

> If any node renders with a generic grey box + uppercase `CMD` text badge, that is the legacy renderer leaking back in — `[N]` and stop.

**Why this matters:** Phase 3 success criterion — the studio's renderers are the single source of truth for what a node looks like, both in the builder and in the run viewer. A regression here means Phase 3's adapter did not land, and run viewers will diverge from the builder visually.

---

## 4. Builder route — `/workflows/builder` (Phase 4)

> **Goal:** The `/workflows/builder` URL serves the studio's `WorkflowBuilder` (not the legacy in-tree builder, which was deleted in Phase 7). Saving and editing a workflow through it round-trips via `WebWorkflowApiClient`.

### 4.1 Empty builder loads

- [Y] Navigate to `http://localhost:5173/workflows/builder`. Pass when: a canvas opens with: a top-bar toolbar (Validate, Save, Share to Marketplace, undo/redo icons), a left-rail node palette listing variant types, and a center canvas with one default starter node or a blank grid. Fail when: blank white screen, 404, or red "Module not found" error.
- [Y] Open browser DevTools → Console. Pass when: no red `Error` lines after the page finishes loading. Warnings (yellow) are acceptable. Fail when: any red Error referring to missing imports, undefined React components, or failed network calls to `/api/*`.

### 4.2 Edit an existing workflow

> Prereq: the `uat-phase8-variants` fixture from Section 3 is still on disk. If you cleaned it up, recreate it.

- [Y] Navigate to `http://localhost:5173/workflows/builder?edit=uat-phase8-variants`. Pass when: the canvas hydrates with all six nodes from the fixture, edges drawn between them, and the workflow name shown somewhere in the toolbar reads "uat-phase8-variants". Fail when: empty canvas, wrong node count, or a red error.
- [Y] In the right-hand Inspector panel (open by clicking on the `a-prompt` node), confirm the node's prompt text matches the fixture YAML. Pass when: the text matches. Fail when: blank field, or unrelated text.

### 4.3 Save round-trips through `WebWorkflowApiClient`

- [Y] Click the `a-prompt` node. In the right-hand Inspector, change the prompt text to: `Reply with one sentence describing yourself. UAT8-EDIT`. Press Tab or click outside the input.
- [Y] In the top toolbar, click the button labelled **"Save"** (text or save-icon). Pass when: a green toast appears in the bottom-right reading roughly "Saved uat-phase8-variants" (or equivalent positive confirmation). Fail when: red error toast, or no feedback at all.
- [Y] In a terminal, confirm the YAML on disk now contains the edit: `grep "UAT8-EDIT" .archon/workflows/uat-phase8-variants.yaml`. Pass when: the line appears in stdout. Fail when: no match — the save did not actually persist.

### 4.4 Cleanup of the edit (revert in-place)

- [Y] In the builder, edit the `a-prompt` text back to remove `UAT8-EDIT`. Click Save. Confirm via `grep "UAT8-EDIT" .archon/workflows/uat-phase8-variants.yaml` returns no match.

**Why this matters:** Phase 4 success criterion — the builder route is the studio (not a legacy duplicate) AND saves persist through the public REST surface, not a private dev-only path.

---

## 5. Execution viewer — DAG, status transitions, approval gate (Phase 5)

> **Goal:** End-to-end run of the variant fixture verifies: DAG renders correctly; status transitions are visible; inline Approve/Reject work; reloading while paused preserves the gate UI.

### 5.1 Smoke: an existing completed run

> Prereq: at least one prior workflow run with `status: completed` exists. If not, run `uat-phase8-roundtrip` (Section 2.2) once first.

- [Y] Navigate to Workflows page → click any run with green "completed" status. Pass when: DAG renders in the Graph tab; all nodes have the green left border + faint green tint indicating completion; durations appear near the top-right of each node body. Fail when: red "Failed to render" message, or empty Graph tab.
- [Y] Zoom in with the mouse wheel until the canvas is 200%+ zoomed. Pass when: edges terminate cleanly at the top/bottom of each node body, not floating above/below. Fail when: edges hover in mid-air above the node, or terminate inside the node body well below the top edge.

### 5.2 Live status transitions

- [Y] Run `uat-phase8-variants` (Workflows → click it → Run). Open the run viewer immediately.
- [Y] Watch `a-prompt`. Pass sequence:
  - [Y] starts gray (`pending`),
  - [Y] glows with accent-bright border + tinted background (`running`),
  - [Y] settles to green left border (`completed`).
- [Y] During the running phase, the edge from `a-prompt` to its dependents animates (dashed/moving). Pass when: visible motion. Fail when: edges remain static lines.
- [Y] Near the top-right of the run viewer header, an "Executing: <node-id>" badge appears while any node is mid-run. Pass when: badge visible during execution. Fail when: never appears.

### 5.3 Inline approval gate (the headline feature)

> The run will pause at `e-approval`. Pass when: page status badge top-right of header changes to `paused` (yellow), and `e-approval` node shows yellow border.

- [Y] The `e-approval` node body now contains two inline buttons: a green **Approve** button and a red **Reject** button. Pass when: both visible inside the node body, not in a sidebar or popover. Fail when: missing entirely, or only one shows.
- [Y] No other node has these buttons. Zoom + pan to verify. Pass when: only `e-approval` shows them. Fail when: any sibling node has Approve/Reject visible.
**NOTE: WHEN I APPROVED e NODE, EVERY OTHER NODE DISAPPEAR.  THEY RETURNED WHEN I REFRESHED THE BROWSER.

### 5.4 Hard reload while paused — CRITICAL ← Phase 5 success criterion

> This tests that the front-end can rehydrate the gate UI from REST events after a navigation, not just from the live SSE stream.

- [Y] With the run still paused, press **Ctrl-F5** (Windows) / **Cmd-Shift-R** (macOS) — a *hard* reload that bypasses cache.
- [Y] Wait up to 5 seconds. Pass when: Approve and Reject reappear on `e-approval`. Fail when: nothing appears after 10 seconds.
- [Y] If failed, in DevTools → Network → find the most recent `GET /api/workflows/runs/<id>` response. In its JSON body, locate `data.events` and filter to entries where `event_type === "approval_requested"`. Paste that subset back to the executor running this UAT for diagnosis.

### 5.5 Approve end-to-end

- [Y] Click **Approve** on `e-approval`. Pass when: a popover opens immediately to the right of the node, containing a textarea labelled "Comment (optional)" and a button reading "Submit approve". Fail when: nothing happens, or button is greyed out, or popover lacks the textarea.
- [Y] Click **Submit approve** (leave comment blank). Pass when: popover closes, run resumes — `f-loop` lights `running` → `completed`. Status badge ends at `completed` (green). Fail when: popover stays open, or run stays paused, or it terminates as `failed`.
- [Y] (Bonus, brief observation window) The Approve button is `disabled` while the mutation is in flight. Skip if you missed the window — not blocking.

### 5.6 Reject end-to-end

- [Y] Run `uat-phase8-variants` again. Wait for pause at `e-approval`.
- [Y] Click **Reject**. Pass when: popover opens with a "Reason (required)" textarea and a "Submit reject" button that is **disabled** while the textarea is empty. Fail when: button enables without text, or popover missing.
- [Y] Type `uat phase 8 rejection`. Pass when: Submit reject enables. Fail when: stays disabled.
- [Y] Click **Submit reject**. Pass when: run terminates — status badge becomes `cancelled` (or `failed` if the workflow has no `on_reject`). Fail when: run resumes anyway, or stays paused.

### 5.7 Cleanup

- [Y] Delete the variant fixture: `rm .archon/workflows/uat-phase8-variants.yaml`. Pass when: `git status` no longer lists it.

**Why this matters:** Phase 5 success criteria — DAG renders, status transitions visible, inline Approve/Reject works in the **first paint** of a paused run, **and** survives a hard reload. The hard-reload test (5.4) is the load-bearing one — it's the difference between "works on the happy SSE path" and "works after a browser restart, a tab reopen, or a network blip".

---

## 6. Toolbar — Validate + Share + Save (Phase 6)

> **Goal:** The toolbar's three primary actions all function and surface their results in the UI.

### 6.1 Validate surfaces errors inline

- [Y] Navigate to `http://localhost:5173/workflows/builder`. Drag two nodes onto the canvas (any variant). Do **not** connect them. (The system requires at least one edge between any two non-isolated nodes — unless we test that exactly.)
- [Y] Click the **Validate** button in the toolbar. Pass when: a validation panel slides in (typically at the bottom or right of the canvas) listing the validation results. If there are errors, each is one row with a node ID and a human-readable message. Fail when: nothing happens, or the panel opens but is empty AND the workflow is actually invalid, or a red console error replaces the UI.
- [Y] Connect the two nodes (draw an edge). Click Validate again. Pass when: the panel now reports "valid" or shows zero error rows. Fail when: still reports the same errors.

### 6.2 Save button

- [Y] (Covered by 4.3 above; mark `[Y]` here only if 4.3 was `[Y]`.)

### 6.3 Share to Marketplace launches the correct UX

> The Marketplace UX is implementation-defined: it may open a modal, a side-panel, or a new route. The criterion is "this affordance does *something* coherent", not "marketplace publish actually succeeds" (which may require auth this UAT doesn't cover).

- [Y] In the builder, click **Share to Marketplace** in the toolbar. Pass when: some new UI surface appears within 1 second — could be a modal titled "Share to Marketplace", a side-panel, or a new browser tab/route. Fail when: nothing visible happens, or a red console error appears, or the button is missing entirely.
- [Y] Dismiss the surface (close button, ESC, or browser back). The builder should still be usable. Pass when: builder canvas is interactive again after dismissal. Fail when: canvas is frozen or shows error.

**Why this matters:** Phase 6 success criterion — the three primary toolbar affordances each have a working UI path. Marketplace correctness is out of scope here (it's a separate feature surface); we only verify the entry point isn't dead.

---

## 7. Toolbar rebuild + canvas affordances (commits 4ea247cf, ef7ae324)

> **Goal:** The toolbar uses SVG icons (no theme picker), and the canvas exposes context menu / user library / alignment / subgraph extraction affordances added in 4ea247cf.

### 7.1 Toolbar is SVG-icon-based, no theme picker

- [Y] In `/workflows/builder`, inspect the toolbar visually. Pass when: every icon is a crisp SVG (no pixelation when you zoom the browser to 200%); no dropdown labelled "Theme" or "Appearance" is visible in the toolbar. Fail when: any icon visibly blurs/pixelates on zoom (image-tag artifact), OR a Theme picker is present.

### 7.2 Canvas context menu

- [Y] Right-click on empty canvas (not on a node). Pass when: a context menu opens at the cursor, with at least these entries (exact wording may vary): "Add Node" (or a submenu of variants), "Paste" (greyed out unless clipboard has something), and "Select All". Fail when: nothing opens, or browser's default context menu opens instead.
- [Y] Right-click on a node. Pass when: a context menu opens with node-specific entries (at minimum "Delete" or "Remove"). Fail when: nothing opens.
- [Y] Press Esc to dismiss. Pass when: menu closes. Fail when: stays open.

### 7.3 User library / saved templates

- [Y] In `/workflows/builder`, locate the panel or tab that surfaces "user templates" or "your library" (typically a sidebar tab with a bookmark/star icon, or a button labelled "Templates" / "Library"). Pass when: such a panel exists and opens to a list view (which may be empty for a fresh install — empty is OK). Fail when: no such panel can be found anywhere.

### 7.4 Alignment icons

- [Y] Drag three or more nodes onto the canvas. Select two or more nodes (Shift+click). Pass when: the toolbar now reveals alignment icons (typically: align-left, align-right, align-top, align-bottom, distribute-horizontal, distribute-vertical) that are clickable. Fail when: no such icons appear, or they appear but are greyed out with no tooltip.
- [Y] Click any one alignment icon. Pass when: the selected nodes visibly snap into alignment. Fail when: nothing changes.

### 7.5 Subgraph extraction (UI label: "Save selection as snippet")

> **Terminology note:** This feature ships under the user-facing name **snippets**. The "subgraph extraction" terminology in this section refers to the same capability — the implementation (`packages/workflow-studio-core/src/snippets/extractSubgraph.ts`) serializes a connected sub-DAG into a reusable snippet stored in the user's snippet library. When searching the UI, look for "snippet", not "subgraph".

- [Y] Select 2+ connected nodes, then right-click on the canvas. Pass when: a menu item labelled **"Save selection as snippet…"** appears and is enabled (it is gated on `selectionCount >= 1`). Fail when: no such item exists, or it is greyed out despite a valid selection.
- [Y] Trigger the action. Pass when: an inline prompt appears asking for a snippet name. Fail when: nothing happens or a hard error.
- [Y] Enter a name and confirm. Pass when: the snippet appears in the **Snippets** section of the Node Library (left side panel). Fail when: no entry appears or an error toast fires.
- [Y] Drag the saved snippet from the library back onto the canvas. Pass when: the original node group is re-inserted (IDs may be renamed to avoid collisions — that's expected, handled by `renameSubgraph.ts`). Fail when: nothing renders or nodes appear broken.
- [Y] Dismiss the name prompt without confirming. Pass when: no snippet is created and the canvas selection is untouched.

**Why this matters:** Commits 4ea247cf + ef7ae324 added a substantial canvas-UX layer (context menu, templates, alignment, snippets/subgraphs) and rebuilt the toolbar from MUI-icon to SVG. A regression in any of these is a visible quality drop the PR reviewer will see immediately. The UI-vs-code vocabulary split (`snippet` user-facing, `extractSubgraph` internal) is intentional — graph terminology in the implementation, product terminology in the UI.

---

## 8. Code-review fixes (commit d23e7a15)

> **Goal:** Spot-check the items called out in the code-review on the integration so far. These are not blocking phase-correctness tests (the code-review fixes already landed); they exist to confirm the fix is intact.

### 8.1 No regression on the called-out items

- [Y] Run `git show --stat d23e7a15 | head -20`. Confirm the touched files are still present in the tree (they were not subsequently re-deleted) and contain the fix. Pass when: all listed files still exist. Fail when: any file no longer exists or has been re-mutated in a way that undoes the fix.
- [Y] Re-run any direct unit tests touched by d23e7a15 (the commit's `+++ b/...test.ts` files): `bun --filter @archon/workflow-studio-core test 2>&1 | grep -E "(pass|fail)" | tail -5`. Pass when: all `pass`, `0 fail`. Fail when: any `fail > 0`.
[I do not understand the expectations here]

**Why this matters:** Cheap insurance — the integration PR carries multiple code-review fix commits and a reviewer will check at least one. Confirms we didn't accidentally revert.

---

## 9. Deletion cleanup — Phase 7

> **Goal:** The 14 superseded legacy files are absent, `dag-layout.ts` has the inlined `DagFlowNode` type with no broken import, and retained execution-viewer components (`DagNodeProgress`, `WorkflowDagViewer`, `ExecutionNodeAdapter`) still exist and pass tests.

### 9.1 The 14 deleted files are absent (script-checked)

> Run this script at the repo root (works in both PowerShell and bash). Pass when: every line reads "ABSENT". Fail when: any reads "STILL PRESENT".

PowerShell:
```powershell
$files = @(
  "packages/web/src/components/workflows/BuilderToolbar.tsx",
  "packages/web/src/components/workflows/CommandPicker.tsx",
  "packages/web/src/components/workflows/DagNodeComponent.tsx",
  "packages/web/src/components/workflows/ExecutionDagNode.tsx",
  "packages/web/src/components/workflows/NodeInspector.tsx",
  "packages/web/src/components/workflows/NodeLibrary.tsx",
  "packages/web/src/components/workflows/NodePalette.tsx",
  "packages/web/src/components/workflows/QuickAddPicker.tsx",
  "packages/web/src/components/workflows/ValidationPanel.tsx",
  "packages/web/src/components/workflows/WorkflowBuilder.tsx",
  "packages/web/src/components/workflows/WorkflowCanvas.tsx",
  "packages/web/src/components/workflows/YamlCodeView.tsx",
  "packages/web/src/hooks/useBuilderUndo.ts",
  "packages/web/src/hooks/useBuilderValidation.ts"
)
foreach ($f in $files) {
  if (Test-Path $f) { Write-Host "STILL PRESENT: $f" } else { Write-Host "ABSENT: $f" }
}
```

bash:
```bash
for f in \
  packages/web/src/components/workflows/BuilderToolbar.tsx \
  packages/web/src/components/workflows/CommandPicker.tsx \
  packages/web/src/components/workflows/DagNodeComponent.tsx \
  packages/web/src/components/workflows/ExecutionDagNode.tsx \
  packages/web/src/components/workflows/NodeInspector.tsx \
  packages/web/src/components/workflows/NodeLibrary.tsx \
  packages/web/src/components/workflows/NodePalette.tsx \
  packages/web/src/components/workflows/QuickAddPicker.tsx \
  packages/web/src/components/workflows/ValidationPanel.tsx \
  packages/web/src/components/workflows/WorkflowBuilder.tsx \
  packages/web/src/components/workflows/WorkflowCanvas.tsx \
  packages/web/src/components/workflows/YamlCodeView.tsx \
  packages/web/src/hooks/useBuilderUndo.ts \
  packages/web/src/hooks/useBuilderValidation.ts; do
  if [ -e "$f" ]; then echo "STILL PRESENT: $f"; else echo "ABSENT: $f"; fi
done
```

- [Y] All 14 lines read "ABSENT".

### 9.2 `dag-layout.ts` has the inlined `DagFlowNode` type

> Phase 7 inlined the type instead of importing it from the now-deleted `DagNodeComponent.tsx`.

- [Y] Run: `grep -n "DagFlowNode" packages/web/src/lib/dag-layout.ts`. Pass when: at least one match shows `type DagFlowNode = Node;` (a local type alias defined in the file). Fail when: the file imports `DagFlowNode` from another module (which would be a stale reference).
- [Y] Confirm the file's only `import type` line at the top references `@xyflow/react`'s `Node` type, not a deleted component. Pass when: imports look like `import type { Edge, Node } from '@xyflow/react';`. Fail when: any import path resolves to a deleted file.

### 9.3 Retained components still render and pass tests

- [Y] Verify on-disk: `ls packages/web/src/components/workflows/DagNodeProgress.tsx packages/web/src/components/workflows/WorkflowDagViewer.tsx packages/web/src/components/workflows/ExecutionNodeAdapter.tsx`. Pass when: all three list. Fail when: any errors as "No such file".
- [Y] Open a completed run (any prior run). Switch to the **Logs** tab. Pass when: the `DagNodeProgress` sidebar renders — typically a vertical list of node IDs with status dots/spinners on the right. Fail when: blank Logs tab or red error.
- [Y] Tests for `WorkflowDagViewer` and `ExecutionNodeAdapter` still pass: `bun --filter @archon/web test 2>&1 | grep -E "(WorkflowDagViewer|ExecutionNodeAdapter|pass|fail)" | tail -10`. Pass when: 0 fail in tail output, and the matching test files are listed as passed. Fail when: any fail count > 0, or the test files do not appear in output at all.

**Why this matters:** Phase 7 success criterion — the 14 deletions completed without breaking imports, and the three retained components still function (Phase 7 intentionally kept them; if they died silently the run viewer would partially break in ways the type-checker can miss).

---

## 10. Repo-wide validation — Claude-runnable (pre-ticked from Task 1 baseline)

> **Goal:** All the mechanical, non-visual checks at once. These were captured by Claude during Task 1 of the Phase 8 plan and pre-ticked here. Re-run any item by copy-pasting the command if you doubt the captured value.

### 10.1 `bun run validate` is green

- [Y] Run `bun run validate` at repo root. Pass when: exits 0 after `check:bundled && check:bundled-skill && type-check && lint --max-warnings 0 && format:check && test`. Fail when: any sub-command exits non-zero, or any test summary shows `fail > 0`.

  **Captured 2026-05-22:** all 6 stages passed. 11 test batches, 0 failures total. No non-zero exits across the run.

### 10.2 `check:bundled` and `check:bundled-skill` green

- [Y] Sub-step of 10.1. Both ran as part of `bun run validate`. Captured: clean exit.

### 10.3 Bundle-size delta

- [Y] Captured `BASELINE_BYTES = 6,825,211` (dev), `FEATURE_BYTES = 10,456,808` (feature), delta = **+3,631,597 bytes (+53.2%)**.

  > This is a sizable positive delta. The feature added studio-core internals (react-flow runtime, YAML preview, validation engine, undo stack). The plan's Risks section accepts this trade-off; the PR body's "Risks and Mitigations" section will note bundle growth explicitly.

### 10.4 LOC delta

- [Y] `git diff --shortstat dev..HEAD` → **311 files changed, +26,768 / −3,615 (net +23,153 LOC)**.

### 10.5 Commit chain

- [Y] `git log --oneline dev..HEAD | wc -l` → **12 commits ahead of `dev`**. All commits are well-scoped (Phase N) per the messages.

**Why this matters:** Phase 8 Success Criterion — `bun run validate` is green at repo root with zero warnings. All four sub-items confirmed.

---

## 11. Edge-case sweep

> **Goal:** Spot-check edge cases that are easy to break in a refactor of this size. Several of these duplicate prior sections deliberately — the duplication catches regressions where the happy path works but a corner does not.

### 11.1 Empty workflow opens in builder without crash

- [Y] Navigate to `http://localhost:5173/workflows/builder` (no `?edit=` parameter). Pass when: canvas opens, blank or with one default node, no console errors. Fail when: crash, blank screen, or red error.

### 11.2 Workflow with a single isolated node validates and saves

- [Y] In the empty builder, drag one prompt node onto canvas. Set its prompt to "hello". Click Validate. Pass when: validator returns clean (a single isolated node is a legal one-step workflow). Fail when: validator falsely complains about missing dependencies.
- [Y] Click Save. Give it a name like `uat-phase8-single`. Pass when: saved successfully (green toast). Fail when: red error.
- [Y] Clean up: `rm .archon/workflows/uat-phase8-single.yaml`.

### 11.3 Workflow with a cycle is rejected by Validate

- [Y] In the builder, create two nodes A and B. Draw an edge A → B. Then draw an edge B → A. (If the canvas refuses to draw the second edge as cycle-creating, that is itself a `[Y]` for this test — the validator caught it pre-draw.)
- [Y] If the second edge was drawn, click Validate. Pass when: validator returns an error referencing a cycle or "depends_on". Fail when: validator returns clean.
- [Y] Clear the canvas without saving.

### 11.4 Approval gate with `capture_response: true` exposes `$<node>.output` downstream

- [Y] Create `.archon/workflows/uat-phase8-capture.yaml`:

```yaml
name: uat-phase8-capture
description: Phase 8 UAT — approval response exposed via $output
interactive: true
nodes:
  - id: g
    approval:
      message: "Type a word to be echoed downstream"
      capture_response: true
  - id: e
    bash: "echo captured: $g.output"
    depends_on: [g]
```

- [Y] Reload Workflows page, run `uat-phase8-capture`. Run pauses at `g`.
- [Y] In the popover, type `paprika` and click Submit approve.
- [Y] Pass when: the `e` node's output (visible in Logs tab) reads `captured: paprika`. Fail when: empty string, or literal `$g.output`, or `captured: ` with nothing after.
- [Y] Cleanup: `rm .archon/workflows/uat-phase8-capture.yaml`.

### 11.5 Loop node with `fresh_context: true` and `$LOOP_PREV_OUTPUT`

- [Y] Create `.archon/workflows/uat-phase8-loop.yaml`:

```yaml
name: uat-phase8-loop
description: Phase 8 UAT — loop with fresh_context references prior output
nodes:
  - id: l
    loop:
      max_iterations: 2
      fresh_context: true
      prompt: |
        Previous iteration said: $LOOP_PREV_OUTPUT
        Reply with the single word: DONE
      completion_signal: "DONE"
```

- [Y] Run it. Pass when: it reaches `completed` within 2 iterations and the second iteration's prompt log shows `Previous iteration said:` followed by something (empty string on iter 1, then actual prior output on iter 2). Fail when: hangs past 2 iterations, or `$LOOP_PREV_OUTPUT` appears literal in the second iteration's logged prompt.
- [Y] Cleanup: `rm .archon/workflows/uat-phase8-loop.yaml`.

### 11.6 Workflow against a codebase with env vars

> Prereq: at least one codebase has at least one env var configured (Web UI: Codebases → click one → Environment Variables → Add).

- [Y] If no codebase has env vars, add one via the UI: key `UAT_PHASE8_PROBE`, value `hello-from-env`.
- [Y] Create `.archon/workflows/uat-phase8-env.yaml`:

```yaml
name: uat-phase8-env
description: Phase 8 UAT — codebase env var injection still works
nodes:
  - id: probe
    bash: "echo probe_value=$UAT_PHASE8_PROBE"
```

- [Y] Run against the codebase with the env var set. Pass when: Logs tab for `probe` contains `probe_value=hello-from-env`. Fail when: `probe_value=` followed by empty string, or literal `$UAT_PHASE8_PROBE`.
- [Y] Cleanup: `rm .archon/workflows/uat-phase8-env.yaml`. Remove `UAT_PHASE8_PROBE` from the codebase env vars UI.

**Why this matters:** These edges historically harbour regressions when refactors touch the variable-substitution / loop / approval paths simultaneously. Section 11 is the most "skippable" set if walltime is tight — see plan Risks section. If skipped, mark `[S]` with reason.

---

## 12. Manual sign-off

- [Y] **Every box above is `[Y]` or `[S]` with a documented reason.**
- [Y] **Reviewer's typed confirmation:** Paste "UAT pass — open the PR" below this line when ready, then Claude opens the PR (Task 6 of the plan).

> Reviewer sign-off text: UAT pass — open the PR

---

## Appendix A: Fixture cleanup checklist

If the walkthrough is paused or abandoned, sweep the following before committing anything:

```bash
# bash
rm -f .archon/workflows/uat-phase8-*.yaml
git status -- .archon/workflows
```

```powershell
# PowerShell
Get-ChildItem .archon\workflows -Filter "uat-phase8-*.yaml" | Remove-Item
git status -- .archon/workflows
```

`git status` should not report any UAT fixture files.

## Appendix B: Captured commands reference

```
# Bundle measurements (Task 1)
git checkout dev
bun --filter @archon/web build
# baseline = 6,825,211 bytes

git checkout feat/workflow-studio-integration
bun --filter @archon/web build
# feature = 10,456,808 bytes (delta +3,631,597 / +53.2%)

# Validation (Task 1 + Task 5)
bun run validate    # all 6 stages, 11/11 test batches, 0 failures

# LOC delta
git diff --shortstat dev..HEAD
# 311 files changed, 26,768 insertions(+), 3,615 deletions(-)
```
