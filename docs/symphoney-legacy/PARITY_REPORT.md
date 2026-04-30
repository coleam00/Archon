# Symphoney-codex parity report

How this build compares to the official OpenAI Symphony reference, and what it would take to close the gap. Every claim below is grounded in `SPEC.md` (line references inline) or in the implementation under `src/`.

## TL;DR

The orchestrator core is **spec-conformant**. Workers loop, retry, reconcile, emit events, and serve the HTTP API exactly as the spec prescribes. The gap that makes day-to-day runs feel broken — the 20-turn loop you saw — is **a missing extension, not a missing fix**. The spec defines an opt-in mechanism (`linear_graphql` client-side tool) that lets the agent move the issue out of an active state when it's done. Without it, the worker has no way to know "work is complete" and must run until `agent.max_turns`. The official Symphony ships with that extension wired up; symphoney-codex does not.

## Root cause: the 20-turn loop

**What you observed (APP-267):** worker wrote `hello.txt` on turn 1, then ran 19 more turns, hit `max_turns: 20`, exited normally, and was about to be dispatched again.

**Why the spec says this is correct:** `SPEC.md:1808-1862` describes `run_agent_attempt`. After every successful turn, the worker:
1. Calls `tracker.fetch_issue_states_by_ids` to refresh the issue (`SPEC.md:1843`)
2. Breaks if the state is no longer in `tracker.active_states` (`SPEC.md:1851-1852`)
3. Otherwise breaks at `max_turns`

The implementation matches: `src/orchestrator/orchestrator.ts:396-409` runs the same refresh/break logic.

**What the spec leaves to extensions:** `SPEC.md:38-42` declares Symphony "a scheduler/runner and tracker reader" and explicitly delegates ticket writes to the agent: *"Ticket writes (state transitions, comments, PR links) are typically performed by the coding agent using tools available in the workflow/runtime environment."* The standardized mechanism is the optional `linear_graphql` client-side tool extension (`SPEC.md:1047-1087`). With it, the agent can run a Linear `issueUpdate` mutation as its final step, the orchestrator's next refresh sees a non-active state, the loop breaks, and a continuation retry releases the claim.

Without `linear_graphql`, the only way the loop ends short of `max_turns` is **out-of-band reconciliation** — a human moves the issue, or a separate process does. `SPEC.md:41` calls this out: *"A successful run can end at a workflow-defined handoff state (for example `Human Review`), not necessarily `Done`."*

**Verdict:** the loop isn't a bug in the orchestrator. It's the absence of the optional extension. The official Symphony solves it by shipping `linear_graphql`.

## In-scope gaps to reach official-Symphony behavior

These are the changes I'd land, in order, to make this build feel like the OpenAI build.

### 1. Implement the `linear_graphql` client-side tool extension *(highest leverage)*

Spec contract: `SPEC.md:1056-1087`. Single tool, single GraphQL operation per call, reuses the configured Linear endpoint and auth, returns structured success/error payload.

Surface for both backends:

- **Codex backend** (`src/agent/stdio-client.ts`): advertise the tool via the targeted Codex protocol's tool-registration mechanism. Match the exact input/output shape from the spec. Route invocations to a small executor that wraps `LinearTracker.graphql(...)`.
- **Claude backend** (`src/agent/claude-adapter.ts:34`): the SDK `mcpServers` slot is already plumbed but never populated. Add an in-process MCP server (FastMCP-style) that exposes the same `linear_graphql` tool. Pass it via `ClaudeAdapterOptions.mcpServers`. Add `mcp__symphony__linear_graphql` to `claude.allowed_tools` defaults.

Update the WORKFLOW.md prompt template so the agent knows the tool exists and is expected to transition the issue when work is complete. Without that prompt instruction the tool would be present but never used.

This single change closes the 20-turn loop, plus enables comments, PR-link writes, and richer state transitions (`Human Review`, custom workflow states).

### 2. Continuation-turn prompt differentiation

`SPEC.md:633-634`: *"Continuation turns SHOULD send only continuation guidance to the existing thread, not resend the original task prompt that is already present in thread history."*

Current behavior: `src/orchestrator/orchestrator.ts:368-376` re-renders the full prompt template every turn, passing `turn_number` and `attempt` as variables. The shipped `WORKFLOW.md` template doesn't branch on those — turn 7 sends the same wall of text as turn 1.

Two ways to fix:

- **Template-driven (lighter touch):** update `WORKFLOW.example.md` and `WORKFLOW.md` to branch with `{% if turn_number > 1 %}continuation guidance only{% else %}full prompt{% endif %}`. Document the convention.
- **Orchestrator-driven (cleaner):** when `turn_number > 1`, skip rendering and send a fixed continuation prompt (e.g., "Continue. If the issue is complete, transition it via `linear_graphql` and stop."). Keep the workflow template responsible only for turn 1.

The Claude SDK is hit hardest by the duplicate prompts: it resumes the same thread (`options.resume`) and the SDK already replays the original prompt internally, so resending it adds tokens for no gain. Worth fixing for both backends.

### 3. Emit per-event log lines on the daemon log channel

`SPEC.md:1006-1019` lists the events Symphony emits (`session_started`, `turn_completed`, `turn_failed`, …). The implementation captures them via `applyAgentEvent` (`src/orchestrator/orchestrator.ts:436`), records them on the running entry, and surfaces them through the HTTP API's `last_event` field. But the **pino daemon log only logs scheduling/lifecycle events** (`dispatch_started`, `worker_completed`, `retry_scheduled`); it does not emit a structured pino line per agent event.

The smoke run for goal #2 made this concrete: I tail-grepped the daemon log for `turn_completed` and got nothing, even though the events were arriving. They're observable through `/api/v1/state`, but not through `tail -f log`.

Fix: in `applyAgentEvent`, emit a `logger.info({ event, turn_id, usage, … }, "agent_event")` line for spec-listed events. Cheap, no schema change, makes operator debugging dramatically easier.

### 4. Auto-transition issues to `In Progress` on dispatch *(arguably should be agent-driven, see note)*

`SPEC.md` example response on line 1403 shows a running issue with `state: "In Progress"`. In practice the official Symphony tends to start issues in `Todo`, dispatch them, and they show as `In Progress` while running. Two ways that happens:

- **Agent-driven:** the agent moves Todo → In Progress as its first act after the prompt loads. Requires `linear_graphql`, so this rolls into change #1.
- **Orchestrator-driven:** the dispatcher mutates the tracker on claim. Spec is ambiguous — Section 7.1 covers internal claim states but doesn't require a tracker mutation. `SPEC.md:1202-1209` actively discourages this: *"Symphony does not require first-class tracker write APIs in the orchestrator."*

Recommendation: stick with agent-driven via `linear_graphql`. Don't add tracker writes to the orchestrator.

### 5. Tighten `usage` accounting for the Claude backend

`src/agent/claude-adapter.ts:307-313` (`readUsageFromResult`) reads only `SDKResultMessage.usage.input_tokens` and `output_tokens`. The Claude SDK additionally reports `cache_creation_input_tokens` and `cache_read_input_tokens`, which are dropped. After the smoke run the orchestrator's running totals will systematically under-count tokens for any prompt that cache-hits.

Spec impact: minor. `SPEC.md:13.5` (referenced by `events.ts`) tells us to prefer absolute thread totals, not cache deltas. But the Codex backend also reports cache totals, so omitting them on the Claude side is a backend-asymmetry bug. Add the cache fields to the `TokenUsage` shape and aggregate them.

### 6. Workflow-template documentation: explain `linear_graphql` is the exit signal

Once #1 ships, the example workflow should make this loud. Current `WORKFLOW.example.md` has no instruction to the agent about how to terminate a run. Add a section that says, in effect: *"When the work is complete, call `linear_graphql` to set state to Done (or your handoff state). Otherwise the worker will keep prompting you up to `agent.max_turns` times."*

## Out-of-scope items (deferred per `memory/spec-scope.md`)

These were explicitly left out at planning time. Listing them so they're not lost.

### A. SSH worker extension (`SPEC.md` Appendix A)

Out of scope. Lets workers run on a remote host instead of localhost. Requires SSH transport, remote workspace lifecycle, port-forwarded health. Significant surface area. Not needed for single-machine use.

### B. `linear_graphql` *(now in-scope per recommendation #1)*

Originally deferred because the spec calls it OPTIONAL. Recommending we move it to in-scope: it's the lowest-cost change with the highest behavioral impact, and lots of subtle UX problems (the 20-turn loop, missing state transitions, no agent-side commenting) all collapse into this one feature.

### C. Durable retry persistence

Out of scope. `state.retry_attempts` lives in process memory; a daemon restart drops the queue. Spec doesn't require persistence (`SPEC.md` Section 7 describes the state machine but doesn't mandate a persistent store). If we ever run as an unattended service, this becomes worth adding (SQLite or a JSON snapshot).

### D. Pluggable trackers beyond Linear

Out of scope. The `Tracker` interface in `src/tracker/types.ts` is open enough to accept a non-Linear adapter, but only the Linear implementation ships. Adding GitHub Issues / Jira / Plane is additive but not on the path to OpenAI-Symphony parity (the official build is also Linear-first).

### E. First-class tracker write APIs in the orchestrator

Out of scope and **should stay that way**. `SPEC.md:1202-1209` and the explicit TODO at `SPEC.md:2098` argue against it. The right place for ticket writes is the agent's tool surface (i.e., #1 above).

## Spec-conformant but worth polishing

Small items. Each is a few lines, no architectural risk.

- **Event-shape coverage in adapters:** `src/agent/events.ts` lists `turn_ended_with_error`, `approval_auto_approved`, `unsupported_tool_call` as types but neither the Codex adapter nor the Claude adapter actually emits them. Either populate them at the right protocol seams or trim the type union.
- **`session_id` cosmetic:** `claude-client.ts:112` composes `session_id = "<thread_id>-<turn_id>"`. Spec confirms this format (`SPEC.md:966`). The "init" placeholder used before the first turn (`-init`) is non-standard — fine for internal use but worth documenting.
- **Workspace persistence on success:** `SPEC.md:1131` says workspaces are intentionally preserved after successful runs. Implementation does this, but `~/symphony_workspaces/` will accumulate forever. Consider a `workspace.retention_days` config or a `pnpm symphoney prune` script.
- **Pre-warm telemetry:** the `claude_sdk_startup_prewarm_done` log is emitted but the duration isn't measured. One-liner: wrap the call in a `Date.now()` delta and log `duration_ms` alongside.
- **Two stray Claude SDK subprocesses observed during the goal-#2 run** were from `~/Symphony/` (a separate fork on this machine), not symphoney-codex. Not actionable in this repo, but worth knowing if you `pkill -f claude-agent-sdk`.

## Recommended order of operations

If you want to ship parity in the smallest number of PRs:

1. **PR 1 — `linear_graphql` MCP for the Claude backend** (closes the 20-turn loop end-to-end on this build's primary path; `mcpServers` slot already exists).
2. **PR 2 — `linear_graphql` for the Codex backend** (matches the official reference for Codex users).
3. **PR 3 — Continuation-prompt differentiation** (template-driven is the cheaper option; orchestrator-driven is cleaner).
4. **PR 4 — Per-event pino log lines** (operator UX; trivial change).
5. **PR 5 — Cache-token accounting in the Claude usage path** (cleanup).
6. **PR 6 — Workflow-template docs and the example update** (so users discover the agent-side state transition convention).

Items 1-4 are the difference between "a build that runs but loops" and "a build that feels like the OpenAI Symphony." Items 5-6 are polish.

## Appendix: what was directly verified this session

- **Goal #1** — adapter-level smoke (`scripts/smoke-claude.ts`): PASS. Thread-id format, turn outcome, file write, event flow all match spec. OAuth path works (Keychain entry `Claude Code-credentials`).
- **Goal #2** — daemon end-to-end against APP-267 in Symphony Smoke: PASS for the dispatch path; the 20-turn cap was the observed pain point analyzed above. APP-267 was transitioned to Done by hand at the end of the run; WORKFLOW.md was reverted to the codex backend.
