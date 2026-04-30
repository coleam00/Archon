# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

A TypeScript implementation of the [Symphony Service Specification](https://github.com/openai/symphony/blob/main/SPEC.md) — a long-running daemon that polls a Linear-compatible tracker, creates per-issue workspaces, and runs coding-agent sessions against them. Targets **REQUIRED conformance + the OPTIONAL HTTP API**; the SSH worker extension is intentionally out of scope. `SPEC.md` (in repo root) is the source of truth — line references in code comments (e.g. `SPEC.md:1808-1862`) point at the relevant clause.

`PARITY_REPORT.md` documents the gap between this build and the official OpenAI Symphony reference; read it before adding features.

## Commands

```sh
pnpm install
pnpm dev                          # tsx, no build; uses ./WORKFLOW.md
pnpm dev path/to/WORKFLOW.md
pnpm dev --port 4000              # also start dashboard at http://127.0.0.1:4000/
pnpm build                        # emit dist/
pnpm start                        # run built artifact
pnpm typecheck                    # tsc --noEmit
pnpm test                         # vitest run (unit + integration)
pnpm test:watch
pnpm exec vitest run test/unit/orchestrator-dispatch.test.ts   # single file
pnpm exec vitest run -t "dispatches"                            # by test name
pnpm exec tsx scripts/smoke-claude.ts                           # real-SDK Claude smoke
pnpm exec tsx scripts/smoke-linear-graphql.ts                   # Linear API smoke

# Web UI (Next 16 kanban — pnpm workspace at web/)
pnpm web:dev                                                    # next dev on :3000
pnpm web:build                                                  # next build → web/out/
pnpm web:typecheck
pnpm dev:all                                                    # parallel: daemon + web dev
pnpm build:all                                                  # daemon dist/ + web out/
```

Both `dev` and `start` auto-load `.env` via Node's `--env-file-if-exists` flag. `LINEAR_API_KEY` lives there (gitignored). Requires Node ≥22; the CLI binary is `bin/symphony` (loads `dist/src/index.js`, so build first when invoking via `npx symphony`).

## Web UI

Forked from `cursor/cookbook/sdk/agent-kanban` (Next.js 16 + React 19 + Tailwind 4 + shadcn + Base UI + Phosphor). Lives in `web/` as a separate pnpm workspace package named `@symphony/web`. Talks to the daemon over the same HTTP API documented in `src/server/http.ts`.

- **Dev (two processes):** first time, `cp web/.env.local.example web/.env.local`. Start the daemon with `pnpm dev --port 4000`, then `pnpm web:dev` (override the port with `PORT=3001 pnpm web:dev`). The Next dev server proxies `/api/*` → `http://127.0.0.1:4000/api/*` (see `web/next.config.ts`), so the kanban hits the daemon **same-origin** through the dev server — no CORS, and it doesn't matter whether you load via `localhost:3000` or `127.0.0.1:3000`. Override the proxy target with `SYMPHONEY_DAEMON_URL` if the daemon runs elsewhere.
- **Prod (single process):** `pnpm build:all` produces `web/out/` (Next static export). The daemon's `src/service.ts:resolveWebRoot` looks for `web/out` next to the running source/dist, and when found mounts it at `/*` in `src/server/http.ts` via `serveStatic`. Falls back to the legacy `src/server/dashboard.ts` HTML when `web/out` is missing.
- **Endpoints the kanban consumes:** `GET /api/v1/state`, `GET /api/v1/issues?states=...`, `GET /api/v1/repositories`, `POST /api/v1/refresh`, `POST /api/v1/dispatch`. The `/dispatch` route is backed by `Orchestrator.requestImmediateDispatch` which still respects slot caps, blockers, claimed/running de-dupe, and the active-state requirement.
- **Polling, not SSE.** `web/src/lib/symphony/use-kanban.ts` polls every 5s with visibility pause. The orchestrator has an internal `onObserve` observer hook (`src/orchestrator/orchestrator.ts:176`) that's the natural future SSE wiring point — defer until Wave 2.3.
- **Group-by toggle:** `web/src/lib/symphony/group.ts` exposes `groupOptions` for `lifecycle` (Symphoney runtime), `status` (Linear state), `repository`. Repository groups collapse to one column until per-repo workflows ship in Wave 0; sourced from optional `tracker.repository` config in `WORKFLOW.md`.
- **Security note:** the dispatch endpoint is unauthenticated. Until Wave 2.3 (Cloudflare Tunnel + Cloudflare Access) lands, **bind the daemon to `127.0.0.1` only** — never expose it on a LAN, public IP, or Tunnel. Optional stop-gap: gate `/api/v1/dispatch` behind a `SYMPHONY_DISPATCH_TOKEN` shared-secret header.
- **Workspace plumbing gotcha:** Next 16 + Turbopack misdetects the project root in pnpm workspaces. `web/next.config.ts` pins `turbopack.root` and `outputFileTracingRoot` to the workspace root (parent of `web/`) — see the comment in that file before changing it.

## Architecture

The service is built around a single **Orchestrator** that owns all mutable state and is driven by config snapshots from a hot-reloading workflow file.

### Boot sequence (`src/index.ts` → `src/service.ts`)

1. CLI parses `[workflowPath] [--port] [--log-level]`.
2. `startService` resolves the workflow, starts a `chokidar` watcher, validates the initial snapshot, builds the tracker / workspace manager / agent client, constructs the `Orchestrator`, runs `startupCleanup()`, calls `start()`, and conditionally starts the HTTP server.
3. SIGINT/SIGTERM trigger an awaited `service.stop()` that aborts running workers, closes the watcher, and shuts down the HTTP server.

### Prod vs dev checkouts (Wave 0.5)

Two clones of `Ddell12/symphoney-codex`, each with a distinct role:

- **`~/symphony-dev/symphoney-codex`** — owns agent worktrees. `WORKFLOW.md`'s `after_create` runs `git worktree add` against this checkout, so per-issue worktrees branched as `sym/<IDENTIFIER>` live under `~/symphony_workspaces/<IDENTIFIER>` and share the dev repo's object database. Override the path with the `SYMPHONY_DEV_REPO` env var (used in tests).
- **`~/symphony-prod/symphoney-codex`** — runs the daemon (`pnpm start` or the launchd plist from Wave 2.2). Update only via explicit `git pull && pnpm build && launchctl kickstart`. Never run the daemon from `~/symphony-dev/`: agent worktrees mutate that checkout's index/working trees.

`safety.ts` only constrains workspace paths; it isn't an OS sandbox. If you need a hard guarantee, run agent workers under a separate OS user.

### Config snapshot model — *the load-bearing pattern*

`WORKFLOW.md` is Markdown with optional YAML front matter (config) + a Liquid prompt template body. `src/workflow/parse.ts` splits it; `src/config/snapshot.ts:buildSnapshot` produces a fully-resolved, immutable `ConfigSnapshot`. The `chokidar` watcher (`src/workflow/watch.ts`) rebuilds the snapshot on file change and exposes `current()` to consumers.

**Critical rule:** every consumer (orchestrator, tracker, workspace manager, agent) reads `getSnapshot()` *per call*, never caches the snapshot reference. This keeps reload semantics correct. `service.ts` builds a `trackerProxy` that re-resolves the tracker on each method call for exactly this reason — copy that pattern when wiring new dependencies.

`snapshot.agent.turn_timeout_ms` and `stall_timeout_ms` are derived per-backend (codex vs claude) at build time, so orchestrator code reads `snap.agent.*` and stays backend-agnostic.

### Orchestrator (`src/orchestrator/`)

Single class, single tick loop:

- `runTick()` — `reconcileRunningIssues` → validate dispatch config → `tracker.fetchCandidateIssues` → `sortForDispatch` → `eligibilityForDispatch` → `dispatchIssue` for as many as fit in `availableGlobalSlots` / per-state slots → `notifyObservers` → reschedule.
- `dispatchIssue` claims the issue, builds a `RunningEntry`, and spawns `runWorker` as a detached promise; the promise's resolution/rejection routes into `onWorkerExit` which schedules retries via `state.retry_attempts`.
- `runWorker` creates the workspace, runs `before_run`, calls `agent.startSession`, then loops turns. Turn 1 renders the Liquid prompt; **turns 2..N send only `snap.agent.continuation_prompt`** (per `SPEC.md:633-634` — see `PARITY_REPORT.md` §2). After every turn it refreshes issue state and breaks if no longer active or `max_turns` hit.
- `reconcileRunningIssues` does stall detection (`stall_timeout_ms` from last codex event) AND tracker-state reconciliation (terminal → abort + remove workspace; non-active → abort).
- All timers are injectable (`scheduleTimeout` / `cancelTimeout` / `now` deps) so tests can drive the clock — see `test/integration/orchestrator.test.ts`.

`src/orchestrator/state.ts` defines `OrchestratorState` (running/claimed/completed sets, retry_attempts map, codex_totals, codex_rate_limits). `dispatch.ts` holds the slot-accounting and eligibility predicates. `retry.ts` computes backoff by `DelayKind` ("continuation" | "failure").

### Agent backends (`src/agent/`)

Two implementations behind a common `AgentClient` interface (`client.ts`):

- **`StdioCodexClient`** (`stdio-client.ts`) — drives the `codex app-server` CLI subprocess over stdio JSON-RPC. Default backend.
- **`ClaudeAgentClient`** (`claude-client.ts`) — uses `@anthropic-ai/claude-agent-sdk` (^0.2.122). Two auth paths: subscription/OAuth (`force_subscription_auth: true`, requires `claude login`) or API key (`ANTHROPIC_API_KEY`).

`factory.ts:createAgentClient` picks the backend from `snapshot.agent.backend` and pre-warms the Claude SDK via `startup()` (≈20× cold-start latency reduction). The orchestrator never branches on backend kind — it only consumes `AgentClient` / `AgentSession` / `AgentEvent`.

`AgentEvent` (`events.ts`) is the unified shape: spec-listed event names (`session_started`, `turn_completed`, etc.) flow through `applyAgentEvent` which updates token deltas (monotonic; ignores out-of-order decreases) and emits structured `agent_event` pino lines for the events in `LOGGED_AGENT_EVENTS`.

`linear-graphql-tool.ts` is the optional client-side tool extension (`SPEC.md:1056-1087`) — gives the agent a way to transition the issue out of an active state so the worker loop terminates before `max_turns`. Without it, the loop runs to `max_turns` (see `PARITY_REPORT.md` §1).

### Tracker (`src/tracker/`)

`LinearTracker` issues GraphQL via `graphql-request` against the Linear API. Three required methods: `fetchCandidateIssues`, `fetchIssueStatesByIds`, `fetchIssuesByStates`. `normalize.ts` converts raw Linear shapes to the spec `Issue` shape. The Linear `Project.team` → `teams` connection quirk is handled there.

### HTTP API (`src/server/http.ts`)

Hono app served via `@hono/node-server`. Routes:

- `GET /` → minimal HTML dashboard (`dashboard.ts`).
- `GET /api/v1/state` → orchestrator snapshot.
- `GET /api/v1/<issue_identifier>` → per-issue running/retry detail, `404` if unknown.
- `POST /api/v1/refresh` → calls `orchestrator.requestRefresh()` (coalesces).

### Workspace manager (`src/workspace/`)

`createForIssue(identifier)` creates `<workspace.root>/<identifier>/`. `safety.ts` enforces that the resolved path stays under the configured root (defends against `../`). Hooks (`after_create`, `before_run`, `after_run`, `before_remove`) are executed via `runHook` with a configurable `timeout_ms`.

## Tests

Vitest, `pool: "forks"`, 15s timeout. `test/unit/` covers parsers, normalizers, dispatch math, hook safety. `test/integration/` exercises the orchestrator with `test/helpers/fake-tracker.ts` + a fake agent client and asserts retry behavior, reload behavior, the HTTP API, and the Claude backend wiring with a mocked SDK.

## Conventions

- ESM only (`"type": "module"`, `module: "NodeNext"`). All imports use the `.js` extension even for `.ts` files. `verbatimModuleSyntax` is off but `isolatedModules` is on.
- `noUncheckedIndexedAccess: true` — array/record indexing returns `T | undefined`. Many existing files lean on this; preserve the pattern.
- Logging is `pino` with structured fields; child loggers carry `issue_id` / `issue_identifier` context. Spec-listed agent events get explicit `agent_event` log lines (see `LOGGED_AGENT_EVENTS` in `orchestrator.ts`).
- Reference `SPEC.md` line numbers in comments when implementing spec-driven behavior; don't restate the spec, point at it.
