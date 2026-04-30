# Archon-Symphony Consolidation Implementation Plan

**Goal:** Land Symphoney's autonomous tracker-driven dispatch (LinearTracker, orchestrator, slot accounting, retries) inside a fork of Archon as `packages/symphony/`, replacing Symphoney's `runWorker` agent loop with a small launcher around Archon's existing workflow executor/orchestrator path. Surface Symphoney's kanban as a `/symphony` route in Archon's web UI. Retire `symphoney-codex/web/` once parity is verified.

**Architecture:** Symphoney becomes a Bun workspace package inside `Ddell12/archon-symphony` (forked from `coleam00/Archon`). The orchestrator polls Linear AND GitHub for candidate issues, claims dispatch slots, and instead of running its own agent loop, invokes Archon's existing workflow execution path (`executeWorkflow(...)` or a wrapper around `dispatchBackgroundWorkflow(...)`) per issue. A `symphony_dispatches` table joins `issue_id ↔ remote_agent_workflow_runs.id` so Archon's existing run UI handles execution drill-down while a new `/symphony` page shows the kanban. Archon supports both PostgreSQL migrations and SQLite adapter schema creation; Symphony must update both paths. Approval gates skipped in v1.

**Tech Stack:** Bun + Hono + OpenAPIHono (server), React 19 + Vite + react-router + TanStack Query + shadcn (web), Zod schemas, PostgreSQL migrations under `migrations/` plus SQLite schema updates in `packages/core/src/db/adapters/sqlite.ts`. Reuses Archon's existing `@archon/{git,isolation,providers,workflows,paths}` packages — no need to port Symphoney's worktree, hook, or agent-backend code.

**Verification baseline (2026-04-30):** Checked against `coleam00/Archon` branch `dev` at commit `2945f2ec051fe24e0926a4efd2157b7d68bfbe03` (`fix(homebrew): restore v0.3.10 formula on dev (#1491)`). The findings below are incorporated into the phase steps.

**Plan corrections from verification:**
- PostgreSQL FK columns that point at Archon tables must use `UUID`, not `TEXT` (`remote_agent_workflow_runs.id` and `remote_agent_codebases.id` are UUID in PostgreSQL). SQLite remains `TEXT`.
- The server process must own or be able to reach a live Symphony service instance. Adding `/api/symphony/*` routes is not enough by itself.
- `dispatchBackgroundWorkflow(...)` currently returns `void`; Phase 3 must either pre-create the workflow run and call `executeWorkflow(...)`, or change/wrap the background dispatcher so it returns the pre-created `workflow_run_id`.
- Multi-tracker state must use a source-aware key, not plain `issue.id`, to avoid collisions between Linear and GitHub.
- The Archon web package does not currently have Vitest or React Testing Library. Component-test instructions must either add those dependencies intentionally or use Bun-compatible tests.
- If the `/symphony` UI keeps the existing "New issue" workflow, the API must include `POST /api/symphony/issues`.

---

## Scope Note: Phased Plan, Just-In-Time Detail

This document covers **6 phases** spanning ~2-3 weeks for a solo developer. Writing every step in full bite-sized detail today would generate stale guesses for Phases 3-5 (which depend on the actual fork structure and DB schema decisions made in earlier phases).

**Convention used in this doc:**
- **Phase 0 is the only phase fully expanded into bite-sized tasks** — it's blocking, immediate, and entirely scoped to the current symphoney-codex repo where all context is known.
- **Phases 1-5 each have a "phase plan" section** with goal, files, sub-task list, exit criteria, and verification gates. When ready to execute Phase N, run the writing-plans skill again with that phase's section as input to expand into bite-sized tasks. Each expanded phase plan saves to `docs/superpowers/plans/2026-MM-DD-phase-N-<slug>.md`.
- **Each phase ends in a verifiable checkpoint** (working software, all tests green, parity demonstrated) before the next begins.

Why this is correct, not hand-waving: Phase 0 fixes a known bug in current code. Phase 1 produces a fork structure we can read and reason about. Phase 2's port decisions depend on what migrations and types Phase 1 establishes. Late phases benefit from intermediate discoveries.

---

## File Structure Overview

### Phase 0 (in `/Users/desha/symphoney-codex`)

| File | Action | Responsibility |
|---|---|---|
| `src/orchestrator/orchestrator.ts:820-885` | Modify | `reconcileRunningIssues` — invoke publisher BEFORE workspace removal on terminal state |
| `WORKFLOW.md:82` | Modify | Prompt instructs agent to `git add -A && git commit` before `linear_graphql` Done transition |
| `test/integration/orchestrator-reconcile-publish.test.ts` | Create | New integration test for the publish-before-cleanup contract |
| `/Users/desha/.claude/projects/-Users-desha-symphoney-codex/memory/bug-reconcile-data-loss.md` | Modify | Mark bug fixed; record commit SHA |

### Phases 1-5 (in `Ddell12/archon-symphony` fork — to be created)

| Path | Phase | Responsibility |
|---|---|---|
| `packages/symphony/src/index.ts` | 1 | Package entry, exports `startSymphonyService` |
| `packages/symphony/src/orchestrator/{orchestrator,dispatch,state,retry}.ts` | 2 | Ported from symphoney-codex `src/orchestrator/` |
| `packages/symphony/src/tracker/{linear,github,types,normalize}.ts` | 2 | LinearTracker (port) + GitHubTracker (new, reads `GITHUB_TOKEN`/shared config; do not assume Archon adapter token discovery) |
| `packages/symphony/src/config/{snapshot,parse}.ts` | 2 | Port of WORKFLOW.md → ConfigSnapshot, adapted to new YAML schema (no `agent:` block) |
| `packages/symphony/src/workflow-bridge/dispatcher.ts` | 3 | Replaces `runWorker`; calls Archon's existing workflow executor/orchestrator path and monitors run status |
| `packages/symphony/src/db/dispatches.ts` | 1, 3 | CRUD for `symphony_dispatches` table across Archon's DB adapter layer |
| `migrations/<NNN>_symphony_dispatches.sql` | 1 | PostgreSQL migration joining `issue_id ↔ remote_agent_workflow_runs.id`, attempt count, dispatched_at. Use UUID for Archon FKs in Postgres. `NNN` = next free number after fork (`022` as of 2026-04-30). |
| `packages/core/src/db/adapters/sqlite.ts` | 1 | SQLite schema/migration update for `symphony_dispatches` |
| `packages/server/src/index.ts` | 3 | Start/own the Symphony service or register a reachable singleton during Archon server startup |
| `packages/server/src/routes/api.ts` or `packages/server/src/routes/api.symphony.ts` | 3 | New API namespace `/api/symphony/*` (state, issues, issue creation, dispatch, refresh, cancel), following current route registration style |
| `packages/web/src/routes/SymphonyPage.tsx` | 4 | New route, listed in App.tsx; hosts kanban |
| `packages/web/src/components/symphony/*.tsx` | 4 | Kanban components ported from symphoney-codex `web/src/lib/symphony/` |
| `packages/web/src/App.tsx` and `packages/web/src/components/layout/TopNav.tsx` | 4 | Add `<Route path="/symphony">` and primary nav tab |
| `~/.archon/symphony.yaml` | 2 | Replaces WORKFLOW.md as runtime config (no agent block; per-state `workflow:` key) |

### Phase 5 (cleanup in `/Users/desha/symphoney-codex`)

| Path | Action |
|---|---|
| `web/` | Delete (Next.js workspace retired) |
| `pnpm-workspace.yaml` | Remove `web` |
| `package.json` scripts | Remove retired `web:*`, `dev:all`, and `build:all` scripts |
| `PARITY_REPORT.md` | Append "deprecated; replaced by archon-symphony fork" section |
| `CLAUDE.md` | Update — point at fork, mark this repo archived/maintenance-only |

---

## Phase Index

### Phase 0: Fix reconcile-terminal data-loss bug (PREREQUISITE)
**Where:** `/Users/desha/symphoney-codex` (current repo)
**Status:** Detailed below in full bite-sized form.
**Exit criteria:** New integration test passes; full `pnpm test && pnpm typecheck` green; manual dogfood with a Linear test issue confirms work survives the agent transitioning to Done.

**Related known issue, not fixed by Phase 0:** The 2026-04-30 incident also records a service hot-reload bug: `src/service.ts` constructs the agent client once, so runtime config/protocol changes may not affect existing service instances. Phase 0 still exits if the daemon is started fresh for the dogfood test, but fix that hot-reload issue before relying on live config swaps during the Archon migration.

### Phase 1: Fork Archon, scaffold packages/symphony, wire DB schema
**Where:** New fork `Ddell12/archon-symphony` (to be created from `coleam00/Archon`)
**Estimated duration:** 1-2 days
**Goal:** Empty-but-buildable `packages/symphony` workspace package. PostgreSQL and SQLite schema paths both know about `symphony_dispatches`. No behavior yet.

**Sub-tasks (to be expanded into bite-sized plan when starting):**
1. `gh repo fork coleam00/Archon --fork-name archon-symphony --org Ddell12 --clone` into `~/archon-symphony`
2. Create branch `phase-1-scaffold`
3. Add `packages/symphony/{package.json,tsconfig.json,src/index.ts}` following the shape of an existing simple package (`packages/git` is a good model). Prefer package name `@archon/symphony` to match the upstream monorepo namespace unless the fork intentionally chooses another scope.
4. Wire the package into Archon's existing Bun workspace/package patterns. Verify root `package.json`, `bunfig.toml`, and package exports against the current fork instead of guessing.
5. Create the next-available migration `migrations/<NNN>_symphony_dispatches.sql`.
   - PostgreSQL table shape: `id UUID PRIMARY KEY DEFAULT gen_random_uuid(), issue_id TEXT NOT NULL, identifier TEXT NOT NULL, tracker TEXT CHECK (tracker IN ('linear','github')), dispatch_key TEXT NOT NULL UNIQUE, codebase_id UUID NULL REFERENCES remote_agent_codebases(id) ON DELETE SET NULL, workflow_name TEXT NOT NULL, workflow_run_id UUID NULL REFERENCES remote_agent_workflow_runs(id) ON DELETE SET NULL, attempt INTEGER NOT NULL, dispatched_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(), status TEXT NOT NULL, last_error TEXT NULL`.
   - Indexes: `(tracker, issue_id)`, `(identifier)`, `(workflow_run_id)`, `(codebase_id)`.
   - `dispatch_key` is the source-aware key used by the orchestrator, e.g. `linear:<issue_id>` or `github:<owner>/<repo>#<number>`.
   - SQLite equivalent in `packages/core/src/db/adapters/sqlite.ts` uses `TEXT` IDs and `datetime('now')`.
   - As of 2026-04-30 upstream's last migration is `021_add_allow_env_keys_to_codebases.sql` so today this would be `022_symphony_dispatches.sql`, but pick the actual next free number after the fork is created — upstream may have advanced.
6. Update `migrations/000_combined.sql` if Archon's current fresh-Postgres bootstrap expects combined migrations to include new tables.
7. Update `packages/core/src/db/adapters/sqlite.ts` so fresh SQLite databases create `symphony_dispatches`, and add a `migrateColumns()`/schema-version-safe path if the adapter needs to upgrade existing `~/.archon/archon.db` files.
8. Apply/verify the PostgreSQL migration path and the SQLite path separately. Study `packages/core/src/db/connection.ts`, `packages/core/src/db/adapters/postgres.ts`, and `packages/core/src/db/adapters/sqlite.ts` for the actual pattern.
9. Create `packages/symphony/src/db/dispatches.ts` with typed `insertDispatch / getDispatchByIssueId / updateStatus / attachWorkflowRun` functions, mirroring the repository/db style already used in `packages/core/src/db/*`.
10. Add unit tests `packages/symphony/src/db/dispatches.test.ts` using bun:test and the real Archon DB test patterns. Do not assume `packages/core/src/test/mocks/database.ts` is a SQLite mock; verify the helper before using it.
11. Run the package-specific test command after confirming Bun's filter syntax for this repo, e.g. `bun test packages/symphony/src` or the repo's established package filter.
12. Commit: `feat(symphony): scaffold packages/symphony with dispatches table`

**Exit criteria:** `bun install && bun run build && bun run test` green at the fork root. New table visible in fresh SQLite via `sqlite3 ~/.archon/archon.db ".schema symphony_dispatches"` and in the PostgreSQL migration output. CI workflow file copied/extended to include `packages/symphony` in the test matrix.

### Phase 2: Port tracker + orchestrator + dispatch/retry/snapshot
**Where:** `Ddell12/archon-symphony` branch `phase-2-orchestrator`
**Estimated duration:** 4-6 days
**Goal:** `startSymphonyService(configPath)` polls Linear+GitHub, computes eligibility, manages slots, schedules retries — but `dispatchIssue` is a stub that just logs (Phase 3 wires the workflow call).

**Sub-tasks (to be expanded):**
1. Port `src/tracker/{types.ts,normalize.ts,linear.ts}` → `packages/symphony/src/tracker/`. Adjust imports (.js → resolve via Bun ESM) and re-use Archon's GraphQL client conventions if any
2. Write `packages/symphony/src/tracker/github.ts` implementing the same `Tracker` interface using GitHub's REST/GraphQL — auth via `GITHUB_TOKEN` or a shared Archon config/env helper. Archon's current GitHub adapter receives a constructor token and separately uses `GITHUB_TOKEN`/`GH_TOKEN` for repository clone auth; do not assume a reusable tracker-token discovery API exists.
3. Port `src/orchestrator/{state.ts,dispatch.ts,retry.ts,orchestrator.ts}`. Strip `agent:`, `codex:`, `claude:` from snapshot — those move to per-workflow YAML inside Archon.
4. During the orchestrator port, replace plain `issue.id` state keys with a source-aware `dispatch_key` (`${tracker}:${issue.id}` or an equivalent normalized key). `running`, `claimed`, `retry_attempts`, and `completed` must all key by `dispatch_key`; persisted rows should retain both `tracker` and original `issue_id`.
5. Port `src/config/snapshot.ts` and `src/workflow/parse.ts` → `packages/symphony/src/config/`. New schema accepts: `trackers: [{kind, ...}]`, `dispatch.{slots,retry_attempts,...}`, `state_workflow_map: {Todo: archon-feature-development, ...}`, and codebase mapping/resolution config such as `codebases: [{tracker, repository, codebase_id?}]` or a deterministic repository-to-Archon-codebase resolver.
6. Stub `dispatchIssue` to log + write a `symphony_dispatches` row with `workflow_run_id: null`
7. Port relevant unit tests: `test/unit/{config-snapshot,tracker-normalize,orchestrator-dispatch}.test.ts` → `packages/symphony/src/**/*.test.ts`
8. Port relevant integration tests from `test/integration/orchestrator.test.ts` (just the polling/dispatch/retry shape, omit publisher/agent specifics)
9. Add a multi-tracker integration test: Linear+GitHub both configured, candidate issues come from both, slot accounting unified, and same raw issue ID from two trackers does not collide because `dispatch_key` differs
10. Run `bun run test` — green
11. Commit: `feat(symphony): port tracker + orchestrator (dispatch stubbed)`

**Exit criteria:** Wire a sandbox config (`~/.archon/symphony.yaml` pointing at Symphony Smoke + a throwaway GitHub repo), run `bun packages/symphony/src/cli/dev.ts` (a thin entrypoint to be added), confirm logs show `dispatch_skipped (workflow not yet wired)` on at least one Linear and one GitHub candidate.

### Phase 3: Replace runWorker with Archon workflow launch
**Where:** `Ddell12/archon-symphony` branch `phase-3-workflow-bridge`
**Estimated duration:** 3-5 days
**Goal:** A claimed issue triggers an actual Archon workflow run. The dispatcher monitors `remote_agent_workflow_runs.status` and translates terminal states back into Symphony retry/completion semantics.

**Sub-tasks (to be expanded):**
1. Read `packages/workflows/src/executor.ts`, `packages/core/src/orchestrator/orchestrator.ts`, `packages/workflows/src/event-emitter.ts`, `packages/workflows/src/schemas/workflow-run.ts`, and `packages/server/src/routes/api.ts` to understand the real workflow execution path. Do not assume there is a public internal `runWorkflow({ ... })` helper — upstream currently exposes `executeWorkflow(...)`, background workflow orchestration helpers, event emitters, and the REST route that dispatches a `/workflow run ...` command.
2. Decide the launch mechanism explicitly before writing the dispatcher:
   - Preferred for v1: pre-create the workflow run row through Archon's workflow store, persist that ID to `symphony_dispatches`, then call `executeWorkflow(...)` with `preCreatedRun`.
   - Acceptable alternative: modify or wrap `dispatchBackgroundWorkflow(...)` so it returns `{ workflowRunId, workerPlatformId }` after pre-creation. Do not depend on today's upstream `dispatchBackgroundWorkflow(...)` returning a run ID; it currently returns `void`.
3. Write `packages/symphony/src/workflow-bridge/dispatcher.ts:dispatchToWorkflow(entry, snap)` that:
   - Resolves workflow name from `snap.state_workflow_map[entry.issue.state]`
   - Resolves target Archon `codebase_id` and `cwd` from the Phase 2 codebase mapping/resolver. Workflow execution requires a working directory; do not infer it from the tracker issue alone.
   - Resolves the workflow definition using Archon's existing workflow discovery/parsing utilities, or delegates through the core background workflow helper if that already resolves workflow names correctly
   - Renders the issue context as the initial message (Liquid template optional in v1, simple string interpolation OK)
   - Launches the run through `executeWorkflow(...)` or a thin wrapper around `dispatchBackgroundWorkflow(...)`, supplying the codebase/cwd/conversation context Archon requires
   - Persists `workflow_run_id` into `symphony_dispatches` before or immediately after launch, while the ID is definitely known
   - Subscribes to workflow events via `getWorkflowEventEmitter()` when running in-process, else polls `remote_agent_workflow_runs.status`
   - On terminal status: `completed` → `state.completed.add(issue_id)`; `failed` → schedule retry with kind `failure`; `cancelled` → no retry
4. Wire dispatcher into the `dispatchIssue` slot from Phase 2
5. Wire the Symphony service into the Archon server process. Add startup/shutdown ownership in `packages/server/src/index.ts` or a clean module it calls, so API routes can access the live orchestrator. Do not leave `startSymphonyService(configPath)` as an unreferenced package export.
6. Add `/api/symphony/*` routes in the same style as upstream Archon's current server routing. Today workflow routes are centralized in `packages/server/src/routes/api.ts`, not an `api.workflows.ts` module; either add Symphony routes there or intentionally split a new `api.symphony.ts` and register it cleanly. Endpoints: `GET /state`, `GET /issues`, `POST /issues` (if keeping the "New issue" UI), `GET /repositories`, `POST /dispatch`, `POST /:identifier/cancel`, `GET /:identifier`, `POST /refresh`.
7. If using a split route module, register it in the current server bootstrap/route registration path after verifying the actual call site and dependency injection shape.
8. Integration test: configured workflow `e2e-deterministic` (Archon's existing repo-local test workflow) — Symphony detects an issue, dispatches, the workflow runs, Symphony marks completed. Use a fake tracker fixture
9. Manual smoke: `~/.archon/symphony.yaml` points at Symphony Smoke + workflow `archon-assist` or another installed workflow. Create a Linear issue, verify the issue → workflow run → Archon dashboard chain
10. Commit: `feat(symphony): bridge dispatch to Archon workflow runs`

**Exit criteria:** A single Linear issue triggers an end-to-end run visible in Archon's workflow run UI, and the run's terminal status updates the symphony orchestrator's internal state correctly. `curl http://127.0.0.1:3090/api/symphony/state` returns expected JSON.

### Phase 4: Symphony page in Archon web UI
**Where:** `Ddell12/archon-symphony` branch `phase-4-web-page`
**Estimated duration:** 3-4 days
**Goal:** `/symphony` route in Archon's web app shows the kanban (lifecycle/status/repository toggle), polls `/api/symphony/state`, links each card to the existing `/workflows/runs/:runId` Archon page.

**Sub-tasks (to be expanded):**
1. Port `web/src/lib/symphony/{client.ts,group.ts,transform.ts,types.ts}` → `packages/web/src/lib/symphony/`. Replace fetch URLs with Archon's `/api/symphony/*` namespace. Drop the legacy `use-issue-detail.ts` if there's no dedicated detail page
2. Port `web/src/lib/symphony/use-kanban.ts` → `packages/web/src/lib/symphony/use-kanban.ts`. Migrate from raw fetch+useEffect polling to TanStack Query (`useQuery({ refetchInterval: 5000, refetchIntervalInBackground: false })`) — TanStack Query is the dominant data-fetch convention in `packages/web/src/` (see consumers of `packages/web/src/lib/api.ts` for `useQuery({ refetchInterval })` examples). Note: `useDashboardSSE.ts` is an SSE hook, NOT a polling model — don't copy from it
3. Port the kanban column / card components into `packages/web/src/components/symphony/`. Re-skin to use Archon's shadcn primitives (Card, Badge, Tooltip from `packages/web/src/components/ui/`) instead of the legacy Tailwind/Phosphor
4. Create `packages/web/src/routes/SymphonyPage.tsx` — top-level page with the group-by toggle, kanban, and a link `View Run →` that uses `react-router`'s `<Link to={`/workflows/runs/${dispatch.workflow_run_id}`}>` to drill into Archon's existing run UI
5. Add `<Route path="/symphony" element={<SymphonyPage />} />` to `packages/web/src/App.tsx`
6. Add a primary navigation tab to `packages/web/src/components/layout/TopNav.tsx` (icon: existing lucide `Workflow` or `Inbox`). Do not put this in `Sidebar.tsx`; upstream Sidebar is the project/conversation list, not the global nav.
7. Wire dispatch button: `POST /api/symphony/dispatch` (Symphony's existing immediate-dispatch endpoint mapping)
8. Tests for the new page:
   - Current upstream web package uses Bun tests and does not include Vitest or React Testing Library. Either add those dependencies intentionally and document why, or keep tests at the lib/transform/hook boundary with Bun-compatible tests.
   - At minimum test `client.ts`, grouping/transform logic, and the `workflow_run_id` link construction.
9. Manual smoke: full E2E. Create a Linear issue, watch it appear on `/symphony`, click "View Run", land on `/workflows/runs/:id`
10. Commit: `feat(web): symphony kanban page with workflow-run drill-through`

**Exit criteria:** `/symphony` is reachable, lists all running/queued/completed dispatches grouped by lifecycle/status/repository, polls every 5s, and each card deep-links into Archon's run UI. No console errors, no CORS issues.

### Phase 5: Retire symphoney-codex/web/ + consolidate docs
**Where:** Both `/Users/desha/symphoney-codex` AND `Ddell12/archon-symphony`
**Estimated duration:** 1 day
**Goal:** symphoney-codex repo becomes archived/maintenance-only. Single source of truth in the fork.

**Sub-tasks (to be expanded):**
1. In `archon-symphony`: write `packages/symphony/README.md` covering setup (`cp ~/.archon/symphony.yaml.example ~/.archon/symphony.yaml`, set `LINEAR_API_KEY`+`GITHUB_TOKEN`), codebase mapping, startup (`bun run dev` runs server and web; server defaults to 3090, Vite web defaults to 5173 in dev), parity-with-spec note
2. In `archon-symphony`: update root `README.md` to mention the fork's value-add (autonomous dispatch on top of Archon's workflows)
3. In `symphoney-codex`: delete `web/` workspace directory
4. In `symphoney-codex/pnpm-workspace.yaml`: remove the `web` workspace entry
5. In `symphoney-codex/package.json`: drop `web:*` and `dev:all` / `build:all` scripts
6. In `symphoney-codex/CLAUDE.md`: add banner at top — "ARCHIVED: development moved to Ddell12/archon-symphony as of 2026-MM-DD. This repo is maintenance-only for the standalone Symphoney binary."
7. In `symphoney-codex/PARITY_REPORT.md`: append a "Deprecation" section pointing at the fork
8. Verify `pnpm test && pnpm typecheck && pnpm build` still green in symphoney-codex (without web/) so the standalone binary keeps working for anyone using v1
9. Tag final symphoney-codex release: `git tag v1-final-pre-archon-merge && git push --tags`
10. In `archon-symphony`: cut a v0.1 release tag for the consolidated build
11. Update memory file `archon-integration.md` — mark consolidation complete, record commit SHAs

**Exit criteria:** symphoney-codex builds without `web/`. archon-symphony has a green CI run, an `0.1` tag, and a working `bun run dev` starting both server and web on port 3090 with `/symphony` reachable.

---

## Phase 0 — FULL BITE-SIZED PLAN

**All work in `/Users/desha/symphoney-codex` (current repo).** Daemon should not be running on `main` during this phase.

### Task 1: Create the failing integration test

**Files:**
- Create: `test/integration/orchestrator-reconcile-publish.test.ts`

- [ ] **Step 1.1: Write the failing test**

Mirror the structure of the existing `test/integration/orchestrator.test.ts` (it already imports the helpers and snapshot builder you need).

```typescript
// test/integration/orchestrator-reconcile-publish.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { Orchestrator } from "../../src/orchestrator/orchestrator.js";
import { createWorkspaceManager } from "../../src/workspace/manager.js";
import { buildSnapshot, type ConfigSnapshot } from "../../src/config/snapshot.js";
import { parseWorkflowContent } from "../../src/workflow/parse.js";
import type { PublishPullRequest } from "../../src/publisher/pr.js";
import { makeFakeAgentClient } from "../../src/agent/fake-client.js";
import { makeFakeTracker, makeIssue } from "../helpers/fake-tracker.js";

function buildSnap(
  root: string,
  opts: { maxConcurrent?: number; stallTimeoutMs?: number } = {},
): ConfigSnapshot {
  const max = opts.maxConcurrent ?? 2;
  const stall = opts.stallTimeoutMs ?? 0;
  const yaml = `tracker:
  kind: linear
  api_key: $K
  project_slug: p
polling:
  interval_ms: 1000000
agent:
  max_concurrent_agents: ${max}
  max_turns: 3
codex:
  command: codex app-server
  turn_timeout_ms: 5000
  read_timeout_ms: 1000
  stall_timeout_ms: ${stall}
workspace:
  root: ${root}`;
  const def = parseWorkflowContent(`---\n${yaml}\n---\nbody for {{ issue.identifier }}\n`);
  return buildSnapshot(join(root, "WORKFLOW.md"), def, { K: "tok" } as NodeJS.ProcessEnv);
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 1000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const ok = await predicate();
    if (ok) return;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

const silentLogger = pino({ level: "silent" });

describe("reconcile-terminal publishes BEFORE removing workspace (Phase 0 bug fix)", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "sym-reconcile-pub-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("calls publishPullRequest before workspace removal when issue moves to terminal mid-run", async () => {
    const snapshot = buildSnap(root);
    const issue = makeIssue({ id: "i1", identifier: "MT-1", state: "In Progress" });
    const { tracker, controls } = makeFakeTracker([issue]);
    const { client, controller } = makeFakeAgentClient();
    controller.scriptForIssue("i1", [{ kind: "stall", durationMs: 200 }]);

    const callOrder: string[] = [];
    const publishSpy = vi.fn<PublishPullRequest>(async () => {
      callOrder.push("publish");
      return { url: "https://github.com/Ddell12/symphoney-codex/pull/999" };
    });
    const baseWorkspaces = createWorkspaceManager({ getSnapshot: () => snapshot });
    const workspaces = {
      ...baseWorkspaces,
      removeForIssue: vi.fn(async (...args: Parameters<typeof baseWorkspaces.removeForIssue>) => {
        callOrder.push("remove");
        return baseWorkspaces.removeForIssue(...args);
      }),
    };

    const orch = new Orchestrator({
      getSnapshot: () => snapshot,
      tracker,
      agent: client,
      workspaces,
      logger: silentLogger,
      publishPullRequest: publishSpy,
    });

    await orch.runTick();
    expect(orch.internalState.running.has("i1")).toBe(true);

    // Wait until session is up and the worktree exists
    const wsPath = join(root, "MT-1");
    await waitFor(async () => {
      const s = await stat(wsPath).catch(() => null);
      return s !== null && (controller.startedSessions.get("i1") ?? 0) > 0;
    });

    // Simulate the agent moving the issue to terminal — exactly the APP-273 scenario
    controls.patchIssue("i1", { state: "Done" });
    await orch.reconcileRunningIssues(snapshot);

    const entry = orch.internalState.running.get("i1");
    if (entry?.worker_promise) await entry.worker_promise.catch(() => {});

    // Wait for the cleanup promise chain to settle
    await waitFor(async () => callOrder.length >= 2, 6000);

    expect(callOrder).toEqual(["publish", "remove"]);
    expect(publishSpy).toHaveBeenCalledTimes(1);
    expect(entry?.publish_result).toBe("https://github.com/Ddell12/symphoney-codex/pull/999");

    await orch.stop();
  });

  it("does NOT remove workspace when publishPullRequest throws (preserves uncommitted work)", async () => {
    const snapshot = buildSnap(root);
    const issue = makeIssue({ id: "i1", identifier: "MT-2", state: "In Progress" });
    const { tracker, controls } = makeFakeTracker([issue]);
    const { client, controller } = makeFakeAgentClient();
    controller.scriptForIssue("i1", [{ kind: "stall", durationMs: 200 }]);

    const publishSpy = vi.fn<PublishPullRequest>(async () => {
      throw Object.assign(new Error("dirty"), { code: "dirty_workspace" });
    });
    const baseWorkspaces = createWorkspaceManager({ getSnapshot: () => snapshot });
    const removeSpy = vi.fn(baseWorkspaces.removeForIssue);
    const workspaces = { ...baseWorkspaces, removeForIssue: removeSpy };

    const orch = new Orchestrator({
      getSnapshot: () => snapshot,
      tracker,
      agent: client,
      workspaces,
      logger: silentLogger,
      publishPullRequest: publishSpy,
    });

    await orch.runTick();
    const wsPath = join(root, "MT-2");
    await waitFor(async () => {
      const s = await stat(wsPath).catch(() => null);
      return s !== null && (controller.startedSessions.get("i1") ?? 0) > 0;
    });

    controls.patchIssue("i1", { state: "Done" });
    await orch.reconcileRunningIssues(snapshot);

    const entry = orch.internalState.running.get("i1");
    if (entry?.worker_promise) await entry.worker_promise.catch(() => {});

    // Settle the cleanup-attempt chain
    await new Promise((r) => setTimeout(r, 250));

    expect(publishSpy).toHaveBeenCalledTimes(1);
    expect(removeSpy).not.toHaveBeenCalled();
    // Workspace must still exist — human has to triage uncommitted state
    const stillThere = await stat(wsPath).catch(() => null);
    expect(stillThere).not.toBeNull();
    expect(entry?.publish_result).toMatch(/^failed:/);

    await orch.stop();
  });

  it("skips publish (and still cleans up) when publish_result is already set from success path", async () => {
    // Dedup case: worker exited normally and called publish; THEN reconcile runs.
    const snapshot = buildSnap(root);
    const issue = makeIssue({ id: "i1", identifier: "MT-3", state: "In Progress" });
    const { tracker, controls } = makeFakeTracker([issue]);
    const { client, controller } = makeFakeAgentClient();
    controller.scriptForIssue("i1", [{ kind: "complete" }]);

    const publishSpy = vi.fn<PublishPullRequest>(async () => ({ url: "https://github.com/x/y/pull/1" }));
    const baseWorkspaces = createWorkspaceManager({ getSnapshot: () => snapshot });
    const removeSpy = vi.fn(baseWorkspaces.removeForIssue);
    const workspaces = { ...baseWorkspaces, removeForIssue: removeSpy };

    const orch = new Orchestrator({
      getSnapshot: () => snapshot,
      tracker,
      agent: client,
      workspaces,
      logger: silentLogger,
      publishPullRequest: publishSpy,
    });

    await orch.runTick();
    const entry = orch.internalState.running.get("i1");
    if (entry?.worker_promise) await entry.worker_promise; // success path runs publish once

    expect(publishSpy).toHaveBeenCalledTimes(1);

    // Now move to terminal and reconcile — should NOT publish again
    controls.patchIssue("i1", { state: "Done" });
    await orch.reconcileRunningIssues(snapshot);
    await new Promise((r) => setTimeout(r, 100));

    expect(publishSpy).toHaveBeenCalledTimes(1); // still 1 — no double-publish
    await orch.stop();
  });
});
```

The helpers are intentionally inline because this repo does not currently have `test/helpers/orchestrator-fixtures.ts`; do not extract them as part of this bug fix.

- [ ] **Step 1.2: Run the test to verify it fails**

```bash
pnpm exec vitest run test/integration/orchestrator-reconcile-publish.test.ts
```

Expected: The first two tests FAIL. The first fails because the call order is `["remove"]` only or it times out waiting for publish. The second fails because `removeForIssue` is called while publish is never attempted. The third may pass spuriously today depending on dedup behavior — that's fine, we keep it as a regression guard.

### Task 2: Implement the orchestrator fix

**Files:**
- Modify: `src/orchestrator/orchestrator.ts:850-885`

- [ ] **Step 2.1: Replace the terminal-state branch in reconcileRunningIssues**

Open `src/orchestrator/orchestrator.ts`. Find the loop body inside `reconcileRunningIssues` (currently lines 850-884). Replace the `if (isStateTerminal(...))` arm with the version below. The `else if (isStateActive)` and final `else` arms stay unchanged.

```typescript
      if (isStateTerminal(next.state, snap)) {
        const log = this.deps.logger.child({
          issue_id: entry.issue_id,
          issue_identifier: entry.identifier,
        });
        log.info({ to: next.state }, "reconcile_terminal_kill");
        entry.abort.abort();

        const cleanupId = entry.issue_id;
        const cleanupIdent = entry.identifier;
        const cleanupIssue = next;
        const cleanupEntry = entry; // capture by ref; we mutate publish_result on it

        if (entry.worker_promise) {
          void entry.worker_promise
            .catch(() => {})
            .then(async () => {
              // Phase 0 fix: publish BEFORE removing the workspace, unless
              // the success path already published (entry.publish_result set).
              // If publish throws (e.g. dirty_workspace), KEEP the workspace
              // so a human can recover uncommitted work — do NOT call removeForIssue.
              let safeToRemove = true;
              if (
                this.deps.publishPullRequest &&
                cleanupEntry.publish_result === null
              ) {
                try {
                  const result = await this.deps.publishPullRequest({
                    workspacePath: this.deps.workspaces.pathFor(cleanupIdent),
                    issue: cleanupIssue,
                    tracker: this.deps.tracker,
                    log,
                    repository: snap.tracker.repository ?? null,
                  });
                  cleanupEntry.publish_result = result.url ?? result.skipped ?? null;
                } catch (e) {
                  const err = e as Error & { code?: string };
                  log.error(
                    { err: err.message, code: err.code ?? null },
                    "reconcile_publish_failed_keeping_workspace",
                  );
                  cleanupEntry.publish_result = `failed: ${err.message}`;
                  safeToRemove = false;
                }
              }
              if (safeToRemove) {
                try {
                  await this.deps.workspaces.removeForIssue(cleanupIdent, cleanupIssue);
                } catch (e) {
                  log.warn(
                    { issue_id: cleanupId, err: (e as Error).message },
                    "reconcile_cleanup_failed",
                  );
                }
              }
            });
        }
      } else if (isStateActive(next.state, snap)) {
```

- [ ] **Step 2.2: Use the existing workspace path helper**

Open `src/workspace/manager.ts` and confirm the `WorkspaceManager` interface exposes `pathFor(identifier: string): string`. This repo already has that helper; use it in `reconcileRunningIssues` to pass the correct workspace path to `publishPullRequest`.

```typescript
workspacePath: this.deps.workspaces.pathFor(cleanupIdent),
```

Do not add a duplicate `pathForIdentifier` method.

- [ ] **Step 2.3: Run the new tests to verify they pass**

```bash
pnpm exec vitest run test/integration/orchestrator-reconcile-publish.test.ts
```

Expected: All three tests PASS.

- [ ] **Step 2.4: Run the full test suite to verify no regressions**

```bash
pnpm typecheck && pnpm test
```

Expected: All green. Pay special attention to `test/integration/orchestrator.test.ts` "kills and cleans up workspace when issue moves to a terminal state mid-run" — it uses a stall script and no publisher, so `entry.publish_result === null && deps.publishPullRequest === undefined` should still cleanly remove. Verify that test still passes.

If a future branch renames `pathFor`, use that equivalent helper instead. The current `main` branch already has `pathFor`, so no workspace manager change should be needed.

### Task 3: Update WORKFLOW.md prompt

**Files:**
- Modify: `WORKFLOW.md:69-83`

- [ ] **Step 3.1: Replace the prompt body with commit-before-transition guidance**

Open `WORKFLOW.md`. Replace the body (everything after the `---` closing the front matter, currently lines 69-83) with:

````liquid
You are working on {{ issue.identifier }}: {{ issue.title }}.

{% if attempt %}
This is retry attempt {{ attempt }}. Inspect the workspace, read prior commit history, and continue where the previous attempt left off.
{% else %}
This is the first attempt. Read the issue carefully, then implement the change in this workspace.
{% endif %}

Issue description:
{{ issue.description }}

Labels: {% for label in issue.labels %}{{ label }}{% unless forloop.last %}, {% endunless %}{% endfor %}

## Completion protocol — DO IN THIS ORDER

1. Implement the change.
2. Run `pnpm typecheck && pnpm test` from the workspace root. Both MUST pass before you finish. If either fails, fix it.
3. Stage and commit ALL changes:
   ```
   git add -A
   git commit -m "<short summary tied to {{ issue.identifier }}>"
   ```
   Do NOT skip this step. The orchestrator will publish a PR from your committed work; uncommitted edits will be discarded.
4. Only AFTER the commit succeeds, call the `linear_graphql` tool to move the Linear issue to `Done` (or your handoff state, e.g., `Human Review`). The orchestrator detects the state change and stops the worker.

If you cannot complete the implementation, do NOT transition the issue. The worker will continue prompting you up to `agent.max_turns` times and then schedule a retry.
````

- [ ] **Step 3.2: Manual verification of prompt rendering**

```bash
pnpm exec tsx -e "
import { parseWorkflowContent } from './src/workflow/parse.js';
import { readFile } from 'node:fs/promises';
const raw = await readFile('./WORKFLOW.md', 'utf8');
const w = parseWorkflowContent(raw);
console.log('--- TEMPLATE ---');
console.log(w.prompt_template);
"
```

Expected: stdout shows the new completion-protocol body. No parse errors. If there's a parse error, the front-matter delimiter is misplaced.

### Task 4: Update memory + commit

- [ ] **Step 4.1: Mark the bug fixed in memory**

Edit `/Users/desha/.claude/projects/-Users-desha-symphoney-codex/memory/bug-reconcile-data-loss.md`. Add a new top section:

```markdown
**FIXED 2026-04-30:** Two-part fix landed.
1. `src/orchestrator/orchestrator.ts:reconcileRunningIssues` — invokes `publishPullRequest` before `removeForIssue`. If publish throws, workspace is preserved for human triage. Dedups against the success-path publisher via `entry.publish_result === null` check.
2. `WORKFLOW.md` prompt — explicit ordered protocol: typecheck/test → commit → transition. Test coverage in `test/integration/orchestrator-reconcile-publish.test.ts`.
```

Keep the rest of the file as historical context.

- [ ] **Step 4.2: Commit Phase 0**

```bash
git add src/orchestrator/orchestrator.ts WORKFLOW.md test/integration/orchestrator-reconcile-publish.test.ts
git commit -m "$(cat <<'EOF'
fix(orchestrator): publish PR before workspace removal on reconcile-terminal

When the agent moves a Linear issue to a terminal state mid-run (the documented
completion path), reconcileRunningIssues was force-removing the worktree before
the publisher had a chance to push commits. APP-273's work was lost this way.

Two-part fix:
1. reconcileRunningIssues now invokes publishPullRequest before removeForIssue,
   guarded by entry.publish_result === null so the success-path publisher isn't
   double-fired. On publish failure (dirty_workspace, etc.) the workspace is
   preserved so uncommitted work can be recovered manually.
2. WORKFLOW.md prompt now spells out the completion protocol: typecheck/test,
   then git add+commit, THEN linear_graphql transition. The agent can no longer
   transition without committing first.

Three new integration tests cover: publish-then-remove ordering, workspace
preservation on publish failure, and dedup against success-path publish.

Phase 0 of the archon-symphony consolidation plan
(docs/superpowers/plans/2026-04-30-archon-symphony-consolidation.md).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 4.3: Manual dogfood validation (do this BEFORE Phase 1)**

This is a real-system test, not automated — that's the whole point. The bug was found in production; the fix needs production verification.

1. Pick a low-stakes Linear issue in the Symphony Smoke project (the dell-omni-group sandbox per memory file `linear-workspace.md`). Move it to `Todo`.
2. Start the daemon: `pnpm dev --port 4000`.
3. Watch the logs. The orchestrator picks up the issue, dispatches, the agent does its thing.
4. While the worker is running, manually move the Linear issue to `Done` from the Linear UI (this simulates the agent transitioning it).
5. Watch the logs for `reconcile_terminal_kill` followed by EITHER a publisher success log OR `reconcile_publish_failed_keeping_workspace`.
6. Verify either: (a) a PR exists at github.com/Ddell12/symphoney-codex with the expected branch name, OR (b) the worktree under `~/symphony_workspaces/<IDENTIFIER>` still exists and has uncommitted changes preserved.

If both conditions are wrong (no PR AND no surviving workspace), the fix has a defect — investigate before proceeding.

**Phase 0 exit criteria:**
- [ ] All three new integration tests green
- [ ] `pnpm typecheck && pnpm test` green
- [ ] Manual dogfood scenario verified
- [ ] Commit `fix(orchestrator): publish PR before workspace removal on reconcile-terminal` exists on `main`
- [ ] Memory file `bug-reconcile-data-loss.md` updated with FIXED marker

---

## Self-Review

**1. Spec coverage:** All 6 phases requested are present. The reconcile-bug prereq is Phase 0 with full bite-size detail. The Linear+GitHub dual-tracker requirement appears in Phase 2 sub-tasks 1-2 and Phase 2 exit criteria. Archon's dual DB reality is reflected: PostgreSQL migrations plus SQLite adapter schema updates. Approval gates not mentioned — explicitly skipped per user direction. Fork name `Ddell12/archon-symphony` is the target throughout.

**2. Placeholder scan:** Phase 0 contains complete code blocks for tests, orchestrator patch, prompt body, memory update, and commit. No "TBD"/"TODO"/"fill in details" — every step has either runnable code or runnable command. Phases 1-5 use a sub-task list format (not checkbox bite-size) — that's intentional per the scope-note section, and each sub-task is concrete enough that a future writing-plans invocation can expand it without inventing requirements.

**3. Type consistency:** `entry.publish_result` accessed as `string | null` (matches `state.ts:43`). `PublishPullRequest` signature matches `src/publisher/pr.ts:58`. `removeForIssue(identifier, issue?)` and `pathFor(identifier)` match `src/workspace/manager.ts`. Phase 3 no longer invents a `runWorkflow({ ... })` shape; it explicitly requires wrapping Archon's real `executeWorkflow(...)` / background workflow path and using `remote_agent_workflow_runs` statuses (`completed`, `failed`, `cancelled`).

**4. Risks not yet captured in any phase:**
- Bun-vs-pnpm package manager mismatch: symphoney-codex uses pnpm, archon uses Bun. Phase 1 inherits Bun. Tests written in vitest in symphoney-codex must be ported to bun:test in Phase 2. Added a note here for awareness — Phase 2 sub-task 6 acknowledges this implicitly ("Port relevant unit tests").
- ESM `.js` extensions in imports: symphoney-codex uses `.js` import suffixes per its `module: NodeNext` config. Archon's Bun setup may or may not require this. Phase 2 sub-task 1 mentions adjusting imports.
- `claude-agent-sdk` and `codex-app-server` integrations in Symphony's `src/agent/` are NOT being ported — Archon's `packages/providers/` already covers both, and Phase 3 deletes the agent layer entirely by routing through Archon's workflow executor/orchestrator path.
- Current Symphoney's `src/service.ts` hot-reload bug is documented as related but outside Phase 0's mandatory fix. It should be fixed before depending on live config/protocol reloads.

---

