# Symphony Roadmap

Long-arc plan for moving this build from "spec-conformant prototype" to "personal tool that feels production." Read top-to-bottom; each wave assumes the previous is done. File:line references point at the current code so future-you can find the touch-points fast.

Companion docs: `SPEC.md` is the source of truth. `PARITY_REPORT.md` is historical and now stale in a few places: `linear_graphql`, continuation prompts, structured agent-event logs, Claude cache-token accounting, and `before_remove` hooks are already implemented in this checkout.

---

## Goals

- Run 24/7 in the background, controllable from Slack on any device.
- Ensure every dispatch produces reviewable output or fails loudly.
- Persist enough state that restarts are invisible and history is queryable.
- Improve output quality gradually: validation gates, plan-then-execute, eval suite.

Out of scope (deliberately): metrics stack, multi-user auth, generic webhook system, the SSH worker extension from the spec.

**North star:** Symphony works on itself. Wave 0 is the hand-coded bootstrap that makes that safe; every later item should ship as a Linear issue dispatched through Symphony and reviewed as a PR.

---

## Wave 0 - Bootstrap self-work safely

Goal: by the end of Wave 0, the next remaining roadmap item is a Linear issue, an agent picks it up in a real git worktree, and the output becomes a PR against `Ddell12/symphoney-codex`.

Run Wave 0 by hand. Do not seed issues for items already implemented.

### 0.1 Dedicated Linear project
- Create a new Linear project **"Symphony"** in the `dell-omni-group` org. Do not reuse the Symphony Smoke sandbox (`d0ef0b50e836` in current `WORKFLOW.md`).
- States must include `Todo`, `In Progress`, `Done`, `Cancelled`. Active states should stay `Todo` + `In Progress`; terminal states should include `Done`, `Closed`, `Cancelled`, `Canceled`, `Duplicate`.
- Update `WORKFLOW.md:tracker.project_slug` to the new project's `slugId`.

### 0.2 Seed only remaining work
- Do **not** create issues for old Wave 1.1 or 1.2. They are already shipped:
- `linear_graphql` exists in `src/agent/linear-graphql-tool.ts` and is wired into `src/agent/stdio-client.ts` + `src/agent/claude-client.ts`.
- Continuation prompts already use `snap.agent.continuation_prompt` on turns 2..N in `src/orchestrator/orchestrator.ts:392-405`.
- Structured `agent_event` pino lines and Claude cache-token accounting are already present.
- Seed the first real queue in this order: hook context/worktree hardening, PR publisher/backlink flow, SQLite persistence, `/healthz`, Slack control plane.

### 0.3 Make hooks workspace-aware before relying on hook scripts
- Current hook execution can accept `env`, but call sites do not pass issue/workspace variables. Do not write hooks that assume `$WORKSPACE_PATH` or `$ISSUE_IDENTIFIER` until this is fixed.
- Extend hook call sites to pass at least `WORKSPACE_PATH`, `ISSUE_ID`, `ISSUE_IDENTIFIER`, `ISSUE_TITLE`, `ATTEMPT`, and `WORKFLOW_PATH`.
- Where: `src/workspace/manager.ts:createForIssue`, `src/workspace/manager.ts:removeForIssue`, `src/orchestrator/orchestrator.ts:runWorker`, and `src/workspace/hooks.ts`.

### 0.4 Workspace = git worktree, not blank dir
- Replace the current `after_create` hook (`WORKFLOW.md:23-25`) only after 0.3 exists:
  ```sh
  git -C ~/symphony-dev/symphoney-codex fetch origin main
  git -C ~/symphony-dev/symphoney-codex worktree add "$WORKSPACE_PATH" -b "sym/$ISSUE_IDENTIFIER" origin/main
  ```
- Extend `before_run` to run `pnpm install --frozen-lockfile` and `pnpm typecheck` so the agent starts in a known-good workspace.
- Add `before_remove` cleanup:
  ```sh
  git -C ~/symphony-dev/symphoney-codex worktree remove --force "$WORKSPACE_PATH"
  ```
- Caveat: `--force` discards uncommitted workspace changes. Only remove worktrees after PR publishing/backlinking has succeeded, or when intentionally cleaning terminal/stale work.
- `src/workspace/safety.ts` pins workspace paths under `workspace.root`, but it is path-safety only. It is not an OS sandbox.

### 0.5 Separate prod and dev checkouts
- **`~/symphony-dev/symphoney-codex`**: the checkout whose git repository owns agent worktrees. Do not run the daemon from here.
- **`~/symphony-prod/symphoney-codex`**: the checkout the daemon and `pnpm start` run from. Update only through explicit `git pull && pnpm build && launchctl kickstart`.
- Correct model: linked worktrees share the git object database and refs, but each worktree has its own working tree and index. The real prod risk is not a shared index; it is running the daemon from a checkout that agents can edit or reload underneath it.
- Agents can still read or mutate prod paths if host permissions allow it. If prod isolation matters, run the daemon and agent workers under separate OS users or a real sandbox.

### 0.6 PR creation and Linear backlink flow
- Do not implement this as a bare `after_run` hook that calls `linear_graphql`. `after_run` runs after `session.stop()`, is best-effort, and cannot feed results back into the same agent session.
- Implement a first-class PR publisher in daemon code or a dedicated script invoked by daemon code. It should:
- Verify the worktree is on branch `sym/<identifier>`.
- Require either committed changes ahead of `origin/main` or a deliberate "no changes" result.
- Run `pnpm typecheck` at minimum before publishing.
- Push with `git push -u origin "sym/$ISSUE_IDENTIFIER"`.
- Run `gh pr create --fill --base main --head "sym/$ISSUE_IDENTIFIER" --body "Fixes $ISSUE_IDENTIFIER\n\nDispatched by Symphony."`.
- Post the PR URL back to Linear using daemon-owned GraphQL/tracker code, or have the agent post it before it transitions the issue.
- Fail loudly if `gh` is not authenticated, the branch is dirty, validation fails, or no PR URL is produced.

### 0.7 First-dispatch ceremony
- Set `agent.max_concurrent_agents: 1` and `agent.max_turns: 12` for the first three dogfood runs. Watch them end-to-end.
- First dispatch after Wave 0: **Wave 1.1 SQLite persistence**.
- Second dispatch: **Wave 2.4 `/healthz` + heartbeat** if operational visibility is the bottleneck, or **Wave 3.1 validation gate** if output quality is the bottleneck.
- After three successful dogfood PRs, restore `max_concurrent_agents: 4` and `max_turns: 20`.

### Safety notes
- Agents edit assigned worktrees, not the prod checkout. Enforce this with filesystem permissions if you need a hard guarantee.
- Do not queue issues that say "modify the running daemon and reload." Changes ship via PR -> merge -> manual prod restart.
- If a self-modification PR breaks `main`, prod is unaffected until you explicitly pull and restart prod.

---

## Wave 1 - Durable state and history

Cheap, high-leverage substrate for Slack, dashboard history, restart recovery, and evals.

### 1.1 Persist run state to SQLite
- **Why:** runtime state is still in-memory in `src/orchestrator/state.ts:49-56`; restart loses running entries, retry counts, and token totals.
- **What:** one `runs.db` next to the workspace root. Tables: `runs`, `turns`, `agent_events`, and a tiny `schema_meta`/`PRAGMA user_version` migration path.
- Use `better-sqlite3`, but do not treat "no migration framework" as "no migrations." Add idempotent migrations and set `PRAGMA journal_mode = WAL` for dashboard/daemon read concurrency.
- Acceptance: kill the daemon mid-run, restart, dashboard/API shows the run as `interrupted` with full turn history; retry counts and token totals survive.

### 1.2 Startup recovery semantics
- On startup, load non-terminal runs from SQLite, reconcile their Linear states, and mark stale running rows as `interrupted`.
- Clear stale in-memory claims from the previous process; do not dispatch duplicate work for issues already inactive or terminal in Linear.
- Add tests that simulate daemon crash after turn events are written but before `worker_exit_normal`.

### 1.3 Event-shape coverage cleanup
- Remaining parity gap: adapter coverage for `turn_ended_with_error`, `approval_auto_approved`, and related protocol-specific events is still uneven.
- Where: `src/agent/events.ts`, `src/agent/stdio-client.ts:577-610`, `src/agent/claude-adapter.ts`.
- Acceptance: event union members are either emitted by at least one adapter with tests or removed/documented as unsupported.

---

## Wave 2 - Slack as the control plane

Goal: usable from a phone in a meeting. Single Slack app, not a platform.

### 2.1 Slack bot - three primitives only
- **`/symphony status`** -> Block Kit message with running issues, phase pill, token meter, and links to dashboard/PRs.
- **`@symphony work on ENG-123`** -> claim + dispatch immediately, bypassing polling.
- **Threaded run output** -> bot posts plan as a thread reply on dispatch and summary/PR URL on completion. User can `@symphony cancel` in-thread.
- Use standard Block Kit first. Slack Card and Alert blocks exist, but verify surface support in Block Kit Builder before using them in messages. Work Objects are a separate unfurl/flexpane feature; use them later for Symphony/Linear URL previews, not as a blocker for v1 status messages.
- Required implementation details: verify Slack signed requests using the raw body, respond to slash commands within Slack's 3-second ack window, handle retries idempotently, and add tests for signature failure.
- Do not build yet: modals, multi-channel routing, per-user prefs, voice input. One channel + DMs is enough.

### 2.2 24/7 hosting on the Mac mini
- **Decision:** Mac mini, not MacBook (sleeps), not VPS (Claude OAuth and local-worktree simplicity matter more than cloud portability).
- Use `launchd`. A user `LaunchAgent` is fine if the Mac mini is logged in; use a `LaunchDaemon` only if it must run before user login.
- The plist should set `WorkingDirectory`, tokenized `ProgramArguments`, `EnvironmentVariables`/env file loading strategy, `KeepAlive`, `StandardOutPath`, and `StandardErrorPath`.
- `pino-roll` is not currently a dependency. Either add it deliberately or rely on `launchd` log paths plus macOS log rotation/newsyslog.
- Verify before committing: `claude login` works on the mini and the selected agent backend picks up OAuth credentials in the launchd environment.

### 2.3 Cloudflare Tunnel + Cloudflare Access
- **Decision:** Cloudflare Tunnel is the right fit for Slack webhooks because Slack needs a public HTTPS URL and `cloudflared` can expose `127.0.0.1:4000` with outbound-only connectivity.
- Setup: `cloudflared` outbound from the mini -> `symphony.yourdomain.com` -> `127.0.0.1:4000`. Run `cloudflared` itself under launchd.
- Protect dashboard routes with Cloudflare Access. Bypass Access only for Slack webhook routes such as `/slack/*`, and rely on Slack signature verification there.
- Cloudflare One's free tier is currently suitable for small personal use, but re-check pricing/seat limits before depending on it for more users.
- Optional: add Tailscale separately only if you want SSH-from-anywhere into the mini. Do not add it just for Symphony HTTP access.

### 2.4 Healthcheck + dead-man's switch
- Add `GET /healthz`. It should return non-sensitive status: process uptime, config loaded, last successful poll age, last tracker error, running count, and SQLite health.
- Prefer an outbound heartbeat to healthchecks.io/UptimeRobot-style monitoring if possible; it avoids exposing unauthenticated health data publicly.
- If external polling is used, expose `/healthz` through Cloudflare with a shared secret/header or a narrow bypass rule. Do not put detailed dashboard state on the unauthenticated health path.

---

## Wave 3 - Output quality

Pick one and let it bake before adding the next. These are what eventually push toward "consistently production-quality."

### 3.1 Validation gate before completion
- Do **not** implement this as `after_run`. `after_run` happens after the session is stopped and failures are ignored, so it cannot feed stderr back as a continuation turn.
- Implement validation before final completion/PR publishing. Options:
- Prompt-only v1: require the agent to run `pnpm typecheck && pnpm test` before calling `linear_graphql` to transition the issue.
- Orchestrator v2: after a turn that appears complete, run validation while the session is still active; on failure, send stderr as the next continuation prompt and keep the issue active.
- Acceptance: agent is not considered done until validation passes or the run explicitly fails with reviewable logs.

### 3.2 Plan-then-execute split
- Turn 1 produces a structured plan as a markdown checklist; subsequent turns execute one item at a time.
- Post the plan to Linear before execution so humans can cancel or redirect early.
- Where: prompt template in `WORKFLOW.md` plus a small parser for checklist extraction. Keep the parser conservative; if extraction fails, continue without blocking the run.

### 3.3 Golden eval suite
- Pick 5 closed Linear issues with known-good PRs. `pnpm eval` replays them through Symphony offline with a fake tracker and compares the produced patch to the merged patch.
- Do not grade with an LLM. Track regression on prompt/model/runtime changes with deterministic artifacts: patch size, touched files, validation result, and whether expected files changed.
- Cadence: weekly via launchd or CI, not an unspecified `/schedule` skill.

### 3.4 Linear UX polish
- Plan-as-comment before execution.
- Per-turn progress comments. Test Linear markdown support before relying on collapsed `<details>`; if unsupported, use compact status comments.
- PR body auto-injects `Fixes ENG-123` so Linear's GitHub integration auto-links.
- Register Symphony as a first-class Linear Agent user. Linear supports agent delegation, but the current tracker only filters by project/state; add tracker support for agent/delegation filtering before making assignment the dispatch trigger.

---

## What to pick up first

**Wave 0, hand-coded, one session.** Required scope: hook context env, worktree setup, prod/dev checkout split, and a real PR/backlink publisher that fails loudly.

Then dispatch **Wave 1.1 SQLite persistence** as the first dogfood issue. The old first issues (`linear_graphql` and continuation prompts) are already done.

After Wave 1.1 ships and bakes, choose one:
- **Wave 2** if the bottleneck is "I can't see/control it from my phone."
- **Wave 3.1** if the bottleneck is "the output isn't trustworthy yet."

Do not do both at once.

---

## Current Implementation Status

Verified in the current checkout:

1. `linear_graphql` client-side tool exists and is wired for both Codex stdio and Claude MCP.
2. Continuation turns use `agent.continuation_prompt`.
3. Spec-listed agent events get structured `agent_event` pino lines.
4. Claude usage includes cache creation/read token fields.
5. `before_remove` hook support exists.
6. HTTP dashboard/API exists at `/`, `/api/v1/state`, `/api/v1/refresh`, and `/api/v1/:identifier`.
7. No SQLite persistence exists yet.
8. No Slack routes exist yet.
9. No `/healthz` exists yet.

Verification commands:

```sh
pnpm typecheck
pnpm test
```

`pnpm test` requires permission to bind localhost for `test/integration/http.test.ts`; without that, sandboxed runs can fail with `listen EPERM`.
