# ChannelReference: know which adapter/channel every message came from

**Labels:** `enhancement`

---

## Problem

- **What problem are you trying to solve?**

  No part of the system has a reliable, generic way to know "which adapter and which
  channel did this message come from." `conversationId` looks like it should answer this
  but doesn't: Slack's is a composite `channel:threadTs` string, Discord's is the _thread_
  ID (not the parent channel) for threaded messages, while Telegram/GitHub/Web each encode
  something different again. Anything that wants "the channel" today has to reach into a
  specific adapter's private string format.

- **Who experiences it?**

  Workflow authors (no `$CHANNEL_ID` to branch or report on), operators reading logs (can't
  tell which Slack channel without decoding `conversationId`), and the chat agent itself
  (no awareness of which channel/adapter it's replying in).

- **How often does it come up?**

  Every inbound message, on every adapter.

---

## Proposed Solution

Add one new optional field, `channelRef: ChannelReference`, to the two option-bags that
already carry per-message metadata from adapter → orchestrator → workflow execution
(`HandleMessageContext` in `@archon/core`, `ExecuteWorkflowOptions` in `@archon/workflows`)
— the same seam `issueContext`/`isolationHints` already use. Fully additive: no existing
signature changes, no required adapter changes, no DB schema changes.

```typescript
// packages/workflows/src/deps.ts
export interface ChannelReference {
  adapter: string; // same value as IPlatformAdapter.getPlatformType()
  channelId: string; // adapter-specific — NOT always equal to conversationId
  channelName?: string; // only when available without an extra network call
}
```

Each adapter constructs it explicitly at its own wiring point (mostly
`packages/server/src/index.ts`, where Discord/Slack/Telegram's `onMessage` callbacks call
`handleMessage()`) — there is no generic derivation from `conversationId`, since that
doesn't hold reliably across adapters (see table below).

---

## User Flow

### Before (current)

```
Adapter receives message
  ├─ Slack: conversationId = "C123:1699999999.000100" (channel embedded, unparseable generically)
  ├─ Discord: conversationId = thread ID for threaded messages (parent channel is a separate, unexposed value)
  ├─ Telegram: conversationId = chat.id (title never surfaces past the adapter)
  └─ No adapter exposes a clean, structured channel fact

Orchestrator
  └─ Logs conversationId + platform, but nothing decodable as "channel"
  └─ Chat agent has no idea which channel it's replying in

Workflows
  └─ No $CHANNEL_ID / $ADAPTER — a workflow can't branch or report on origin
```

### After (proposed)

```
Adapter receives message
  ├─ Slack: builds { adapter: 'slack', channelId: event.channel }
  ├─ Discord: builds { adapter: 'discord', channelId: message.channelId, channelName: message.channel?.name } — free, already cached by discord.js
  ├─ Telegram: builds { adapter: 'telegram', channelId: conversationId, channelName: chatTitle } — one-line adapter change to surface ctx.chat.title
  └─ GitHub/GitLab/Gitea: { adapter: 'github', channelId: `${owner}/${repo}` }

Orchestrator (handleMessage)
  ├─ Structured logs gain adapter/channelId/channelName fields
  └─ Direct-chat system prompt gains a one-line "## Message Origin" section

Workflows
  ├─ $ADAPTER / $CHANNEL_ID / $CHANNEL_NAME available in prompts (empty string if absent)
  └─ ADAPTER / CHANNEL_ID / CHANNEL_NAME env vars in bash:/script: nodes (bare, no ARCHON_
     prefix — matches BASE_BRANCH/CONTEXT/ISSUE_CONTEXT convention)
```

---

## Alternatives Considered

| Alternative                                                     | Pros                                                      | Cons                                                                        | Why not chosen                                             |
| --------------------------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Keep current (decode `conversationId` per-adapter where needed) | Zero new code                                             | Every consumer re-implements adapter-specific parsing; breaks encapsulation | Doesn't scale past one call site                           |
| Derive `channelId` generically from `conversationId`            | Less adapter code                                         | Doesn't work — Discord/Slack `conversationId` isn't the channel             | Confirmed false by reading the adapters                    |
| Make `channelRef` a required field (original draft)             | Enforced everywhere                                       | Breaking change to every `handleMessage()`/`executeWorkflow()` caller       | Explicitly ruled out — non-breaking was a hard requirement |
| `ChannelReference` as an additive optional field (chosen)       | Non-breaking, minimal, reuses existing option-bag pattern | None significant                                                            | Solves the problem within stated constraints               |

---

## Scope

- **Package(s) likely affected:** `workflows` (type definition + substitution + env vars),
  `core` (re-export, `HandleMessageContext`, `handleMessage()`, `prompt-builder.ts`),
  `adapters` (Telegram: one-line `chat.title` addition), `server` (adapter wiring in
  `index.ts` + `routes/api.ts`), `cli` (`chat.ts`).
- **Breaking change?** `No` — `channelRef` is optional everywhere; every existing caller
  keeps compiling and behaving identically.
- **Database changes needed?** `No` — transient, not persisted as a `conversations` column.
  Optionally recorded into the existing `workflow_runs.metadata` JSONB blob (additive by
  construction, no migration).
- **New external dependencies?** `No`.

---

## Security Considerations

- **New permissions/capabilities?** `No`.
- **New external network calls?** `No` — v1 only uses data already present on the inbound
  event; Slack's `conversations.info` lookup is explicitly deferred to a follow-up issue.
- **Secrets/tokens handling?** `No` — `channelId`/`channelName` are not sensitive; same
  visibility class as `conversationId`, which is already logged today.

---

## Implementation Plan

### Phase 1: Define the type

- [x] Add `ChannelReference` to `packages/workflows/src/deps.ts`
- [x] Re-export from `packages/core/src/types/index.ts`

### Phase 2: Thread through the orchestrator

- [x] Add `channelRef?: ChannelReference` to `HandleMessageContext`
- [x] Add `channelRef?: ChannelReference` to `ExecuteWorkflowOptions`
- [x] `handleMessage()`: add `adapter`/`channelId`/`channelName` to structured logs
- [x] `handleMessage()`: spread `channelRef` into all `executeWorkflow()` call sites — this
      turned out to reach further than the original plan: `dispatchOrchestratorWorkflow()`,
      `handleStreamMode()`/`handleBatchMode()`, `handleWorkflowInvocationResult()`, and
      `handleWorkflowRunCommand()` are separate functions (not all inline in `handleMessage`)
      and each needed `channelRef` threaded through as its own parameter
- [x] `prompt-builder.ts`: add `buildChannelReferenceSection()`, appended unconditionally
      when `channelRef` is present (direct-chat path only)

### Phase 3: Thread through workflows

- [x] `executor-shared.ts`: `$ADAPTER` / `$CHANNEL_ID` / `$CHANNEL_NAME` substitution
      (fail-open — empty string when absent, skipped under `shellSafe` like `$USER_MESSAGE`)
- [x] `dag-executor.ts`: `ADAPTER` / `CHANNEL_ID` / `CHANNEL_NAME` env vars (bare, no
      `ARCHON_` prefix — matches existing convention) for `bash:`/`script:` nodes
- [x] Recorded `channelRef` on `WorkflowRun.metadata` as `channel_ref`

### Phase 4: Adapter wiring

- [x] Discord (`server/src/index.ts`): construct from `message.channelId` / `message.channel?.name`
- [x] Slack (`server/src/index.ts`): construct from `event.channel` (no name in v1)
- [x] Telegram: adapter emits `chat.title` in its `onMessage` payload; wiring constructs `channelRef`
- [x] GitHub / GitLab / Gitea: construct `{ adapter, channelId: `${owner}/${repo}` }` in each forge adapter
- [x] Web (`server/src/routes/api.ts`): construct from `conversationId`
- [x] CLI (`cli/src/commands/chat.ts`): construct from `conversationId`

### Phase 5: Tests + docs

- [x] Full-repo type-check, lint, and test suite all green (one pre-existing, unrelated
      Windows symlink-permission test failure confirmed present on the clean baseline too)
- [x] Integration coverage via the existing `dag-executor.test.ts`/`executor.test.ts` suites
      (no new dedicated unit tests added for the substitution/env-var/prompt-section
      additions specifically — flagged as a gap, see Notes)
- [x] Update the variable-substitution reference doc with `$ADAPTER`/`$CHANNEL_ID`/`$CHANNEL_NAME`
      (`packages/docs-web/src/content/docs/reference/variables.md`, plus `CLAUDE.md`'s own
      Variable Substitution list)

---

## Definition of Done

- [x] `ChannelReference` defined in `@archon/workflows`, re-exported from `@archon/core`
- [x] `HandleMessageContext` and `ExecuteWorkflowOptions` both carry the optional field
- [x] All adapters (Slack, Telegram, Discord, GitHub, GitLab, Gitea, Web, CLI) construct it
      at their wiring point
- [x] Structured logs, the direct-chat system prompt, workflow `$` variables, and
      `bash:`/`script:` env vars all surface it
- [x] No existing test needed to change to keep passing (purely additive) — true in the end,
      but only after fixing a positional-argument regression the first implementation pass
      introduced in `dag-executor.ts` (see Notes)
- [x] Docs: variable-substitution reference updated

---

## Related Issues

- Follow-up: Slack channel-name resolution via `conversations.info` + adapter-owned cache
  (not in this issue's scope).

---

## Notes

- This is foundational infrastructure, not a user-facing feature on its own.
- Zero behavior change for anyone who doesn't read the new field.
- Implementation gap: no NEW dedicated unit tests were added for the `$ADAPTER`/
  `$CHANNEL_ID`/`$CHANNEL_NAME` substitution, the `ADAPTER`/`CHANNEL_ID`/`CHANNEL_NAME` env
  vars, `buildChannelReferenceSection()`, or each adapter's `ChannelReference` construction —
  the full existing suite passes (proving no regression), but there's no test asserting the
  new behavior itself. Worth a follow-up pass before considering this fully done per the
  original Testing Plan.
- Process note from implementation: the first pass at threading `channelRef` through
  `dag-executor.ts` inserted the new parameter in the MIDDLE of several functions' positional
  argument lists (after `issueContext`). That type-checked cleanly (internal call sites were
  updated correctly) but broke ~35 tests in `dag-executor.test.ts` that call those functions
  positionally with the pre-existing argument order — trailing arguments silently landed in
  the wrong parameter slots at runtime, not a compile error. Fixed by repositioning
  `channelRef` to the true last parameter of each affected function instead, which required
  no test-file changes. Take-away for future work in this file: prefer trailing parameter
  position over "next to the semantically related field" when a function is called
  positionally from tests.
- The stale earlier draft of this PRD/issue proposed a _required_ `channelRef` (breaking
  change) and referenced file paths that don't exist in this repo — superseded by this
  version.
