# archon-symphony — Product Requirements

> Source-of-truth for the product vision. Companion to the legacy [`SPEC.md`](./SPEC.md) (the OpenAI Symphony Service Specification — orchestration contract), the in-repo `CLAUDE.md` (engineering guide), and the codebase under `/packages/*`. When this document and `SPEC.md` disagree on **what** we're building, this document wins; when they disagree on **how the orchestrator behaves**, `SPEC.md` wins.
>
> This PRD supersedes the original Symphoney PRD. The Symphoney daemon was ported into the [archon](https://github.com/archon-ai) coding-platform monorepo as the `@archon/symphony` package; the standalone `symphoney-codex` build is archived (`v1-final-pre-archon-merge`). The vision is preserved and expanded.

---

## What we're building

**archon-symphony is a personal AI engineering team that runs 24/7 on a Mac mini and ships reviewable PRs while you sleep.**

It is three products fused into one binary:

1. **Symphony** — a Linear-driven dispatcher that picks issues out of any registered codebase's backlog, runs Claude/Codex/Pi coding-agent sessions inside per-issue git worktrees, and ships every dispatch back as a PR with a Linear backlink.
2. **The Harness Builder** — a visual DAG editor in the web UI for authoring the workflows Symphony dispatches. Workflows are versioned YAML in `.archon/workflows/`, runnable from CLI, chat, GitHub `@archon`, or the dispatcher.
3. **Mission Control** — a live web command center for visibility and control. Per-run event timelines, full run-history search and replay, and an eval scoreboard that tracks regression. Phone-friendly behind Cloudflare Access.

The orchestration contract is OpenAI's [Symphony Service Specification](https://github.com/openai/symphony) — released open-source April 2026 with the explicit guidance that the spec "is a reference implementation" intended to be ported and tailored. archon-symphony is that tailoring for the operator who lives in Linear, Slack, GitHub, and a Mac mini, and who already chose [archon](https://github.com/coleam00/Archon) as their multi-codebase coding harness.

**North star: archon-symphony works on itself, *and* on at least one other repo you own.** v1 is done when the last three roadmap items shipped on `archon-symphony` were dispatched by Symphony, *and* at least one merged PR on a different registered codebase came from a Symphony dispatch. If the product can't ship its own next feature with a human reviewing the diff and merging — and prove it generalizes off-self — it isn't done.

---

## Who this is for

A single technical builder with a Linear backlog, a GitHub account, and ≥1 codebase they want to keep moving while AFK. One operator, one Mac mini, one Linear workspace. The product is deliberately not multi-tenant. There is no team plan, no shared dashboard, no per-user auth model. The auth boundary is Cloudflare Access on top of single-user. If a teammate ever needs in, they get added in Cloudflare Access, not in the app.

---

## What the app does

### Always on

- **Polls Linear** on a fixed cadence (default 30s) for issues in workflow-defined active states across **every registered codebase**, with Linear-project↔codebase resolution by name.
- **Maps issues to workflows** via the per-codebase `.archon/symphony.yaml`. Workflows are the same YAML files used by `archon workflow run`, the chat router, and the GitHub `@archon` adapter — Symphony is just one more invoker.
- **Creates a per-issue git worktree** branched as `sym/<IDENTIFIER>` from the codebase's mainline checkout, isolated under `~/.archon/workspaces/<owner>/<repo>/worktrees/<IDENTIFIER>` (archon's existing `@archon/isolation` provider).
- **Runs the workflow** end-to-end in the worktree: every node — `command`, `prompt`, `bash`, `script`, `loop`, `approval`, `agents` — flows through archon's existing executor with full provider parity (Claude / Codex / Pi).
- **Lets the agent transition Linear state** via the workflow's `linear_graphql` (or equivalent) tool, so a dispatch self-terminates at `Done`, `Human Review`, or any handoff state defined in the workflow.
- **Publishes a GitHub PR** on success with the existing `gh pr create` pipeline (typecheck, branch ahead of base, working tree clean), comments the PR URL back to the Linear issue, and respects the repo's `.github/PULL_REQUEST_TEMPLATE.md`.
- **Reconciles every tick** — if an issue moves to a terminal state mid-run, the run is cancelled, the worktree is preserved or reaped per workflow policy, and the Linear comment notes the cancellation. If the upstream workflow run terminates first, the Symphony dispatch entry is cleaned up. *(Shipped 2026-05.)*
- **Posts back to Linear on completion or failure** with a one-line backlink. *(Shipped 2026-05.)*
- **Recovers from transient failures** with exponential backoff per `DelayKind` (continuation: 1 s; failure: 10 s × 2^(n-1) capped by `max_retry_backoff_ms`).
- **Hot-reloads `~/.archon/symphony.yaml`** on disk change so polling cadence, workflow mapping, concurrency caps, and tracker config update without a restart.

### Controllable from anywhere

- **Web command center** at `archon.<your-domain>` (Cloudflare Access-protected) and on the LAN at `127.0.0.1:3090`. Two surfaces:
  - **Mission Control** (`/mission`): live event stream, run timeline, run history search & replay, eval scoreboard.
  - **Harness Builder** (`/workflows`): visual DAG editor, node palette, schema validation, save-to-`.archon/workflows/`.
- **Slack control plane** (extending the existing `@archon/adapters` Slack adapter):
  - `/symphony status` → Block Kit summary: running, retrying, completed; per-codebase counts; links to dashboard + open PRs.
  - `@symphony work on APP-123` → claim + dispatch immediately, bypassing polling cadence (still respects slot caps + blockers).
  - `/symphony cancel APP-123` → in-thread cancel of a running dispatch.
  - Threaded run output → bot posts the dispatch's plan as a thread reply on start, status updates per terminal state, PR URL on completion.
- **Chat** via the archon web UI: every Symphony command works as `/symphony …` in any conversation. *(Shipped 2026-05.)*
- **GitHub `@archon` mentions** continue to work for ad-hoc dispatch outside the Linear queue (existing archon behavior, unchanged).
- **CLI** for power use: `archon cli workflow run …`, `archon cli isolation list`, `archon cli complete <branch>` (existing).

### Visible and replayable

- **Per-run event timeline.** Every workflow event (`workflow.start`, `node.start/end`, `agent.message`, `tool_call`, `agent_event` lifecycle, `workflow.completed/failed`) flows through archon's existing `WorkflowEmitter` and is rendered live in Mission Control over Server-Sent Events.
- **Full run history** persisted in archon's existing SQLite/Postgres `workflow_runs` + `workflow_events` tables. Searchable by codebase, identifier, status, error class, time range. Click a run to see the timeline. *Click "replay"* to re-run the same workflow against a recorded input snapshot — deterministic where the workflow is deterministic, useful for pre-merge regression checks.
- **Eval scoreboard.** A workflow named `archon-eval` replays a frozen set of closed Linear issues nightly. The scoreboard tracks per-workflow merge-rate, mean time to PR, validation pass rate, and flags regressions when a metric drifts >X% week-over-week. Deterministic artifacts only — no LLM-as-judge.

---

## Already shipped (don't re-spec)

The following exist in the current `dev` branch of archon-symphony — out of scope for any future milestone, listed so future plans don't re-design them:

- **archon platform.** Multi-codebase registration, per-conversation isolation worktrees, Claude/Codex/Pi providers, full workflow YAML engine (DAG / loop / approval / `bash` / `script` / `prompt` / `command` / `agents` nodes), workflow event log, OpenAPI-typed REST + SSE, Slack/Telegram/GitHub/Discord platform adapters, sqlite-by-default DB, CLI, web UI scaffolding (Vite + React 19 + Tailwind 4 + shadcn).
- **`@archon/symphony` package — orchestrator core.** Spec-conformant polling tick, dispatch math (priority asc, null-last, oldest-first, identifier tiebreak), eligibility (active state + blockers terminal + slot available), per-issue retry queue with `DelayKind` backoff, reconciliation on every tick (workflow-run terminal status detection + tracker issue-state recheck), abort on terminal-state transition, startup cleanup. *(Reconcile loop completed 2026-05.)*
- **Workflow bridge.** Symphony's dispatcher pre-stages a `workflow_run` row, hands the row id to archon's executor, and observes events through the same `IWorkflowStore` interface that powers chat and CLI. One execution code path; multiple invokers.
- **Linear tracker.** GraphQL polling, normalize, `commentOnIssue` mutation. GitHub tracker stub present; throws `github_unsupported_operation` until M4.
- **PR backlink comments.** On `workflow_completed` and `workflow_failed`, fire-and-forget Linear comment with run identifier and result. *(Shipped 2026-05.)*
- **`/api/health.symphony` block.** `getSnapshotView()` exposed on the health endpoint; counts + running + retrying arrays. Powers external uptime checks. *(Shipped 2026-05.)*
- **`/symphony` chat commands.** `status`, `work on <id>`, `cancel <id>`, `help` routed through archon's deterministic command handler from any chat platform. Auto-prefix bare ids with `linear:`. *(Shipped 2026-05.)*
- **`@archon/web` workflow builder scaffolding.** `WorkflowBuilderPage` exists with DAG visualization and YAML round-trip; rough but real. M2 polishes it into a daily-driver editor.
- **Hot-reload config.** `~/.archon/symphony.yaml` watched; orchestrator picks up edits without restart. Workflow definitions hot-reload from `.archon/workflows/` per codebase.
- **Worktree-isolated execution.** Every dispatch runs in a fresh worktree under `~/.archon/workspaces/<owner>/<repo>/worktrees/<IDENTIFIER>`. Cleanup hooks plug into archon's isolation lifecycle.
- **Per-port autodetection.** Worktrees auto-allocate non-conflicting dev ports, so the daemon and an agent's `bun dev` can coexist.

---

## Out of scope (won't ship)

- **Multi-user auth, team plans, RBAC.** Single-operator product. Auth is Cloudflare Access at the edge.
- **AI-assisted harness authoring.** The harness builder is a visual editor only — no chat-to-DAG, no auto-author-on-miss, no marketplace. *(Re-evaluate post-v1.)*
- **Cost dashboards or budget caps.** Cost lives in the Anthropic/OpenAI/OpenRouter dashboards. Symphony does not enforce per-run or daily token caps. If runaway spend becomes a problem, lift the decision then; don't preempt it now.
- **Auto-merge of PRs.** Every PR remains human-reviewed and human-merged. Validation gates inside the workflow (typecheck, tests, eval suite) gate the *PR open*, not the *merge*.
- **SSH worker extension** (Symphony spec Appendix A). Localhost-only execution.
- **Desktop or mobile native app.** Phone surface is Slack and the responsive web UI behind Cloudflare Access.
- **Drag-to-reorder kanban / inline issue editing.** Linear is the source of truth for both ordering and content.
- **Pluggable trackers beyond Linear and GitHub.** The interface allows it; only those two ship.
- **First-class tracker write APIs in the orchestrator.** Per spec, ticket writes belong to the agent's tool surface inside the workflow.
- **Generic webhook system / generic workflow engine.** archon already has a workflow engine; Symphony is one invoker on top of it. Not a Zapier.
- **Voice input.** Slash commands and threaded replies are sufficient.

---

## Reference implementations & inspiration

We're not the first ones building in this shape. The following influenced architectural choices and are worth pulling specific patterns from when implementing later milestones:

- **[OpenAI Symphony spec](https://github.com/openai/symphony)** — orchestration contract. Reference impl is Elixir; TypeScript/Go/Rust/Java/Python ports exist. We conform to the REQUIRED + OPTIONAL HTTP API; SSH worker is out.
- **[Open SWE](https://github.com/langchain-ai/open-swe)** (LangChain) — async coding agent that auto-opens draft PRs linked to tickets. Cloud sandboxes; Slack + Linear invocation; subagent orchestration. Strong reference for the dispatch → PR pipeline we already have.
- **[OpenHands](https://github.com/OpenHands/OpenHands)** — open Devin equivalent. CLI + desktop GUI + cloud platform; Slack/Linear/Jira integrations. Useful inspiration for the Mission Control timeline UX.
- **Composio AO** — multi-agent in isolated worktrees, each with its own PR; agents fix CI failures and respond to review comments. Mirrors the worktree model; pattern to study for post-v1 PR-feedback loops.
- **[builderz-labs/mission-control](https://github.com/builderz-labs/mission-control)** — self-hosted AI agent dashboard, SQLite-backed, no external deps. Closest analog to our Mission Control surface.
- **OpenClaw Mission Control + Mac Mini playbooks** ([guide](https://www.marc0.dev/en/blog/ai-agents/openclaw-mac-mini-the-complete-guide-to-running-your-own-ai-agent-in-2026-1770057455419)) — the dominant 2026 pattern for 24/7 launchd-managed agents on a Mac mini. Validates our hosting model and provides battle-tested launchd plist templates.

We are not depending on any of these; we are taking the shapes that worked and the hard-earned UX defaults.

---

## Tech stack

- **Runtime:** [Bun](https://bun.sh) ≥1.3, TypeScript ESM-only, monorepo via Bun workspaces. Strict TS (`strict`, `noUncheckedIndexedAccess`). Zero `bun test` from repo root — per-package isolated runs (see `CLAUDE.md`).
- **Daemon:** Hono via Bun's HTTP server (port 3090 by default). Pino structured logging. SQLite (default) or Postgres (opt-in via `DATABASE_URL`). All major routes Zod + OpenAPI.
- **Symphony orchestrator:** `@archon/symphony` — orchestrator, dispatcher, retry queue, reconciler, trackers (Linear live; GitHub stub). Tied into archon's `IWorkflowStore` via the `BridgeDeps` adapter.
- **Workflow engine:** `@archon/workflows` — DAG / loop / approval / bash / script / prompt / command / agents nodes, hot-reloaded YAML. `IWorkflowStore` abstraction over SQLite/Postgres.
- **Agent backends:** `@archon/providers` — Claude (`@anthropic-ai/claude-agent-sdk`), Codex (`@openai/codex-sdk`, with native binary support), Pi (`@mariozechner/pi-coding-agent` for ~20 LLM backends including OpenRouter, Together, Groq, etc.). Backend selectable per-workflow or per-node.
- **Web UI:** Vite + React 19 + Tailwind 4 + shadcn + Zustand. SSE for live streams. OpenAPI-derived TypeScript types via `bun generate:types`. Workflow Builder uses an existing DAG canvas in `WorkflowBuilderPage`.
- **Platform adapters:** `@archon/adapters` — Slack (sdk + polling), Telegram (bot api + polling), GitHub (webhooks + gh CLI), Discord (discord.js).
- **Hosting:** Mac mini under `launchd` user LaunchAgent; Cloudflare Tunnel (`cloudflared` also under `launchd`) → `archon.<domain>` → `127.0.0.1:3090`; Cloudflare Access protecting `/`, `/api/*`, `/mission`; `/webhooks/github` and `/webhooks/slack` bypassed and verified by signed-request middleware.
- **Tooling:** `gh` CLI, `git worktree`, vitest-equivalent via `bun test`, `bun run validate` for pre-PR (type-check + lint + format + tests + bundled-defaults check).

---

## External integrations

| Integration | Purpose | Credentials needed | Status |
|---|---|---|---|
| **Linear** | Tracker source-of-truth across all registered codebases; agent calls Linear's GraphQL to transition state and post comments | `LINEAR_API_KEY` in `~/.archon/.env` | Live |
| **GitHub (via `gh` CLI)** | Branch push, PR creation, PR-URL backlink, GitHub `@archon` adapter for ad-hoc dispatch | `gh auth status` (OAuth) + GitHub App webhook secret | Live |
| **OpenAI Codex SDK** | Default agent backend (`@openai/codex-sdk` + native binary); per-node override via workflow YAML | None at daemon level (Codex manages its own auth) | Live |
| **Anthropic Claude Agent SDK** | First-class agent backend; supports MCP, hooks, skills, sub-agents | `claude login` (OAuth/subscription) **or** `ANTHROPIC_API_KEY` | Live |
| **Pi (`@mariozechner/pi-coding-agent`)** | Community provider; one harness, ~20 LLM backends via `<provider>/<model>` refs (OpenRouter, Together, Groq, etc.) | Per-backend API key (e.g. `OPENROUTER_API_KEY`) | Live (`builtIn: false`) |
| **Slack** | Phone-first control plane (`/symphony status`, `@symphony work on …`, threaded run output, `@symphony cancel`) | Slack app: signing secret + bot token + slash command + Events API URL | M3 |
| **Cloudflare Tunnel + Access** | Public HTTPS for Slack webhooks; auth gate for dashboard | Cloudflare account, domain on Cloudflare DNS, `cloudflared` token | M5 |
| **Outbound uptime heartbeat** | Dead-man's switch | [Healthchecks.io](https://healthchecks.io) (or equivalent) ping URL | M5 |

---

## Conceptual data model — what the daemon needs to remember

Almost all of this lives in archon's existing SQLite/Postgres tables (see `CLAUDE.md` § Database Schema for the canonical list). Symphony reuses them rather than introducing parallel storage. A small Symphony-only table set tracks dispatcher state; everything else is shared with the rest of archon.

### Codebases *(archon, existing)*
- `id`, `name`, `path`, `commands` (jsonb), env-var keys, etc.
- Symphony resolves Linear-project → codebase by matching the project name to `codebases.name` (configurable in `~/.archon/symphony.yaml`).

### Workflow run *(archon, existing)*
- `id`, `workflow_name`, `codebase_id`, `status`, `created_at`, `completed_at`, run-context JSON.
- Powers Mission Control's run history; replay uses these rows + `workflow_events` to re-execute deterministically.

### Workflow event *(archon, existing)*
- Step-level transitions, artifacts, errors, agent events.
- The unified event stream Mission Control subscribes to over SSE.

### Issue *(read from Linear, normalized — Symphony-side, in-memory + dispatch row)*
- Linear's UUID, identifier (`APP-123`), title, description, priority, state, branch hint, URL, labels, blocked-by, timestamps.

### Symphony dispatch *(Symphony-side table)*
- `dispatch_id`, `dispatch_key` (e.g. `linear:APP-123`), `tracker`, `issue_id`, `identifier`, `codebase_id`, `workflow_name`, `cwd` (worktree), `workflow_run_id` (FK to archon), `attempt`, `started_at`, `completed_at`, `status`, `error`.
- Source of truth for per-issue dispatch lifecycle; cross-references the archon `workflow_runs` row that owns the actual execution.

### Retry queue entry *(Symphony in-memory; rebuilt from dispatches on restart)*
- Issue id, attempt number, delay kind (`continuation` | `failure`), due-at, last error code/message.

### Symphony config snapshot *(immutable, rebuilt on `~/.archon/symphony.yaml` change)*
- Trackers (kind, project slug, active/terminal states, repository hints), polling interval, max concurrent agents, workspace root, hooks, per-workflow overrides.

### Eval result *(M6, new table)*
- `eval_run_id`, `workflow_name`, fixture issue id, baseline PR url, replay PR diff, validation result, score deltas vs prior run.

---

## Milestones

The legacy roadmap waves landed; this is the post-port arc.

---

### M0 — Symphony port + correctness fixes **(SHIPPED)**

What this milestone delivered: a single archon-symphony binary that owns everything Symphoney did plus everything archon does, with the four post-port correctness/observability gaps closed.

**What got built**
- Symphoney's daemon was ported into the archon monorepo as `@archon/symphony` (#7, v0.4.0). Workspace, agent, and DB layers were replaced with archon's existing equivalents. Legacy `symphoney-codex` archived at `v1-final-pre-archon-merge`.
- Reconcile loop fills the post-port stub: polls upstream `workflow_run` status, detects terminal upstream states, cancels runs whose tracker issues left active state, per-entry try/catch.
- Tracker backlinks: PR completion / failure posts a Linear comment via `commentOnIssue` (Linear: live mutation; GitHub: throws stub, swallowed safely).
- `/api/health.symphony` block exposes `getSnapshotView()` (counts + running + retrying) for external uptime checks.
- `/symphony` chat commands (`status`, `work on`, `cancel`, `help`) routed through archon's deterministic command handler from any chat platform. Auto-prefix bare ids with `linear:`.

**Done when** ✅ archon-symphony runs as a single binary, the symphony daemon polls Linear and dispatches workflows, and all four ported gaps are validated end-to-end via Chrome + curl + 72/72 symphony tests + 170/170 core tests. *(2026-05-01.)*

---

### M1 — Mission Control web UI **(NEXT)**

What this milestone delivers: a phone-friendly command center where every dispatch's state is visible in real time and any historical run can be opened, inspected, and replayed.

**What gets built**
- New route `/mission` in `@archon/web`. Three views, all SSE-fed:
  - **Live runs** — running, retrying, recently completed across all codebases, with a per-run event timeline drawer (workflow nodes, agent events, tool calls).
  - **History** — paginated, searchable list of every `workflow_run`. Filters: codebase, workflow, status, error class, time range. Click → timeline drawer.
  - **Replay** — given a historical run, re-execute the same workflow against the same input snapshot in a fresh worktree. Useful for "did this flake?" and "did the workflow still work after I edited the prompt?" Deterministic only where the workflow is deterministic; explicitly labeled.
- New SSE endpoint `GET /api/mission/stream` consolidating workflow-event + symphony-dispatch streams.
- Filters and search backed by existing `workflow_runs` / `workflow_events` indexes; add a single composite index if profiling demands it.
- Phone-first responsive layout; Cloudflare Access-friendly.

**Explicitly NOT in this milestone**
- Cost / token dashboards. Use provider dashboards.
- Editing workflows from Mission Control. That's the Harness Builder (M2).
- Multi-tenant filters. Single operator.

**Done when** From a phone behind Cloudflare Access, the operator can see exactly what's running on which codebase, watch a run's tool calls land in real time, search history for "all failed runs in the last 7 days on `archon-symphony`," open one, and click "replay" to re-execute in a fresh worktree.

---

### M2 — Harness Builder polish

What this milestone delivers: the visual editor for workflows graduates from scaffolding to daily driver.

**What gets built**
- DAG canvas in `WorkflowBuilderPage`: zoom, pan, snap, multi-select, copy/paste nodes, undo/redo. Powered by an off-the-shelf canvas library (likely `reactflow`).
- Node palette with all archon node types (`prompt`, `command`, `bash`, `script`, `loop`, `approval`, `agents`) and a contextual properties panel per node — provider, model, tools, env, retry, timeout.
- Live YAML preview pane (collapsed by default), bidirectional editing, schema validation against `dagNodeSchema` and `workflowBaseSchema` on every keystroke.
- "Test run" button that executes the in-progress workflow against a sample issue input in a throwaway worktree, surfacing the result in the Mission Control timeline drawer without saving the workflow.
- Save → writes to `.archon/workflows/<filename>.yaml` in the codebase, runs validation, posts to existing `PUT /api/workflows/:name`.
- Import existing workflows (project-scoped or home-scoped) into the editor; flag bundled defaults read-only.

**Explicitly NOT in this milestone**
- AI-assisted authoring. No chat-to-DAG; no autosuggest. Text editing of the YAML in your IDE remains the power-user path.
- Marketplace / harness sharing. Just files in `.archon/workflows/`.
- Workflow versioning beyond git. Use git.

**Done when** The operator can author a new workflow end-to-end in the browser — drag nodes, wire dependencies, set per-node provider/model, run a smoke test against a sample issue — and ship it to `.archon/workflows/` without ever opening a YAML file.

---

### M3 — Slack control plane parity

What this milestone delivers: usable from a phone in a meeting. Same bar as the legacy "Wave 2.1" milestone, retargeted at archon's Slack adapter.

**What gets built**
- Three primitives on the existing Slack adapter:
  - `/symphony status` → Block Kit summary: per-codebase running/retrying/completed, lifecycle pills, links to Mission Control + open PRs.
  - `@symphony work on APP-123` → claim + dispatch immediately, bypassing polling cadence (still respects slot caps + blockers).
  - Threaded run output — bot posts the workflow's plan node output as a thread reply on dispatch, status updates per terminal state, PR URL on completion. `@symphony cancel` in-thread aborts the dispatch and writes a cancellation comment to Linear.
- Slack signing-secret verification middleware on `/webhooks/slack`.
- Map each Slack message → existing `web` adapter conversation so chat history threading mirrors what archon already does for the web UI.

**Explicitly NOT in this milestone**
- Slack modals, multi-channel routing, per-user prefs, voice input, message scheduling, slash subcommands beyond the three primitives.
- Native iOS/Android app.

**Done when** From a phone in a meeting, the operator can run `/symphony status`, see what's running on which codebase, type `@symphony work on APP-300`, see the plan thread, and either let it run or `@symphony cancel`.

---

### M4 — Multi-codebase auto-eligibility & GitHub tracker

What this milestone delivers: every registered codebase is automatically eligible for Symphony dispatch, and GitHub Issues are a viable alternative tracker for repos that don't use Linear.

**What gets built**
- `~/.archon/symphony.yaml` per-codebase block: `linear_project_name` (defaults to codebase `name`), workflow override, max-concurrent override. Default config auto-discovers all codebases registered in archon's `codebases` table.
- Linear-project↔codebase mapping precomputed at config-load time and re-resolved on hot-reload; mismatch surfaces as a config error with a fix-it hint.
- GitHub tracker: `fetchCandidateIssues` against `gh issue list`, `commentOnIssue` via `gh api`, eligibility derived from labels (`symphony:eligible` etc.) since GitHub Issues lacks first-class workflow states.
- Per-codebase concurrency cap separate from the global one (so a hot codebase can't starve the rest).

**Explicitly NOT in this milestone**
- Pluggable third trackers (Jira, ZenHub). Linear + GitHub only.
- Cross-tracker issue dependencies. Each issue's blockers stay within its tracker.

**Done when** The operator registers a brand-new codebase via `archon codebase register`, drops a workflow into its `.archon/workflows/`, names a Linear project to match, and within one polling cycle Symphony picks up issues from that project and ships PRs against the new repo.

---

### M5 — 24/7 Mac mini hosting

What this milestone delivers: archon-symphony runs as a real always-on service the operator never thinks about.

**What gets built**
- `launchd` plist template at `infra/launchd/dev.archon.symphony.plist` with `WorkingDirectory`, `ProgramArguments`, env-file load, `KeepAlive` true, log paths, and a one-line `launchctl bootstrap gui/<uid>` install command.
- `cloudflared` config template at `infra/cloudflared/config.yml` with one ingress rule routing `archon.<domain>` → `127.0.0.1:3090`. Tunnel runs under its own `launchd` plist.
- Cloudflare Access policy: protect `/`, `/api/*`, `/mission`; bypass + verify `/webhooks/*` via signed-request middleware in archon.
- `GET /healthz` (non-sensitive: uptime, last-poll-age, last tracker error, running count, DB health) plus an outbound heartbeat to Healthchecks.io on every successful poll.
- A 1-page `infra/README.md` runbook: bootstrap a new mini, install Bun, clone repo, install plists, configure tunnel, point Linear webhook (if used) at the public URL.

**Explicitly NOT in this milestone**
- Docker. The mini owns the runtime; containers add no value here.
- HA / failover. Single mini, single operator. The dead-man's switch is the heartbeat.

**Done when** The mini reboots, the daemon comes up under `launchd`, the tunnel reconnects, the dashboard is reachable from a phone behind Cloudflare Access, and the heartbeat keeps green for 30 days without a manual restart.

---

### M6 — Eval suite & regression detection

What this milestone delivers: every workflow has an objective merge-rate / time-to-PR / validation-pass score that the operator can trust.

**What gets built**
- `archon-eval` workflow that, given a fixture set of closed Linear issues with known-good baseline PRs, replays each through Symphony in throwaway worktrees and records: touched-file delta from baseline, validation result, time-to-PR, model+token deltas.
- Fixture set seeded from `~/.archon/evals/<codebase>/` — a directory of frozen Linear issue snapshots with their merged PR diffs.
- Nightly cron via `launchd` (or recurring archon workflow) runs the suite, writes rows to a new `eval_results` table.
- Mission Control gains a third tab: **Evals** — per-workflow scoreboard, week-over-week trend, regression callouts when a metric drifts >X% (default 15%).
- No LLM-as-judge: only deterministic artifacts (file diffs, validation exit codes, token counts).

**Explicitly NOT in this milestone**
- Auto-rollback of workflow edits when regressions trip. The operator decides.
- Cross-codebase eval generalization. Each codebase has its own fixture set.

**Done when** A drift-introducing edit to a workflow's prompt (e.g. a clumsy refactor of `archon-feature-development`) shows up red on the next nightly Eval scoreboard, *before* the operator notices a real Linear PR going sideways.

---

### M7 — North star: self-ship + external repo

What this milestone delivers: the proof.

**What gets demonstrated**
- The last three roadmap items shipped on `archon-symphony` were dispatched by Symphony itself; the operator only reviewed and merged.
- At least one merged PR on a *different* registered codebase (the operator's choice — pick a real one, not a hello-world repo) came from a Symphony dispatch.
- The Mission Control eval scoreboard has flagged at least one regression that the operator wouldn't have caught by reading the diff.
- The mini has been continuously up for ≥30 days without a manual restart, and the heartbeat hasn't paged.

**Done when** All four are true, simultaneously.

---

## Vision-level success criteria

archon-symphony is "done" for the operator's purposes when **all** of the following are true:

1. **Phone-to-PR.** The operator can describe a feature in a Linear issue from their phone, walk away, and find a mergeable PR waiting when they next open GitHub — for any registered codebase that has Symphony enabled.
2. **Self-ship + external.** The last three roadmap items on `archon-symphony` shipped via Symphony dispatch, *and* at least one merged PR on a different repo came from Symphony.
3. **Reliability.** The mini has been up ≥30 days without manual intervention, and the heartbeat hasn't paged.
4. **Eval has caught a regression.** The eval scoreboard has flagged at least one regression the operator didn't catch by reading the diff.
5. **Visibility.** The operator has not opened a database client, a log file, or a JSON log line in the last week to answer "what is Symphony doing right now?" — Mission Control has been sufficient.
6. **Operating cost is dominated by agent token spend, not infrastructure.** $0 hosting beyond Cloudflare's free tier and the mini's electricity; $X for Codex/Claude/Pi usage.

When all six are true, archon-symphony has cleared the bar of "personal AI engineering team that runs 24/7." Until then, it's a tool the operator is still feeding by hand.
