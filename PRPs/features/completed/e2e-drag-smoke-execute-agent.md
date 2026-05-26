# Feature: E2E Drag Smoke — Move Card Triggers Execute Agent

## Feature Description

Add an "Execute" drop zone to the Console experiment's Kanban-style run feed
so users can drag an existing run card (or a task card) onto it to enqueue a
new agent work order via the Copilot SDK provider. Accompany the feature with
a smoke test (`@pytest.mark.unit` / `bun:test`) that verifies the full
drag-to-work-order path: card dragged into Execute column → `startRun` called
→ Copilot SDK agent invoked.

The goal is two-fold:

1. **UI behaviour** — expose a drag target in the console feed that accepts
   run cards and maps the drop to a `startRun` skill call with the
   `execute`/`implement` workflow, creating a Copilot SDK agent work order.
2. **Smoke coverage** — a deterministic, fast test that asserts the
   drag-drop interaction wires correctly to the backend skill, giving CI
   confidence that the path from UI gesture to agent invocation is intact.

## User Story

As a developer using the Archon console  
I want to drag a card into the Execute column  
So that the Copilot SDK agent is immediately queued to act on that task
without me having to fill in the DraftRunCard form manually

## Problem Statement

The console run feed today is a list; cards can only be started through the
`DraftRunCard` form. There is no gestural shortcut that maps a specific task
(e.g. a paused run, a rerun candidate, or a future backlog card) directly to
the `execute`/`implement` workflow. Additionally there is no smoke-level
regression test verifying that the drag-to-agent path works end-to-end.

## Solution Statement

1. Add an `ExecuteDropZone` component to the console that accepts
   `draggable="true"` card elements (identified by a `data-run-id` or
   `data-task-id` attribute) and fires `startRun` on drop.
2. Make run cards in the feed draggable by adding `draggable="true"` and the
   relevant `dragstart` data-transfer payload (`run id`, `projectId`,
   `workflow`).
3. Write a `bun:test` smoke test that:
   - Mocks `skill.startRun` (the single mutation surface)
   - Constructs a minimal drag-event fixture
   - Calls the `ExecuteDropZone`'s `onDrop` handler directly (or via
     `fireEvent.drop` with `@testing-library/dom`)
   - Asserts `startRun` was called with `workflow: 'implement'` and the
     correct `projectId`/`message`.

## Relevant Files

### Existing Files

- **`packages/web/src/experiments/console/components/DraftRunCard.tsx`**
  - Already handles `DragEvent` for file drops (`dragOver` state, `onDrop`
    handler); the `ExecuteDropZone` follows the same pattern — lines 1-30
    import section, drag state variables (~line 72-76), `onDrop` handler.
- **`packages/web/src/experiments/console/components/ActiveRunCard.tsx`**
  - Card rendered for `running`/`paused` runs; needs `draggable="true"` +
    `onDragStart` to set `dataTransfer` payload — lines 1-80.
- **`packages/web/src/experiments/console/components/RecentRunRow.tsx`**
  - Compact row for completed/failed runs; same draggable treatment needed.
- **`packages/web/src/experiments/console/skills/startRun.ts`**
  - `startRun({ projectId, workflow, message })` — the single call the drop
    handler must invoke (lines 1-60, entire file).
- **`packages/web/src/experiments/console/routes/RunsPage.tsx`**
  - Houses `RunsFeed`; the `ExecuteDropZone` sits below or alongside the
    feed in this page (line ~250 `RunsFeed` render site).
- **`packages/web/src/experiments/console/primitives/run.ts`**
  - `Run` type; need `projectId` and `workflow` fields for the drag payload.
- **`packages/web/src/experiments/console/README.md`**
  - Vocabulary and constraints; `ExecuteDropZone` must respect the
    "Project · Run · Workflow · Worktree" vocabulary.
- **`packages/web/src/experiments/console/theme.css`**
  - Design token classes; drop zone uses `bg-surface-inset`, `border-border`,
    `bg-accent/10` (hover) for brand-aligned visual.

### New Files

- **`packages/web/src/experiments/console/components/ExecuteDropZone.tsx`**
  New component: accepts a dragged run card, calls `startRun` on drop.
  Exports `ExecuteDropZone` with props `{ projectId: string; projectCwd: string }`.

- **`packages/web/src/experiments/console/components/ExecuteDropZone.test.ts`**
  Smoke test (unit): mocks `skill.startRun`, dispatches drop event fixture,
  asserts `startRun` is called with correct arguments.

- **`packages/web/src/experiments/console/lib/drag-payload.ts`**
  Typed drag-transfer codec: `encodeDragPayload(run: Run): string` /
  `decodeDragPayload(raw: string): DragPayload | null`. Keeps the
  data-transfer format as a single source of truth.

- **`packages/web/src/experiments/console/lib/drag-payload.test.ts`**
  Unit tests for encode/decode round-trip and malformed-input guard.

## Relevant Research Docstring

- [HTML Drag and Drop API — MDN](https://developer.mozilla.org/en-US/docs/Web/API/HTML_Drag_and_Drop_API)
  - `dataTransfer.setData` / `getData` — used to pass run metadata between
    draggable card and drop zone.
  - `dragover` + `preventDefault()` required to enable dropping.
- [React synthetic drag events — React docs](https://react.dev/reference/react-dom/components/common#drag-events)
  - `onDragStart`, `onDragOver`, `onDrop`, `onDragLeave` prop signatures.
- [bun:test docs](https://bun.sh/docs/test/writing)
  - `mock.module()` / `spyOn` patterns already used throughout the codebase.

## Implementation Plan

### Phase 1: Foundation — Drag Payload Codec

Create the typed drag-transfer codec in `lib/drag-payload.ts` and its
companion test. This decouples card and drop-zone from ad-hoc JSON parsing
and gives the smoke test a stable contract to assert against.

### Phase 2: Core Implementation — Draggable Cards + ExecuteDropZone

1. Add `draggable` + `onDragStart` to `ActiveRunCard` and `RecentRunRow`.
2. Implement `ExecuteDropZone` component: highlights on `dragover`, calls
   `skill.startRun` on `drop`, shows inline error on failure.
3. Mount `ExecuteDropZone` below `RunsFeed` inside `RunsPage` (scoped-project
   view only — `draftProject !== null`).

### Phase 3: Integration — Smoke Test

Write `ExecuteDropZone.test.ts` using `bun:test` + `spyOn` that:
- Imports `ExecuteDropZone`'s drop handler logic (or the codec layer)
- Asserts the `startRun` call signature matches expected args
- Covers happy path + malformed payload guard

## Step by Step Tasks

### Step 1 — Create drag payload codec

- Create `packages/web/src/experiments/console/lib/drag-payload.ts`
  - Export `interface DragPayload { runId: string; projectId: string; workflow: string; message: string; }`
  - Export `encodeDragPayload(run: Run): string` — `JSON.stringify` the subset
  - Export `decodeDragPayload(raw: string): DragPayload | null` — `try/catch` JSON.parse + shape guard
- Create `packages/web/src/experiments/console/lib/drag-payload.test.ts`
  - `describe('encodeDragPayload')` — encodes expected fields
  - `describe('decodeDragPayload')` — round-trip, returns null on invalid JSON, returns null on missing fields

### Step 2 — Make cards draggable

- Edit `packages/web/src/experiments/console/components/ActiveRunCard.tsx`
  - Import `encodeDragPayload` from `../lib/drag-payload`
  - Add `draggable={canOpen}` to the `<article>` element
  - Add `onDragStart` handler that calls `e.dataTransfer.setData('application/archon-run', encodeDragPayload(run))`
- Edit `packages/web/src/experiments/console/components/RecentRunRow.tsx`
  - Same draggable treatment (guard with `run.projectId !== null`)

### Step 3 — Implement ExecuteDropZone component

- Create `packages/web/src/experiments/console/components/ExecuteDropZone.tsx`
  - Props: `{ projectId: string; projectCwd: string }`
  - Local state: `dragActive: boolean`, `error: string | null`, `submitting: boolean`
  - `onDragOver(e)` — `e.preventDefault(); setDragActive(true)`
  - `onDragLeave()` — `setDragActive(false)`
  - `onDrop(e)` — decode payload, call `skill.startRun({ projectId, workflow: 'implement', message })`, invalidate runs cache, handle errors
  - Visual: dashed border zone, accent highlight on hover, spinner while submitting, inline error text
  - Accessible: `role="region"` + `aria-label="Execute drop zone"`

### Step 4 — Mount ExecuteDropZone in RunsPage

- Edit `packages/web/src/experiments/console/routes/RunsPage.tsx`
  - Import `ExecuteDropZone`
  - Render `<ExecuteDropZone projectId={...} projectCwd={...} />` immediately below `<RunsFeed>` when `draftProject !== null`

### Step 5 — Write smoke test for ExecuteDropZone

- Create `packages/web/src/experiments/console/components/ExecuteDropZone.test.ts`
  - `import { describe, test, expect, spyOn, mock } from 'bun:test'`
  - `mock.module('../skills', ...)` to spy on `startRun` — isolate in a separate `bun test` invocation (per `CLAUDE.md` mock isolation rules)
  - Test: happy path — `decodeDragPayload` + `startRun` called with `workflow: 'implement'`
  - Test: malformed payload — `startRun` NOT called, no unhandled error
  - Test: `startRun` rejects — `error` state set

### Step 6 — Update package.json test script

- Edit `packages/web/package.json`
  - Add `bun test src/experiments/` as a separate `bun test` invocation in the `test` script to maintain mock isolation (follow existing `&&`-chained pattern)

### Step 7 — Validate

- Run linter, type check, full test suite (see Validation Commands below)

## Testing Strategy

See `CLAUDE.md` for complete testing requirements. Every file in `src/` must have a corresponding test file in `tests/`.

### Unit Tests

`@bun:test` unit tests (Bun's built-in test runner — the project standard):

- **`drag-payload.test.ts`** — `describe('encodeDragPayload')`, `describe('decodeDragPayload')`:
  round-trip encode/decode, malformed JSON returns null, missing field returns null.
- **`ExecuteDropZone.test.ts`** — drop handler logic:
  happy path calls `startRun` with expected args; malformed payload skips `startRun`; rejected `startRun` sets error state.

### Integration Tests

Not required for this feature — the smoke test covers the full path
(card drag data → codec → skill invocation) in isolation from the network.
Manual curl validation confirms the backend `/api/workflows/implement/run` is
reachable (see Validation Commands).

### Edge Cases

- Drop payload missing `projectId` — decoded as null, drop is a no-op + user sees error
- Drop from a demo run (id starts with `demo-`) — guard in `onDrop`, no `startRun` call
- `startRun` throws `HttpError` — sets inline error string, `submitting` reset to false
- `dragLeave` fires on child element (pointer moves over inner text) — use `relatedTarget` guard or CSS pointer-events trick to avoid flickering `dragActive`
- Multiple rapid drops — `submitting` flag prevents double-submit

## Acceptance Criteria

- [ ] Dragging an `ActiveRunCard` or `RecentRunRow` and dropping it on the
      `ExecuteDropZone` calls `skill.startRun` with `workflow: 'implement'`
      and the run's `projectId` + original `userMessage` as `message`.
- [ ] The drop zone visually indicates drag-over state (accent highlight) and
      resets after drop or drag-leave.
- [ ] The drop zone renders only when a project is scoped (`draftProject !== null`).
- [ ] Demo run cards (`id.startsWith('demo-')`) are draggable for visual demo
      purposes but the drop zone no-ops on them (no `startRun` call).
- [ ] `drag-payload.test.ts` passes: round-trip, null-on-invalid.
- [ ] `ExecuteDropZone.test.ts` passes: happy path + malformed + error state.
- [ ] `bun run validate` exits 0 (lint, type-check, all tests).

## Validation Commands

Execute every command to validate the feature works correctly with zero regressions.

- **Type checking:** `bun run type-check`
- **Lint:** `bun run lint`
- **Format:** `bun run format:check`
- **Unit tests (web package only, fast):**
  ```
  bun test packages/web/src/experiments/console/lib/drag-payload.test.ts
  bun test packages/web/src/experiments/console/components/ExecuteDropZone.test.ts
  ```
- **Full test suite:** `bun run test`
- **Full validation (pre-PR):** `bun run validate`
- **Manual smoke** (server must be running at port 3090):
  ```bash
  # Health check
  curl -s http://localhost:3090/api/health | jq .status

  # Create a project / conversation, then open /console?demo=1 in the browser,
  # drag any run card onto the Execute drop zone, and verify a new run appears
  # in the Active feed.
  ```

**Required validation commands:**

- `bun run lint` — Lint check must pass
- `bun run type-check` — Type check must pass
- `bun run test` — All tests must pass with zero regressions
- `bun run validate` — Full pre-PR gate must pass

## Notes

- **Mock isolation:** `ExecuteDropZone.test.ts` uses `mock.module('../skills', ...)`.
  Per `CLAUDE.md` rules, add it as a separate `bun test` invocation in
  `packages/web/package.json` to avoid polluting other test files that import
  `skills`.
- **Vocabulary:** Use "Execute" (capital E) as the drop-zone label — it maps
  to the `implement` workflow name on the backend. Avoid "Deploy", "Run",
  "Stage" per the console README vocabulary constraints.
- **Design tokens:** `bg-surface-inset`, `border-accent-bright/50`,
  `text-text-tertiary` — all in `packages/web/src/index.css`.
- **Future extension:** once validated, the drop-zone model generalises to
  other workflow targets (Plan, Review) — a `workflow` prop on
  `ExecuteDropZone` would cover it without API changes.
- **Priority:** medium — this is a console experiment, not a production
  surface; it is safe to iterate without a feature flag.
