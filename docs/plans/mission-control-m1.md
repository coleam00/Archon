# Mission Control — M1 implementation plan

Working doc for the milestone defined as "M1 — Mission Control web UI" in `docs/symphoney-legacy/PRD.md`. Captures decisions, phasing, and per-phase scope. Update in place as phases land.

## Goal

A single web surface at `/mission` that lets a single operator observe and control everything archon-symphony is doing — workflow runs, Symphony dispatches, isolation worktrees, approval gates, artifacts, replay history. Replaces the current `/dashboard` and folds in `/symphony`.

## Locked decisions

| # | Decision | Rationale |
|---|---|---|
| 1 | **Two kanbans, distinct semantics.** "Board" tab = workflow-run lifecycle (drag = our lifecycle action). "Symphony" tab = Linear-state kanban (drag = bidi-sync to Linear). | Honors PRD §"out of scope" line 94 (no drag-reorder of Linear ordering — but state transitions ARE bidi). Lets us ship the Board kanban without Linear deps. |
| 2 | **Component libraries: Kibo UI primary + Reui Data Grid for History.** Both MIT, both shadcn-registry style (copy components into the repo, no npm dep). | Kibo has Video Player, Kanban, Calendar, Code Block, Image Zoom, Editor, Status, Pill, Relative Time. Reui's Data Grid is built on TanStack Table + virtual + dnd-kit with pinning, resize, infinite scroll — right for the History table. |
| 3 | **Drawer placement: right-side `Sheet` with URL-hash deep links** (`/mission/board#run/<id>`). | Shareable, doesn't lose context, no full-page nav. |
| 4 | **Bidi Linear sync deferred to Phase 3.** | Real net-new work (new webhook endpoint, write API, cache table). Don't block the visible UI on it. |
| 5 | **Artifact binary serving + manifest deferred to Phase 4.** | Blocks on `GET /api/artifacts/:runId/*` upgrade (currently text-only) — see `~/.claude/projects/.../memory/mission-control-api-gaps.md`. |
| 6 | **`/dashboard` becomes a redirect to `/mission/history`.** Remove from top nav. | One IA, not three. |
| 7 | **Cost / token chips: skipped for now.** PRD explicitly excludes cost dashboards; per-card chip is a fair compromise but not worth fighting about pre-v1. | Easy to add later via `mapWorkflowEvent` extension. |

## Information architecture

```
/mission
├── /board        (default)  — Kanban of in-flight workflow runs (lifecycle drag)
├── /approvals    — Pinned queue of paused runs awaiting human gate
├── /history      — Filterable run history table (replaces /dashboard)
├── /symphony     — Linear-state kanban (read-only Phase 2, bidi Phase 3)
├── /feed         — Live event river
├── /artifacts    — Tile gallery (videos, screenshots, docs)
└── /worktrees    — Active isolation environments per codebase
```

Top of every tab:
- **Status bar** — counts (Running / Paused / Awaiting approval / Failed / Symphony retrying), codebase + workflow + time-range filters, search, "Needs me" badge
- **Detail drawer** — opens on any card click; right-side `Sheet`; URL hash sync

Drawer tabs: Timeline · Artifacts · Conversation · Replay · Raw events.

## Phases

Each phase = one PR. Each is shippable on its own.

### Phase 1A — tab shell + Approvals tab + Needs-me badge *(this session)*

**Scope:** Replace `MissionPage` with a 7-tab shell. Build Approvals end-to-end (filter on existing data — no backend changes). Wire the "Needs me" badge. Keep existing `LiveRunsView` + `HistoryView` working under their tabs.

**Files:**
- New `packages/web/src/components/mission/MissionTabs.tsx` — tab shell + URL routing
- New `packages/web/src/components/mission/MissionStatusBar.tsx` — counts + filters + needs-me badge
- New `packages/web/src/components/mission/ApprovalsTab.tsx` — list paused runs, inline approve/reject
- Modified `packages/web/src/routes/MissionPage.tsx` — wire to tabs
- (No top-nav or `App.tsx` changes yet — keep `/dashboard` and `/symphony` running side-by-side until 1B)

**Out:** Drawer upgrade, kanban, dashboard redirect, Symphony tab content, Live Feed, Artifacts, Worktrees.

**Acceptance:** Visit `/mission`, see 7 tabs (Board/Approvals/History/Symphony/Feed/Artifacts/Worktrees). Approvals tab lists every paused run with an `approval` metadata block; Approve and Reject buttons work inline. The "Needs me" badge in the header pulses with the paused-runs count.

### Phase 1B — drawer upgrade + dashboard redirect + top nav consolidation

**Scope:** Upgrade `RunTimelineDrawer` → `MissionDetailDrawer` with tabs (Timeline / Replay / Raw). Wire URL-hash bookmarking. Add `/dashboard` → `/mission/history` redirect. Remove "Dashboard" from `TopNav`; rename "Mission" prominently.

**Files:**
- Modified `packages/web/src/components/mission/RunTimelineDrawer.tsx` → renamed to `MissionDetailDrawer.tsx` with tab pane
- Modified `packages/web/src/App.tsx` — `/dashboard` redirect
- Modified `packages/web/src/components/layout/TopNav.tsx` — drop Dashboard entry
- New hook `packages/web/src/hooks/useDrawerHash.ts` — sync `?run=<id>` query param ↔ drawer state

**Acceptance:** Click a card from any tab → drawer opens with Timeline/Replay/Raw tabs. Browser URL updates to include `?run=<id>`. Reload preserves drawer state. `/dashboard` 301s to `/mission/history`.

### Phase 2 — Board kanban + Live Feed + Symphony (read-only)

**Scope:** Build the workflow-run kanban with `@dnd-kit` (via Kibo UI), add Live Feed tab, lift `SymphonyKanban` into Symphony tab as a read-only view with click-through.

**Backend additions:**
- `GET /api/symphony/dispatches` (list with filters: status, tracker, codebase, date range) → reads from `symphony_dispatches` table
- `GET /api/symphony/dispatches/:dispatchKey` (detail)

**Component additions (via `npx shadcn add`):**
- Kibo `Kanban`, `Status`, `Pill`, `Relative Time`
- Reui `Data Grid` (replaces `WorkflowHistoryTable` with virtualization)

**Drag rules on Board:**
- Drag any active card → `Cancelled` lane = cancel
- Drag `Awaiting approval` card → `Running` = approve (prompts for optional comment)
- Drag `Awaiting approval` card → `Failed` = reject (prompts for reason)
- Drag `Failed` card → `Running` = resume
- Optimistic UI; rollback on API failure

**Acceptance:** Board shows running runs grouped by lane, drag-to-action triggers the corresponding API. Live Feed shows a chronological river of all events with pause/resume autoscroll. Symphony tab shows a Linear-state kanban (cards = Linear issues from cached/orchestrator snapshot), click-through to dispatch detail in drawer.

### Phase 3 — bidi Linear sync

**Scope:** Make Symphony kanban writable. Drag a card → mutate the Linear issue. Inbound webhooks update the kanban live.

**Backend additions:**
- New table `linear_issues_cache` — id, identifier, state_id, state_name, title, priority, sort_order, assignee, project_id, codebase_id, updated_at, raw_payload
- Migration `024_linear_issues_cache.sql`
- New endpoint `POST /webhooks/linear` with HMAC-SHA256 signature verification (Linear webhook secret)
- New endpoint `GET /api/linear/issues?codebaseId=&state=...` — paginated read
- New endpoint `PATCH /api/linear/issues/:identifier` — proxies to Linear `issueUpdate` mutation
- Extend `packages/symphony/src/tracker/linear.ts` poll loop to fetch the *full backlog*, not just dispatch-eligible issues, and upsert the cache
- Fan out `linear_issue_updated` SSE events on `/api/mission/stream`

**Conflict policy:** Linear wins. Optimistic UI rolls back on next webhook event if the local mutation was rejected.

**Frontend additions:**
- Symphony tab kanban becomes draggable; drag triggers PATCH
- Inbound `linear_issue_updated` events update the cards live

**Acceptance:** Drag a Linear issue from Backlog → In Progress in Mission Control's Symphony tab. Linear's web UI reflects the change within seconds. Drag a different issue from Linear's UI; Mission Control reflects it within the webhook latency. Symphony picks up the dragged-into-active-state issue on the next polling tick (no manual claim needed).

### Phase 4 — artifacts + video review

**Scope:** Artifact gallery tab + per-run artifacts drawer tab. Inline video review. Image, markdown, code preview.

**Backend additions:**
- Upgrade `GET /api/artifacts/:runId/*` to serve binary with MIME detection by extension (mp4, webm, png, jpg, gif, pdf, md, log, txt, json) and `Range` header support — switch from `readFile(.., 'utf-8')` to `Bun.file(filePath)` streaming
- New `GET /api/artifacts/:runId` returning `{ files: [{ path, name, size, mimeType, createdAt }] }` directory manifest
- Persist `workflow_artifact` events to `workflow_events` (currently emit-only) so the gallery survives a restart

**Component additions (Kibo):** `Video Player`, `Image Zoom`, `Code Block`. Add `react-markdown` for `.md` rendering (no Kibo equivalent).

**Frontend:** Artifact gallery tile grid filtered by type, click to preview. Drawer's Artifacts tab shows per-run files with the same preview component.

**Acceptance:** A workflow that writes an `.mp4` to `$ARTIFACTS_DIR/screen.mp4` shows up as a tile in the gallery, plays inline with seek controls.

### Phase 5 — worktrees tab + polish

**Scope:** Worktrees tab. Final IA polish, mobile pass.

**Frontend:**
- Worktrees tab — per-codebase list of `isolation_environments`, columns (branch, workflow type, status, created, last active, linked run), "Complete" action (delete worktree + branch)
- Mobile: drawer becomes full-screen modal; tabs collapse to bottom-nav

**Acceptance:** Item 5 of PRD's vision-level success criteria — operator hasn't opened a database client, log file, or JSON log line in the last week. Mission Control is sufficient.

## Out of scope (won't ship in M1)

- Editing workflow YAML from Mission Control — that's M2 (Harness Builder)
- Sending messages to a running agent mid-run — engine doesn't support it; needs separate design
- Cost / budget dashboards — PRD explicitly excludes
- Multi-tenant filters — single operator
- Native mobile app — phone-friendly responsive web only
- Auto-merge of PRs — every PR stays human-reviewed

## Backend gap tracker

Tracks the API gaps documented in `~/.claude/projects/-Users-desha-archon-symphony/memory/mission-control-api-gaps.md`:

| Gap | Phase | Status |
|---|---|---|
| Artifact handler text-only (corrupts binaries) | 4 | open |
| No artifact directory manifest endpoint | 4 | open |
| No `GET /api/symphony/dispatches` REST | 2 | open |
| `mapWorkflowEvent` drops cost/token fields | (optional) | open |
| Replay schema | — | shipped |

## Component install commands (for future phases)

```bash
# Phase 2 — kanban + table
cd packages/web
bunx shadcn@latest add https://kibo-ui.com/r/kanban.json
bunx shadcn@latest add https://kibo-ui.com/r/status.json
bunx shadcn@latest add https://kibo-ui.com/r/pill.json
bunx shadcn@latest add https://kibo-ui.com/r/relative-time.json
# Reui Data Grid: copy from https://reui.io/docs/components/base/data-grid

# Phase 4 — artifacts
bunx shadcn@latest add https://kibo-ui.com/r/video-player.json
bunx shadcn@latest add https://kibo-ui.com/r/image-zoom.json
bunx shadcn@latest add https://kibo-ui.com/r/code-block.json
bun add react-markdown
```

(Verify exact registry URLs against `kibo-ui.com/components/<name>` and `reui.io/docs/components/base/<name>` before running — they may have changed.)
