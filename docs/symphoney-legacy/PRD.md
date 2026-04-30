# Symphoney — Product Requirements

> Source-of-truth for the product vision. Companion to `SPEC.md` (technical contract), `ROADMAP.md` (sequenced delivery plan), and `PARITY_REPORT.md` (gap with the OpenAI reference). When the three disagree on *what* we're building, this document wins; when they disagree on *how*, `SPEC.md` wins.

---

## What we're building

**Symphoney is a personal AI engineering team that runs 24/7 on a Mac mini.** It picks issues out of a Linear backlog, runs Codex or Claude coding-agent sessions inside per-issue git worktrees, and ships every dispatch back as a reviewable GitHub PR with a Linear backlink — controllable from Slack on any device.

The build is the operator's reference implementation of the [OpenAI Symphony Service Specification](https://github.com/openai/symphony/blob/main/SPEC.md), extended with a kanban control plane, a Slack control surface, and Cloudflare-fronted hosting so the product is usable from a phone in a meeting. The orchestrator core is spec-conformant today; the remaining roadmap turns it into a daily-driver personal automation tool.

**North star: Symphony works on itself.** Every roadmap item from Wave 1 onward ships as a Symphoney-dispatched PR. If the product can't ship its own next feature with a human reviewing the diff and merging, it isn't done.

---

## Who this is for

A single technical builder running their own backlog. One operator, one Mac mini, one Linear workspace, one GitHub repo per workflow. The product is deliberately not multi-tenant. There is no team plan, no shared dashboard, no per-user auth model. If a second person ever needs access, they get it via Cloudflare Access on the same single-user instance.

---

## What the app does

- **Polls Linear on a fixed cadence** for issues in active states (`Todo`, `In Progress`) and dispatches the eligible ones into per-issue workspaces, respecting concurrency caps and blocker chains.
- **Creates a per-issue git worktree** branched as `sym/<IDENTIFIER>` from a dedicated dev checkout, so every dispatch starts in a known-good, isolated workspace.
- **Runs a coding agent inside the workspace** — Codex over stdio JSON-RPC by default, optionally Claude via the Anthropic Agent SDK — driving multi-turn sessions until the agent transitions the issue out of an active state or hits the turn cap.
- **Lets the agent transition Linear state directly** via the `linear_graphql` client-side tool, so a dispatch can self-terminate at `Done`, `Human Review`, or any workflow-defined handoff.
- **Publishes a GitHub PR on success** with a `gh pr create` flow: typecheck must pass, branch must be `sym/<IDENTIFIER>`, working tree must be clean, branch must be ahead of `origin/main`. The PR URL is posted back to Linear as a comment.
- **Hot-reloads its own configuration** when `WORKFLOW.md` changes on disk, so prompt edits, concurrency caps, hook scripts, and tracker settings update without a restart.
- **Surfaces live state** through an HTTP API (`/api/v1/state`, `/api/v1/<id>`, `/api/v1/dispatch`, `/api/v1/refresh`) and a kanban dashboard at `127.0.0.1:4000` with running issues, retry queue, token totals, and a one-click immediate-dispatch action.
- **Recovers from transient failures** with exponential backoff on dispatch failures and a fixed cadence on continuation turns, capped by `max_retry_backoff_ms`.
- **Reconciles tracker state every tick** — if an issue moves to a terminal state during a run, the worker is aborted and its workspace cleaned up.
- **Will be controllable from Slack** (`/symphony status`, `@symphony work on ENG-123`, in-thread cancel) so the operator can claim work or check status from their phone.

---

## Already shipped (don't re-spec)

The following are done in the current checkout and are out of scope for any future milestone:

- **Spec-conformant orchestrator core.** Polling tick, dispatch math (priority asc, null-last, oldest-first, identifier tiebreak), eligibility checks (active state + blockers terminal + slot available), per-issue retry queue with `DelayKind` (`continuation` vs `failure`) backoff, reconciliation on every tick, abort on terminal-state transition, stall detection, startup cleanup.
- **Dual agent backends.** Codex stdio JSON-RPC (`StdioCodexClient`) and Claude Agent SDK (`ClaudeAgentClient`) behind a unified `AgentClient` interface. Backend selected by `snapshot.agent.backend`. Cache-token accounting present on both.
- **`linear_graphql` client-side tool extension.** Wired for both backends. Lets the agent run a single Linear GraphQL operation per call (typically `issueUpdate` to transition state) so dispatches can self-terminate before `max_turns`.
- **Continuation prompt differentiation.** Turn 1 renders the full Liquid prompt; turns 2..N send only `agent.continuation_prompt`. No more 20-turn loops on simple tasks.
- **Hot-reloading config snapshot.** `WORKFLOW.md` is parsed into an immutable `ConfigSnapshot`; `chokidar` rebuilds it on file change. Every consumer reads `getSnapshot()` per call so reloads take effect immediately.
- **HTTP API.** `GET /` (legacy dashboard) plus `/api/v1/{state,issues,repositories,version,refresh,dispatch,<identifier>}`. Static-export of the kanban served at `/*` when `web/out` is built.
- **Kanban control plane (web/).** Next.js 16 + React 19 + Tailwind 4 + shadcn. Polling at 5s with visibility pause. Group-by `lifecycle | status | repository`. One-click immediate dispatch.
- **Workspace lifecycle hooks.** `after_create`, `before_run`, `after_run`, `before_remove` with `WORKSPACE_PATH`, `ISSUE_ID`, `ISSUE_IDENTIFIER`, `ISSUE_TITLE`, `ATTEMPT`, `WORKFLOW_PATH` env propagation. Path-safety constraints on workspace root.
- **Wave 0 bootstrap.** Worktree-based hooks against a dedicated `~/symphony-dev/symphoney-codex` checkout, prod/dev split documented, first-class PR publisher with loud failures, first-dispatch ceremony config (`max_concurrent_agents: 1`, `max_turns: 12`).
- **Structured agent-event logging.** Spec-listed events (`session_started`, `turn_completed`, etc.) emitted as `agent_event` pino lines for grep-friendly operator debugging.

---

## Out of scope (won't ship)

- **Multi-user auth, team plans, role-based access control.** Single-operator product. Auth boundary, when it arrives, is Cloudflare Access on top of single-user.
- **SSH worker extension** (Symphony spec Appendix A). Localhost-only execution.
- **Generic webhook system.** Symphoney isn't a workflow engine. Slack and Cloudflare Tunnel are bespoke integrations.
- **Built-in metrics stack** (Prometheus, Grafana, OpenTelemetry collector). Operate from launchd logs + outbound heartbeat to a hosted uptime monitor.
- **Drag-to-reorder columns or cards** in the kanban. Linear is the source of truth for state transitions.
- **Editing or creating issues from the kanban.** Linear is the source of truth for issue content.
- **Pluggable trackers beyond Linear.** The `Tracker` interface allows it; only Linear ships.
- **First-class tracker write APIs in the orchestrator.** Per spec, ticket writes belong to the agent's tool surface (`linear_graphql`), not the orchestrator.
- **Mobile native app.** The phone-first surface is Slack and the responsive kanban behind Cloudflare Access. No iOS/Android app.
- **Per-user model selection or fine-tuning.** Backend and model are workflow-level settings, not per-issue.
- **Voice input.** Slash commands and threaded replies are sufficient.

---

## Tech stack

- **Runtime:** Node ≥22, TypeScript ESM-only (`module: NodeNext`, `verbatimModuleSyntax` off, `isolatedModules` on, `noUncheckedIndexedAccess: true`), pnpm 10.
- **Daemon:** Hono HTTP server via `@hono/node-server`, `chokidar` watcher, `pino` structured logging, `graphql-request` for Linear, `better-sqlite3` (planned, Wave 1.1) for durable run state.
- **Agent backends:** `codex app-server` CLI subprocess over stdio JSON-RPC (default) or `@anthropic-ai/claude-agent-sdk` ^0.2.122 (selectable). Both expose `linear_graphql` as a client-side tool.
- **Web:** Next.js 16 + React 19 + Tailwind 4 + shadcn + Base UI + Phosphor. Static-export at `web/out/` mounted by the daemon in prod; dev rewrites `/api/*` → `http://127.0.0.1:4000` for same-origin requests.
- **Hosting:** Mac mini under `launchd` (user LaunchAgent), Cloudflare Tunnel (`cloudflared`) → `symphony.<domain>` → `127.0.0.1:4000`, Cloudflare Access protecting dashboard routes, `/slack/*` bypassed and verified via Slack signed requests.
- **Tooling:** `gh` CLI for PR creation, `git worktree` for workspace isolation, Vitest for unit + integration tests, `tsx` for dev-mode no-build runs.

---

## External integrations

| Integration | Purpose | Credentials needed | Status |
|---|---|---|---|
| **Linear** | Tracker source-of-truth; the agent also calls `linear_graphql` to transition state and post comments | `LINEAR_API_KEY` in `.env` | Live |
| **GitHub (via gh CLI)** | Branch push + PR creation + PR-URL backlink | `gh auth status` (OAuth, browser flow) | Live |
| **OpenAI Codex CLI** | Default agent backend over stdio JSON-RPC | None at daemon level (Codex manages its own auth) | Live |
| **Anthropic Claude Agent SDK** | Optional agent backend | `claude login` (OAuth/subscription) **or** `ANTHROPIC_API_KEY` | Live |
| **Slack** | Phone-first control plane (`/symphony status`, `@symphony work on …`) | Slack app: signing secret + bot token + slash command + Events API URL | Wave 2.1 |
| **Cloudflare Tunnel + Access** | Public HTTPS for Slack webhooks, auth for dashboard | Cloudflare account, domain on Cloudflare DNS, `cloudflared` token | Wave 2.3 |
| **Outbound uptime heartbeat** | Dead-man's switch | Healthchecks.io (or equivalent) ping URL | Wave 2.4 |

---

## Conceptual data model — what the daemon needs to remember

Today, most of this lives in process memory; Wave 1.1 moves the durable parts to a SQLite store next to the workspace root.

### Issue *(read from Linear, normalized)*
- `id` — Linear's UUID (used for issue-level mutations)
- `identifier` — human-readable key like `APP-123`; drives branch and workspace names
- `title`, `description` — what the agent is told to work on
- `priority` — drives dispatch sort order (asc, null-last)
- `state` — current workflow state name (matched against active/terminal sets)
- `branch_name` — agent's preferred branch hint, if any
- `url` — link back to the Linear issue
- `labels` — arbitrary string tags
- `blocked_by` — list of upstream issues; dispatch waits until each is in a terminal state
- `created_at`, `updated_at` — timestamps for sort tiebreaks and reconciliation

### Run *(per-dispatch attempt)*
- Which issue, when started, current attempt number
- Worker promise + abort controller (in-memory only)
- Codex/Claude session id and thread id (for resume on continuation turns)
- Codex app-server PID, last event name, last event payload, last event timestamp
- Token totals: input, output, cache-creation input, cache-read input, total — monotonic; out-of-order decreases ignored
- Last-reported-to-tracker totals (so deltas can be aggregated even if events arrive out of order)
- Turn count
- Cancel-requested flag (set by `requestImmediateDispatch` cancel path or kanban cancel button)
- Publish result — PR URL, `no_changes` skip marker, or `failed: <reason>` string

### Turn *(one prompt → response cycle inside a run)*
- Run id, turn number, started/ended timestamps, outcome (`completed | aborted | failed`)
- Prompt sent (full template on turn 1; continuation prompt only on 2..N)
- Token usage delta for this turn

### Agent event *(the spec's session/turn lifecycle protocol)*
- Run id, turn id, event name (`session_started`, `turn_completed`, `turn_failed`, `agent_message`, `tool_call_started`, `tool_call_completed`, etc.)
- Timestamp, structured payload (varies by event)
- Logged to pino as a structured `agent_event` line; persisted to SQLite from Wave 1.1

### Workspace
- Issue identifier → absolute path under `~/symphony_workspaces/<IDENTIFIER>`
- Implementation: a git worktree on branch `sym/<IDENTIFIER>` from `~/symphony-dev/symphoney-codex`
- Lifecycle: created on dispatch, persisted across runs, removed on terminal-state reconciliation

### Retry queue entry
- Issue id, attempt number, delay kind (`continuation` | `failure`), due-at timestamp, last error code/message
- Continuation: fixed 1000 ms; failure: 10000 × 2^(n-1) capped by `max_retry_backoff_ms`

### Config snapshot *(immutable, rebuilt on `WORKFLOW.md` change)*
- Tracker config (kind, project, repository, active/terminal states), polling interval, workspace root, hooks, agent caps and backend selection, codex/claude per-backend settings

### Rate-limit signals *(read from Linear / agent backends)*
- Surfaced on `/api/v1/state.rate_limits`; used to decide whether to backpressure dispatch

---

## Milestones

The roadmap waves are the milestones. Each wave is a working session for an agent (or for the operator, in Wave 0's case). Later waves assume earlier ones have shipped.

---

### Milestone 0 — Bootstrap self-work safely **(SHIPPED)**

What this milestone delivered: Symphoney can dispatch issues against itself without trashing the prod checkout, and every successful dispatch produces a reviewable PR.

**What got built**
- A dedicated "Symphony" Linear project (slugId `60aa12712181`) on the `dell-omni-group` org, separate from the Smoke sandbox.
- Hook env-var plumbing: `WORKSPACE_PATH`, `ISSUE_ID`, `ISSUE_IDENTIFIER`, `ISSUE_TITLE`, `ATTEMPT`, `WORKFLOW_PATH` flow through `after_create`, `before_run`, `after_run`, `before_remove`.
- Worktree-based workspaces: `after_create` runs `git worktree add` against `~/symphony-dev/symphoney-codex`, with a branch-exists guard so attempt N≥2 reuses the branch.
- `before_run` runs `pnpm install --frozen-lockfile && pnpm typecheck` so the agent starts in a known-good workspace.
- First-class PR publisher (`src/publisher/pr.ts`): rev-parse → status clean → log ahead → typecheck → gh auth status → push → `gh pr create` → Linear backlink comment. Loud failures, no auto-retry.
- Prod/dev checkout split documented in `CLAUDE.md`; daemon runs from `~/symphony-prod/symphoney-codex`.
- First-dispatch ceremony config: `max_concurrent_agents: 1`, `max_turns: 12` until three clean dogfood PRs land.

**Done when** ✅ A handwritten Linear issue in the Symphony project gets picked up, an agent commits inside `~/symphony_workspaces/<ID>/`, and a PR opens at `Ddell12/symphoney-codex` with the PR URL posted back to the Linear issue.

---

### Milestone 1 — Durable state and history **(NEXT — Wave 1.1 is the first dogfood dispatch)**

What this milestone delivers: cheap, high-leverage substrate for restart recovery, dashboard history, and the eval suite.

**What gets built**
- Persist run state to SQLite (`runs.db` next to workspace root) with `runs`, `turns`, `agent_events`, and a `schema_meta` migration table. WAL journal mode for read concurrency.
- Startup recovery: load non-terminal runs, reconcile their Linear states, mark stale rows as `interrupted`, never duplicate-dispatch issues already inactive.
- Event-shape coverage cleanup: every event in the union is either emitted by at least one adapter with tests, or removed from the union.
- Kanban surface: an `interrupted` lifecycle column with a "resume" button calling `requestImmediateDispatch`.

**Explicitly NOT in this milestone**
- Migration tooling beyond `PRAGMA user_version`. No Knex / Prisma / Drizzle.
- Multi-database support. SQLite only.
- Time-series storage of token totals. Last-known totals, plus deltas in `agent_events`, are sufficient.

**Done when** Killing the daemon mid-run and restarting shows the run as `interrupted` in the kanban with full turn history; retry counts and token totals survive; restart never dispatches an issue that's already terminal in Linear.

---

### Milestone 2 — Slack as the control plane

What this milestone delivers: usable from a phone in a meeting. The product earns the description "personal AI engineering team" only after this milestone ships.

**What gets built**
- A single Slack app with three primitives:
  - `/symphony status` → Block Kit message with running issues, lifecycle pills, token meter, and links to dashboard + PRs.
  - `@symphony work on ENG-123` → claim + dispatch immediately, bypassing the polling cadence (still respects slot caps + blockers).
  - Threaded run output → bot posts the agent's plan as a thread reply on dispatch and the PR URL on completion. `@symphony cancel` in-thread aborts the run.
- 24/7 hosting on the Mac mini under `launchd` (`WorkingDirectory`, `ProgramArguments`, env-file load, `KeepAlive`, log paths).
- Cloudflare Tunnel from `cloudflared` outbound on the mini → `symphony.<domain>` → `127.0.0.1:4000`. `cloudflared` itself runs under `launchd`.
- Cloudflare Access protecting the dashboard routes; `/slack/*` bypassed and verified via Slack signed requests.
- `GET /healthz` with non-sensitive status (uptime, last-poll-age, last tracker error, running count, SQLite health) plus an outbound heartbeat to Healthchecks.io.

**Explicitly NOT in this milestone**
- Slack modals, multi-channel routing, per-user prefs, voice input, message scheduling, slash subcommands beyond the three primitives.
- A native iOS/Android app.
- Tailscale (separate decision, only if SSH-from-anywhere ever matters).
- Detailed health data on the unauthenticated `/healthz` path. Use the heartbeat for liveness; gate detail behind Access.

**Done when** From a phone, the operator can run `/symphony status` in a meeting, type `@symphony work on APP-300`, see the plan thread, and either let it run or `@symphony cancel`. The mini reboots cleanly under launchd. The kanban is reachable on the phone behind Cloudflare Access.

---

### Milestone 3 — Output quality

What this milestone delivers: every dispatch is trustworthy enough to merge without a careful diff read. Pick one sub-item at a time and let it bake before adding the next.

**What gets built (in order, one at a time)**
- **Validation gate before completion (3.1):** before the agent calls `linear_graphql` to transition the issue, `pnpm typecheck && pnpm test` must pass. Either prompt-driven (the agent runs them) or orchestrator-driven (run them after a turn that looks complete; on failure, send stderr as the next continuation prompt).
- **Plan-then-execute split (3.2):** turn 1 produces a markdown checklist plan, posted to Linear before execution. Subsequent turns execute one item at a time. Conservative checklist parser that doesn't block runs on extraction failure.
- **Golden eval suite (3.3):** five closed Linear issues with known-good PRs replayed offline through `pnpm eval`. Compare patch size, touched files, validation result, expected-files-changed. No LLM grading. Weekly cadence via launchd.
- **Linear UX polish (3.4):** plan-as-comment before execution, per-turn progress comments (test markdown support first), PR body auto-injects `Fixes ENG-123` for Linear's GitHub auto-link, register Symphoney as a Linear Agent user with delegation-based dispatch.

**Explicitly NOT in this milestone**
- LLM-as-judge evaluation. Deterministic artifacts only.
- Custom validation runners beyond `pnpm typecheck && pnpm test`. The workflow defines the validation command.
- Auto-merging PRs. Human still presses the merge button.

**Done when** Three consecutive Symphoney-dispatched PRs land on `main` without a human pushing fixup commits, and the eval suite catches the next regression that would have shipped.

---

## Vision-level success criteria

Symphoney is "done" for the operator's purposes when **all** of the following are true:

1. The operator can describe a feature in a Linear issue from their phone, walk away, and find a mergeable PR waiting when they next open GitHub.
2. The mini has been up for ≥30 days without a manual restart, and the heartbeat hasn't paged.
3. The eval suite has caught at least one regression that the operator didn't catch by reading the diff.
4. The last three roadmap items shipped were dispatched by Symphoney itself, with the operator only reviewing and merging.
5. Operating cost is dominated by agent token spend, not infrastructure. ($0 for hosting; $X for Codex/Claude usage.)

When all five are true, Symphoney has cleared the bar of "personal AI engineering team that runs 24/7." Until then, it's a tool that the operator is still feeding by hand.
