# @archon/symphony

Autonomous tracker-driven dispatch on top of Archon workflows.

Symphony polls Linear and GitHub for issues that match a configured state, claims dispatch slots, and launches an Archon workflow run per issue. The kanban lives at `/symphony` in the web UI; each card deep-links into the existing `/workflows/runs/:runId` drill-through page.

This package replaces the standalone [`Ddell12/symphoney-codex`](https://github.com/Ddell12/symphoney-codex) repo. The dispatch policy (trackers, slots, retries, state→workflow mapping) lives here; the agent loop, per-issue worktrees, and PR publishing are delegated to Archon's existing workflow executor and isolation packages.

## Setup

```bash
cp packages/symphony/symphony.yaml.example ~/.archon/symphony.yaml
```

Edit `~/.archon/symphony.yaml` and set:

- **`trackers`** — one entry per Linear project and/or GitHub repo to poll. Uses `$LINEAR_API_KEY`, `$LINEAR_PROJECT_SLUG`, `$GITHUB_TOKEN` env-var substitution.
- **`dispatch.max_concurrent`** and `max_concurrent_by_state` — global and per-state slot caps.
- **`dispatch.retry`** — backoff bounds (continuation vs. failure delays, max backoff).
- **`polling.interval_ms`** — how often to poll trackers (default 30s).
- **`state_workflow_map`** — case-sensitive issue state → Archon workflow name.
- **`codebases`** — per-tracker repository → Archon `codebase_id` mapping.

Required environment variables (loaded from the repo's `.env`):

```
LINEAR_API_KEY=...
LINEAR_PROJECT_SLUG=...
GITHUB_TOKEN=...
```

## Codebase mapping

Symphony does not register codebases on its own. Each `codebases:` entry must reference a `codebase_id` that already exists in Archon — either created via the Web UI's project page or via `POST /api/codebases`.

```yaml
codebases:
  - tracker: linear
    repository: Ddell12/archon-symphony
    codebase_id: <uuid-from-archon>
  - tracker: github
    repository: Ddell12/archon-symphony
    codebase_id: <uuid-from-archon>
```

`codebase_id: null` is accepted but the dispatcher will skip those issues with a `symphony.dispatch_skipped` log line — useful for sandbox configs but not for production.

## Startup

Symphony auto-starts whenever `~/.archon/symphony.yaml` exists. The Archon server checks for the file at boot (`packages/server/src/index.ts:maybeStartSymphony`); if absent, the server runs without Symphony and emits `symphony.disabled_no_config`.

```bash
bun run dev
```

This starts the Archon server (default port 3090) and the Vite dev server for the web UI (default port 5173). Once up, the Symphony orchestrator polls trackers in the background and `/api/symphony/*` routes are registered.

To run only the server:

```bash
bun run dev:server
```

## Where the kanban lives

`/symphony` in the web UI (added in Phase 4 of the consolidation). The kanban groups dispatches by lifecycle / status / repository and polls `/api/symphony/state` every 5s. Each card has a **View Run** link that navigates to `/workflows/runs/:runId` — the same drill-through page Archon already uses for workflow runs.

Source: `packages/web/src/routes/SymphonyPage.tsx`, `packages/web/src/components/symphony/`.

## API surface

All routes registered under `/api/symphony/*` (see `packages/server/src/routes/api.symphony.ts` for full schemas):

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/symphony/state` | Current orchestrator snapshot — running, claimed, retry queue, completed |
| GET | `/api/symphony/dispatches` | List dispatch rows (joined with workflow run status) |
| GET | `/api/symphony/dispatches/{id}` | Single dispatch detail |
| POST | `/api/symphony/dispatch` | Immediate-dispatch request (still respects slot caps) |
| POST | `/api/symphony/cancel` | Cancel a non-terminal dispatch |
| POST | `/api/symphony/refresh` | Force a tracker poll cycle (coalesced) |

## Package exports

```typescript
import {
  startSymphonyService,
  Orchestrator,
  LinearTracker,
  GitHubTracker,
  buildSnapshot,
  parseSymphonyConfig,
  createProductionBridge,
} from '@archon/symphony';
```

See `packages/symphony/src/index.ts` for the full export list (types and runtime values). The server is the only consumer of `startSymphonyService` today; the rest is exposed for tests and future tooling.

## Parity with the symphoney-codex SPEC

What this package still implements from `docs/symphoney-legacy/SPEC.md`:

- Tracker polling (Linear + GitHub) with normalized `Issue` shape
- Slot accounting (global and per-state)
- Retry kinds: `continuation` (rate-limit / soft) and `failure` (hard)
- Source-aware `dispatch_key` (`linear:<id>` / `github:<owner>/<repo>#<n>`) for state and persistence
- Immediate-dispatch endpoint with slot enforcement

What this package intentionally drops, delegating to Archon:

- **In-process agent loop** (`runWorker` in symphoney-codex) → replaced by `executeWorkflow(...)` in `@archon/workflows`
- **Per-issue worktree management** → handled by `@archon/isolation`
- **Publisher / `linear_graphql` Done transition** → owned by per-workflow YAML inside `.archon/workflows/`
- **Workflow file (`WORKFLOW.md` Liquid prompt + `agent:`/`codex:`/`claude:` blocks)** → split: dispatch policy lives in `~/.archon/symphony.yaml`, per-state behavior lives in Archon workflow definitions

For the full deprecation rationale and SPEC-clause coverage table, see `docs/symphoney-legacy/PARITY_REPORT.md`.

## Migration from symphoney-codex

If you previously ran the standalone `symphoney-codex` daemon:

1. **Move dispatch policy to `~/.archon/symphony.yaml`.** The new schema is documented in `symphony.yaml.example`. There is no top-level `agent:`, `codex:`, or `claude:` block — those settings move to per-workflow YAML.
2. **Convert your `WORKFLOW.md` prompt and per-state behavior to Archon workflow definitions** in `.archon/workflows/`. Each entry in `state_workflow_map` references one of these workflows by name.
3. **Register your codebases in Archon** (Web UI or `POST /api/codebases`) and put the resulting `codebase_id` into the `codebases:` mapping.
4. **Drop your standalone daemon process.** The Archon server now owns Symphony's lifecycle; `bun run dev` is the new entry point.

The `web/` Next 16 kanban from symphoney-codex is retired. The replacement at `/symphony` in Archon's React app does the same job and shares Archon's auth, layout, and run drill-through.
