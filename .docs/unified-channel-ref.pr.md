## Summary

- Problem: No part of the system has a reliable, generic way to know "which adapter and
  which channel did this message come from." `conversationId` looks like it should answer
  this but doesn't — Slack's is a composite `channel:threadTs` string, Discord's is the
  _thread_ ID (not the parent channel) for threaded messages, and Telegram/GitHub/Web each
  encode something different again.
- Why it matters: workflow authors have no `$CHANNEL_ID` to branch or report on, operators
  reading logs can't tell which Slack channel without decoding `conversationId`, and the
  chat agent itself has no awareness of which channel/adapter it's replying in.
- What changed: added one new optional field, `channelRef: ChannelReference`
  (`{ adapter, channelId, channelName? }`), to the two existing option-bags that already
  carry per-message metadata from adapter → orchestrator → workflow execution
  (`HandleMessageContext`, `ExecuteWorkflowOptions`). It now surfaces in structured logs, a
  new AI system-prompt section, workflow `$ADAPTER`/`$CHANNEL_ID`/`$CHANNEL_NAME` variables,
  and `ADAPTER`/`CHANNEL_ID`/`CHANNEL_NAME` env vars for `bash:`/`script:` nodes. All 8
  adapters (Slack, Telegram, Discord, GitHub, GitLab, Gitea, Web, CLI) construct it.
- What did **not** change (scope boundary): no DB schema changes (transient, optionally
  recorded into the existing `workflow_runs.metadata` JSONB blob); no Slack channel-name API
  lookup (v1 only populates `channelName` where free on the inbound event — Discord,
  Telegram); no new YAML surface field or node type.

## UX Journey

### Before

```
User (Slack)                  Adapter                  Orchestrator                Workflow
────                           ───────                  ────────────                ────────
sends message in #eng-bots ──▶ conversationId =
                                "C0912:1699...ts"
                                (channel opaque,
                                 unparseable)      ──▶  handleMessage(platform,
                                                          conversationId, msg)
                                                          logs: {conversationId}
                                                          no "which channel" fact ──▶ executeWorkflow(...)
                                                                                       $ADAPTER, $CHANNEL_ID
                                                                                       don't exist
                                                                                       AI has no idea which
                                                                                       channel it's in
```

### After

```
User (Slack)                  Adapter                  Orchestrator                Workflow
────                           ───────                  ────────────                ────────
sends message in #eng-bots ──▶ builds channelRef =
                                { adapter: 'slack',
                                  channelId: 'C0912' } ──▶ handleMessage(platform,
                                                             conversationId, msg,
                                                             { channelRef }) [+]
                                                             logs: {conversationId,
                                                               adapter, channelId} [+]
                                                             direct-chat system prompt
                                                             gains "## Message Origin" [+] ──▶ executeWorkflow(..., { channelRef }) [+]
                                                                                                $ADAPTER='slack',
                                                                                                $CHANNEL_ID='C0912' [+]
                                                                                                bash:/script: nodes see
                                                                                                ADAPTER/CHANNEL_ID env [+]
```

## Architecture Diagram

### Before

```
Slack/Telegram/Discord/GitHub/GitLab/Gitea adapters
        │
        ▼
handleMessage() (orchestrator-agent.ts)
        │
        ├──▶ prompt-builder.ts (buildOrchestratorSystemAppend)
        │
        └──▶ dispatchOrchestratorWorkflow() / handleWorkflowInvocationResult() /
             handleWorkflowRunCommand() / dispatchBackgroundWorkflow()
                        │
                        ▼
             executeWorkflow() (workflows/executor.ts)
                        │
                        ▼
             executeDagWorkflow() (workflows/dag-executor.ts)
                        │
                        ▼
             substituteWorkflowVariables() (workflows/executor-shared.ts)
                        │
                        ▼
             bash:/script: node subprocess env
```

### After

```
Slack/Telegram/Discord/GitHub/GitLab/Gitea/Web/CLI adapters
  [~] each constructs ChannelReference at its own wiring point
        │
        ▼ (channelRef in HandleMessageContext)
handleMessage() (orchestrator-agent.ts)  [~]
        │
        ├──▶ prompt-builder.ts (buildOrchestratorSystemAppend)
        │       └──▶ buildChannelReferenceSection() [+new function]
        │
        └──▶ dispatchOrchestratorWorkflow() / handleWorkflowInvocationResult() /
             handleWorkflowRunCommand() / dispatchBackgroundWorkflow()  [~ all thread channelRef]
                        │
                        ▼ (channelRef in ExecuteWorkflowOptions)
             executeWorkflow() (workflows/executor.ts)  [~]
                        │  records channelRef → WorkflowRun.metadata.channel_ref [+]
                        ▼
             executeDagWorkflow() (workflows/dag-executor.ts)  [~ 7 functions threaded]
                        │
                        ▼
             substituteWorkflowVariables() (workflows/executor-shared.ts)  [~]
                        │  $ADAPTER / $CHANNEL_ID / $CHANNEL_NAME [+]
                        ▼
             bash:/script: node subprocess env  [~]
                        │  ADAPTER / CHANNEL_ID / CHANNEL_NAME [+]
```

**Connection inventory:**

| From                                                        | To                                                                                                                                                | Status       | Notes                                                                                                                                  |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| Slack/Telegram/Discord/GitHub/GitLab/Gitea/Web/CLI adapters | `handleMessage()`                                                                                                                                 | **modified** | Each now passes `channelRef` in the `HandleMessageContext` options bag                                                                 |
| `handleMessage()`                                           | `prompt-builder.ts`                                                                                                                               | **modified** | New unconditional call to `buildChannelReferenceSection()` when `channelRef` is present                                                |
| `handleMessage()`                                           | `dispatchOrchestratorWorkflow()` / `handleStreamMode()` / `handleBatchMode()` / `handleWorkflowInvocationResult()` / `handleWorkflowRunCommand()` | **modified** | `channelRef` threaded as a new parameter through each — these turned out to be separate functions, not all inline in `handleMessage()` |
| `orchestrator.ts` (`dispatchBackgroundWorkflow`)            | `executeWorkflow()`                                                                                                                               | **modified** | `WorkflowRoutingContext` gained `channelRef?`                                                                                          |
| `dispatchOrchestratorWorkflow()` etc.                       | `executeWorkflow()` (`workflows/executor.ts`)                                                                                                     | **modified** | `ExecuteWorkflowOptions.channelRef` spread through                                                                                     |
| `executeWorkflow()`                                         | `WorkflowRun.metadata`                                                                                                                            | **modified** | Now records `channel_ref` when present (no schema change — existing JSONB column)                                                      |
| `executeWorkflow()`                                         | `executeDagWorkflow()` (`workflows/dag-executor.ts`)                                                                                              | **modified** | `channelRef` threaded as a trailing parameter                                                                                          |
| `executeDagWorkflow()`                                      | 6 node-type executor functions internally                                                                                                         | **modified** | `channelRef` threaded as each function's trailing parameter                                                                            |
| node-type executors                                         | `substituteWorkflowVariables()` (`workflows/executor-shared.ts`)                                                                                  | **modified** | `channelRef` added to the existing `options` bag                                                                                       |
| node-type executors                                         | `bash:`/`script:` subprocess env                                                                                                                  | **modified** | `ADAPTER`/`CHANNEL_ID`/`CHANNEL_NAME` env vars added alongside existing managed env vars                                               |
| `core/types/index.ts`                                       | `workflows/deps.ts`                                                                                                                               | **new**      | Re-exports `ChannelReference` so `@archon/adapters`/`@archon/server` get it via `@archon/core/types`                                   |
| `TelegramAdapter.onMessage` payload                         | `server/src/index.ts` wiring                                                                                                                      | **modified** | New `chatTitle` field added to `TelegramMessageContext`                                                                                |

## Label Snapshot

- Risk: `risk: low`
- Size: `size: L`
- Scope: `core|workflows|adapters|server|cli|docs`
- Module: `core:orchestrator`, `workflows:executor`, `workflows:dag-executor`, `adapters:slack`, `adapters:telegram`, `adapters:discord`, `adapters:github`, `adapters:gitlab`, `adapters:gitea`

## Change Metadata

- Change type: `feature`
- Primary scope: `multi` (core, workflows, adapters, server, cli)

## Linked Issue

- Closes: **none filed on GitHub yet** — this PR's spec lives in
  `.docs/unified-channel-ref.issue.md` / `.docs/unified-channel-ref.prd.md` in this same
  branch, derived interactively rather than from a pre-existing tracked issue. File a GitHub
  issue from that doc before/when opening the PR if the project wants a tracked number to
  close against.
- Related: none
- Depends on: none
- Supersedes: none

## Rebase (2026-08-13)

Rebased onto `origin/dev` at `2379a2c9` (9 commits ahead of this branch's previous base), picking
up `feat(workflows): structural workflow signature (inputs/returns/with) (#2523)` and
`docs: consolidate agent instructions into AGENTS.md (#2497)` among others. Three conflicts, all
resolved:

- `CLAUDE.md` — upstream reduced it to a one-line `AGENTS.md` pointer; this branch's one actual
  content change (documenting `$ADAPTER`/`$CHANNEL_ID`/`$CHANNEL_NAME`) was moved into
  `AGENTS.md`'s Variable Substitution list instead of restoring the old full `CLAUDE.md`.
- `packages/workflows/src/dag-executor.ts` (4 sites) and `executor-shared.ts` (4 sites) — this
  branch's `channelRef` option and upstream's new `inputs` option collided at every
  `substituteWorkflowVariables()`/`buildPromptWithContext()` call site; merged into one options
  object (`{ stateDir, inputs, channelRef }`) everywhere, plus the corresponding type signatures.

Post-merge, `type-check` (all 10 packages), `dag-executor.test.ts` (450/450),
`executor-shared.test.ts` (101/101), `executor.test.ts` (84/84), and upstream's own new
`subrun.test.ts` (59/59, untouched by this branch) all pass clean — confirming the manual merge
preserved both features without regressing either. Full results:
`.docs/unified-channel-ref.fail.md`.

## Validation Evidence (required)

Re-verified post-rebase, 2026-08-13: `check:bundled*` (all 5 generated-file checks), `type-check`
(all 10 packages), `lint --max-warnings 0`, and `format:check` all pass. Full `bun run test`,
run per-package to avoid `--parallel`'s SIGINT cascade, passes everywhere except the same 3
pre-existing, deterministic Windows-host failures documented below and in
`.docs/unified-channel-ref.fail.md` — none in a file this branch touches or that the rebase
merged. Original validation evidence from the initial implementation follows unchanged:

```bash
bun run check:bundled            # PASS — bundled-defaults.generated.ts up to date (no bundled files touched)
bun run type-check               # PASS — every package (paths, git, providers, isolation,
                                  #        workflows, core, adapters, server, cli, web, docs-web)
bun run lint                     # PASS — zero warnings (eslint --cache)
bun run format                   # PASS — no files needed reformatting (prettier --write, no-op)
bun run test                     # See per-package breakdown below — 5 pre-existing, unrelated
                                  #   failures confirmed present on the clean baseline; nothing
                                  #   introduced by this change
```

Per-package `bun --filter <pkg> test` results (standalone, avoiding the flaky
resource-contention noted below):

| Package             | Result                                              | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@archon/paths`     | 279 pass, 0 fail                                    | untouched                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `@archon/git`       | 197 pass, 0 fail                                    | untouched                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `@archon/providers` | 1 fail                                              | `pathKind > returns "missing" for a broken symlink` — `EPERM: operation not permitted, symlink` (Windows requires admin/dev mode for symlinks). Untouched by this PR (`git diff --stat -- packages/providers/` is empty); same root cause as the `load-command-prompt.test.ts` failure below                                                                                                                                                     |
| `@archon/isolation` | 0 fail standalone                                   | untouched. Running the full `bun run test` suite (`--filter '*' --parallel`, 10 packages concurrently) intermittently times out 2 of `overlay-scripts.test.ts`'s whiteout-traversal tests at their 5000ms limit — confirmed this is resource contention, not a real failure or a regression: (1) identical on `git stash` baseline, (2) 0 fail when run standalone (`bun --filter @archon/isolation test`), (3) package has zero diff in this PR |
| `@archon/workflows` | 449+84+51+7+… pass across every split group, 0 fail | See below — this is the package the `channelRef` threading touched most; a real regression was caught and fixed mid-implementation (see Risks)                                                                                                                                                                                                                                                                                                   |
| `@archon/core`      | 514 pass, 0 fail                                    | touched (`orchestrator-agent.ts`, `orchestrator.ts`, `prompt-builder.ts`, `types/index.ts`)                                                                                                                                                                                                                                                                                                                                                      |
| `@archon/adapters`  | all pass, 0 fail                                    | touched (Telegram, Discord, GitHub, GitLab, Gitea). Slack is NOT in this list — it required no change inside the `@archon/adapters` package (see the `@archon/server` row and the Connection Inventory below); Slack's `channelRef` is still fully implemented, just entirely at the `server/src/index.ts` wiring point                                                                                                                          |
| `@archon/server`    | 23 pass, 0 fail                                     | touched (`index.ts`, `routes/api.ts`)                                                                                                                                                                                                                                                                                                                                                                                                            |
| `@archon/cli`       | 18 pass, 2 fail                                     | touched (`chat.ts`) — the 2 failures are in `serve.test.ts` (`downloadWebDist`), a `tar` path-quoting issue on Windows (`tar: C\:\\Users\\...: Cannot open`), unrelated to `chat.ts`/`ChannelReference`. `git diff --stat -- packages/cli/src/commands/serve.ts packages/cli/src/commands/serve.test.ts` is empty                                                                                                                                |
| `@archon/web`       | 395+135+... pass, 0 fail                            | untouched except `variables.md` (not test-covered)                                                                                                                                                                                                                                                                                                                                                                                               |

`bun run validate`'s only additional failure beyond the above is `test:install`
(`scripts/test-install.sh`), which explicitly refuses to run outside WSL2
(`[ERROR] Windows is not supported`) — an environment limitation of this Windows dev host,
not a code issue; untouched by this PR.

- Evidence provided: command output captured during this session (type-check/lint/format/test
  logs), plus `git stash`/`git diff --stat` comparisons for every failure to confirm
  pre-existing-and-unrelated status before attributing it as noise.
- Intentionally skipped: `test:install` (requires WSL2, unavailable on this host) and manual
  end-to-end verification against live Slack/Telegram/Discord/GitHub/GitLab/Gitea instances
  (no credentials/sandboxes configured in this environment — see Human Verification).

## Security Impact (required)

- New permissions/capabilities? `No`
- New external network calls? `No` — v1 only reads data already present on the inbound
  event; no adapter makes a new API call to populate `channelRef`.
- Secrets/tokens handling changed? `No`
- File system access scope changed? `No`
- If any `Yes`: n/a. `channelId`/`channelName` are treated as externally-supplied,
  non-secret data — same visibility class as `conversationId` (already logged today) — and
  are delivered to `bash:`/`script:` nodes as subprocess **environment variables**, never
  spliced as raw text into shell/script bodies, matching the existing treatment of
  `$USER_MESSAGE`/`$ARGUMENTS`.

## Compatibility / Migration

- Backward compatible? `Yes` — `channelRef` is optional on every type it was added to; every
  existing caller (adapters, tests, workflow nodes that don't reference the new variables)
  keeps compiling and behaving identically.
- Config/env changes? `No`
- Database migration needed? `No` — `channel_ref` rides the existing `workflow_runs.metadata`
  JSONB/TEXT column, which already accepts arbitrary keys (`z.record(z.string(), z.unknown())`
  in `schemas/workflow-run.ts`).
- If yes: n/a.

## Human Verification (required)

What was personally validated beyond CI:

- Verified scenarios: full-repo type-check/lint/format/test pass; traced the exact call
  chain for every adapter (Slack, Telegram, Discord, GitHub, GitLab, Gitea, Web, CLI) by
  reading each wiring site's surrounding code to confirm the constructed `ChannelReference`
  values match real platform data shapes (e.g. confirmed Slack's `conversationId` really is
  a `channel:threadTs` composite by reading `adapter.ts`, confirmed Discord's `channelId` is
  the thread ID for threaded messages via the adapter's own doc comment).
- Edge cases checked: absent `channelRef` (every new field is optional and fails open to
  empty string / omitted env var / no log field / no prompt section — verified via the
  existing test suite passing unchanged); the positional-parameter regression in
  `dag-executor.ts` (caught via the _existing_ test suite, not new tests — see Risks).
- What was **not** verified: no manual end-to-end test was run against a live Slack,
  Telegram, Discord, GitHub, GitLab, or Gitea instance — no credentials/sandbox were
  configured in this session. No one has visually confirmed the `## Message Origin` system
  prompt section renders correctly inside an actual model response, or manually run a
  workflow with a `script:` node reading `$CHANNEL_ID` end to end. **Recommend a manual smoke
  test on at least one real chat adapter before merge.**

## Side Effects / Blast Radius (required)

- Affected subsystems/workflows: every message-handling path (`handleMessage()` and its
  downstream dispatch functions), every workflow execution path (`executeWorkflow()` →
  `executeDagWorkflow()` → all node-type executors), every adapter's message-receipt wiring,
  and the direct-chat AI system prompt.
- Potential unintended effects: (1) the `## Message Origin` system-prompt section adds a
  small, fixed amount of text to every direct-chat turn where `channelRef` is present — this
  is now unconditional (not gated by provider capability like the run-management section),
  so it appears for every provider on every project-scoped or unscoped chat; if this is
  judged too chatty/unwanted for some provider it would need a follow-up gate. (2) The new
  `channel_ref` key in `workflow_runs.metadata` is additive but does mean the metadata blob
  is slightly larger per run going forward — negligible (a few dozen bytes).
- Guardrails/monitoring for early detection: the new structured log fields
  (`adapter`/`channelId`/`channelName` on `orchestrator_message_received`) make it visible in
  logs immediately if a `channelRef` is malformed or unexpectedly absent for a given adapter.

## Rollback Plan (required)

- Fast rollback command/path: revert this PR's commit(s) on `dev` — every change is additive
  and self-contained to this feature; no data migration to reverse, no config to unset.
- Feature flags or config toggles (if any): none — not gated behind a flag, since it's
  purely additive and fails open when the field is absent.
- Observable failure symptoms: unexpected `## Message Origin` text appearing where not
  wanted in chat responses; `$ADAPTER`/`$CHANNEL_ID`/`$CHANNEL_NAME` resolving to unexpected
  values in a workflow prompt; `ADAPTER`/`CHANNEL_ID`/`CHANNEL_NAME` env vars missing or
  wrong in a `bash:`/`script:` node.

## Risks and Mitigations

- Risk: a first implementation pass threaded `channelRef` into the _middle_ of several
  `dag-executor.ts` function parameter lists (right after `issueContext`). This type-checked
  cleanly (every internal call site was updated correctly) but silently broke ~35 tests in
  `dag-executor.test.ts` that call those functions positionally with the pre-existing
  argument order — trailing arguments landed in the wrong parameter slots at runtime, not a
  compile error.
  - Mitigation: caught by running the _existing_ test suite (not a new test) before
    considering the work done; fixed by repositioning `channelRef` to the true last
    parameter of every affected function, which required zero test-file changes and restored
    all ~35 tests to green. Documented in `.docs/unified-channel-ref.issue.md` Notes as a
    process lesson for future work in this file.
- Risk: no dedicated new unit tests were added for the new behavior itself — `$ADAPTER`/
  `$CHANNEL_ID`/`$CHANNEL_NAME` substitution, the `ADAPTER`/`CHANNEL_ID`/`CHANNEL_NAME` env
  vars, `buildChannelReferenceSection()`, or each adapter's `ChannelReference` construction.
  The full existing suite passing proves no regression, but nothing specifically asserts the
  new behavior is correct beyond manual code reading.
  - Mitigation: flagged explicitly here and in the ISSUE doc as a follow-up; recommend adding
    targeted unit tests (mirroring the existing `$DOCS_DIR` substitution tests and
    managed-env-var tests already in `executor-shared.test.ts`/`dag-executor.test.ts`) before
    or shortly after merge.
- Risk: the `## Message Origin` prompt section is unconditional (every provider, every
  scope) — unlike the run-management section, there's no capability gate or opt-out.
  - Mitigation: it's a single short line, low token cost, and stable per conversation (safe
    under prompt caching). If it proves unwanted for a specific provider/use case, the fix is
    localized to one `if` check in `orchestrator-agent.ts` around the
    `buildChannelReferenceSection()` call.
