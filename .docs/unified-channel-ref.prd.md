# PRD: ChannelReference — Unified Adapter/Channel Identity

**Feature Name:** `ChannelReference`
**Status:** Proposed
**Target Release:** next minor
**Dependencies:** None (additive infrastructure)

---

## Executive Summary

Give the orchestrator and workflow engine a single, structured fact about every inbound
message: **which adapter it came from, which channel, and (when cheaply available) what
that channel is called.** Today this information exists only inside each adapter's private
encoding of `conversationId` — un-parseable generically and inconsistent per platform.

The change is a single new optional field, `channelRef`, added to the two option-bags that
already carry per-message metadata from adapter → orchestrator → workflow execution
(`HandleMessageContext` and `ExecuteWorkflowOptions`). No existing signature changes, no
DB schema changes, no adapter is required to populate it.

---

## Problem Statement

**Current state:**

`conversationId` means a different thing per adapter, and none of them is simply "the
channel":

| Adapter  | `conversationId`                                  | Distinct from the channel?                                                                              |
| -------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Slack    | `${event.channel}:${thread_ts ?? ts}` (composite) | Yes — channel is embedded but only recoverable by parsing Slack's private string format                 |
| Discord  | `message.channelId`                               | Yes, for threads — this is the **thread ID**; the parent channel is a separate value (`adapter.ts:182`) |
| Telegram | `ctx.chat.id`                                     | No — the chat _is_ the channel                                                                          |
| GitHub   | `${owner}/${repo}#${number}`                      | No direct channel concept — repo is the closest analog                                                  |
| Web      | user-provided string                              | No channel concept exists today                                                                         |

Consequences:

- Code that wants "which channel" today has no generic way to get it — it would have to
  special-case each adapter's private `conversationId` encoding, breaking encapsulation.
- Workflow authors have no way to write `$CHANNEL_ID`-based logic, or report back
  to the right destination generically.
- The chat agent itself has no awareness of which channel/adapter it's replying in.
- Structured logs pair `conversationId` with `platform`, but `conversationId` alone doesn't
  tell an operator "which Slack channel" without decoding it.

**Desired state:**

A single optional, adapter-populated fact — `{ adapter, channelId, channelName? }` — flows
through the same seam `issueContext` and `isolationHints` already use, reaching:

- the orchestrator's structured logs,
- the orchestrator's AI system prompt (direct chat is aware of its own channel),
- workflow `$` variable substitution and `bash:`/`script:` node env vars.

---

## Goals

1. **One consistent shape** across every adapter: `{ adapter, channelId, channelName? }`.
2. **Fully additive / non-breaking** — a new optional field on two existing types; every
   current call site keeps compiling and behaving identically if it doesn't populate it.
3. **Reaches the orchestrator (logging + AI prompt) and workflows** through the one seam,
   not parallel mechanisms.
4. **Every adapter constructs it explicitly** at its own wiring point — no generic
   derivation from `conversationId`, since (per the table above) that doesn't hold reliably
   across adapters.
5. **Minimal blast radius** — touches the existing adapter wiring call sites, the existing
   variable-substitution function, the existing env-var injection point, and one new small
   prompt-builder section. No new modules, no new abstraction layers.
6. **Extensible without a second breaking change** — v1 only populates `channelName` where
   it's already free on the inbound event; adapters that need an API round-trip (Slack) get
   a documented follow-up phase using the same field and an adapter-owned cache, mirroring
   the existing `SlackAdapter.triggeringMessages` in-memory `Map` precedent.

---

## Non-Goals (v1)

- **No DB persistence.** No new columns on `conversations`. `channelRef` is transient,
  reconstructed by the adapter wiring on every message (or read from an adapter's own
  in-memory cache) — not stored as a row.
- **No Slack channel-name lookup.** Resolving Slack's channel name needs a
  `conversations.info` API call (rate-limited, needs its own cache); v1 ships the shape,
  not the lookup. Tracked as a follow-up issue.
- **No new node type, no new YAML surface field.** `$ADAPTER`/`$CHANNEL_ID`/`$CHANNEL_NAME`
  are declarative substitution variables in the same family as `$WORKFLOW_ID`/`$BASE_BRANCH`
  — pure data, not computation, so they pass the Workflow Language Constitution's
  admissibility test.

---

## Design

### `ChannelReference` shape

```typescript
// packages/workflows/src/deps.ts — alongside WorkflowMessageMetadata / IWorkflowPlatform

/**
 * Identifies which adapter and channel a message originated from.
 * channelId is NOT always equal to conversationId — see per-adapter notes below.
 */
export interface ChannelReference {
  /** Registered adapter id — same value as IPlatformAdapter.getPlatformType() */
  adapter: string;
  /**
   * Adapter-specific channel identifier:
   *  - Slack: event.channel (conversationId is the composite `channel:threadTs`)
   *  - Discord: the channel ID (conversationId is the THREAD id for threaded messages)
   *  - Telegram: same as conversationId (chat.id) — the chat IS the channel
   *  - GitHub/GitLab/Gitea: `owner/repo` (conversationId adds `#number`)
   *  - Web/CLI: same as conversationId — no distinct channel concept today
   */
  channelId: string;
  /** Populated only when available without an extra network call (see caching below) */
  channelName?: string;
}
```

Defined once in `@archon/workflows` (which `@archon/core` already depends on — see
`executeWorkflow`/`hydrateResumableRun` imports in `orchestrator-agent.ts`), then re-exported
from `packages/core/src/types/index.ts` alongside the existing `WorkflowDefinition`/
`WorkflowRun` re-exports. `@archon/adapters` and `@archon/server` get it transitively via
`@archon/core/types` — no new cross-package dependency edges.

### Where it plugs into existing plumbing

- **`HandleMessageContext`** (`packages/core/src/types/index.ts`) gains
  `readonly channelRef?: ChannelReference`, next to `issueContext`/`isolationHints`.
- **`ExecuteWorkflowOptions`** (`packages/workflows/src/executor.ts`) gains
  `channelRef?: ChannelReference`, following the exact pattern `issueContext` already uses.
- **`handleMessage()`** (`packages/core/src/orchestrator/orchestrator-agent.ts`) destructures
  it from `context` and:
  - adds `adapter` / `channelId` / `channelName` fields next to `conversationId` in the
    existing structured logs (`orchestrator_message_received` and friends);
  - spreads it into the options object at all `executeWorkflow()` call sites in that file
    (same treatment `codebaseId`/`userId`/`source` already get — three call sites today);
  - for **direct chat** (no workflow invoked), appends a new system-prompt section — see
    below.
- **AI system prompt** (`packages/core/src/orchestrator/prompt-builder.ts`): a new
  `buildChannelReferenceSection(ref: ChannelReference): string` function, appended in
  `handleMessage()` right after `buildOrchestratorSystemAppend()` is built
  (`orchestrator-agent.ts:1661`), **unconditionally whenever `channelRef` is present** —
  unlike `buildRunManagementSection()`, this is not gated behind provider capability or
  project scope, since it's a one-line informational fact any provider can consume:
  ```ts
  let systemAppend = buildOrchestratorSystemAppend(conversation, codebases, workflows);
  if (channelRef) {
    systemAppend += `\n\n${buildChannelReferenceSection(channelRef)}`;
  }
  ```
  Content sketch: `## Message Origin\n\nYou are replying via **${adapter}**${channelName ? ` in "${channelName}"` : ''} (channel: \`${channelId}\`).` Stable per conversation → safe under prompt caching (recomputed each call, byte-identical content, matches the existing cacheable-append pattern).
- **`executeWorkflow` / `executeDagWorkflow`** (`@archon/workflows`) thread it the same way
  `issueContext` becomes `$ISSUE_CONTEXT`:
  - new substitution variables `$ADAPTER`, `$CHANNEL_ID`, `$CHANNEL_NAME` in the prompt
    substitution function (`executor-shared.ts`) — **fail-open** (substitute empty string
    when absent), matching `$DOCS_DIR`'s behavior, not `$BASE_BRANCH`'s fail-fast, since most
    workflows will never reference these;
  - new env vars `ADAPTER`, `CHANNEL_ID`, `CHANNEL_NAME` (bare, no `ARCHON_` prefix — matches
    the existing convention every other engine-provided env var already uses, e.g.
    `BASE_BRANCH`, `CONTEXT`, `ISSUE_CONTEXT`) injected into `bash:`/`script:` node subprocess
    env at each node-type executor's existing env-object construction in `dag-executor.ts`.
  - optionally recorded into `WorkflowRun.metadata` (JSONB, additive by construction — no
    schema change) the same way `issueContext`/`isolationContext` already are, so a run's
    audit trail shows where it was triggered from without a DB migration.

### Adapter touch points

Every adapter constructs `ChannelReference` explicitly, at its own wiring point — mostly in
`packages/server/src/index.ts`, where Discord/Slack/Telegram's `onMessage` callbacks are
wired to call `handleMessage()`:

| Adapter        | Call site                                                             | `ChannelReference` construction                                                            | Extra cost                                                                                                                                                                                                    |
| -------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Discord        | `index.ts:527-579`                                                    | `{ adapter: 'discord', channelId: message.channelId, channelName: message.channel?.name }` | None — discord.js already resolves `.channel` from its own cache                                                                                                                                              |
| Slack          | `index.ts:616-656`                                                    | `{ adapter: 'slack', channelId: event.channel }`                                           | `channelName` omitted in v1                                                                                                                                                                                   |
| Telegram       | `index.ts:935-950`                                                    | `{ adapter: 'telegram', channelId: conversationId, channelName: chatTitle }`               | Requires a **one-line addition** to `TelegramAdapter.onMessage`'s emitted payload (`packages/adapters/src/chat/telegram/adapter.ts`) to also pass `ctx.chat.title` — already read off `ctx`, zero extra calls |
| GitHub         | own webhook handler (`packages/adapters/src/forge/github/adapter.ts`) | `{ adapter: 'github', channelId: `${owner}/${repo}` }`                                     | None                                                                                                                                                                                                          |
| GitLab / Gitea | own webhook handlers (`community/forge/*`)                            | Same pattern as GitHub                                                                     | None                                                                                                                                                                                                          |
| Web            | `packages/server/src/routes/api.ts` `dispatchToOrchestrator()`        | `{ adapter: 'web', channelId: conversationId }`                                            | None                                                                                                                                                                                                          |
| CLI            | `packages/cli/src/commands/chat.ts`                                   | `{ adapter: 'cli', channelId: conversationId }`                                            | None — kept for `$ADAPTER` symmetry outside chat platforms                                                                                                                                                    |

### Caching (for the Slack follow-up phase)

Not built in v1 (no adapter needs it yet). When Slack's name lookup is added, the adapter
owns a private in-memory `Map<channelId, channelName>` — the same shape as the existing
`SlackAdapter.triggeringMessages` map (`packages/adapters/src/chat/slack/adapter.ts:46`).
Documented here so the follow-up issue has a stated extension point rather than inventing
a new caching pattern.

---

## Testing Plan

### Unit Tests

- `$ADAPTER`/`$CHANNEL_ID`/`$CHANNEL_NAME` substitution — present when `channelRef` is set,
  empty string when absent (mirrors existing `$DOCS_DIR` tests in `executor-shared.test.ts`).
- `ADAPTER`/`CHANNEL_ID`/`CHANNEL_NAME` env vars injected into `bash:`/`script:` node
  subprocess env (mirrors existing managed-env-var tests in `dag-executor.test.ts`).
- `buildChannelReferenceSection()` renders correctly with and without `channelName`.
- Each adapter wiring constructs the documented `ChannelReference` shape (table above).
- `TelegramAdapter.onMessage` emits `chatTitle` in its payload.

### Integration Tests

- A message from each adapter flows through `handleMessage()` → structured log includes
  `adapter`/`channelId`/`channelName` fields.
- Direct chat (no workflow) system prompt includes the `## Message Origin` section when
  `channelRef` is present.
- A workflow run triggered from each adapter records `channelRef` in
  `workflow_runs.metadata`, and a `script:` node can read `CHANNEL_ID` from its env.

### Manual Tests

- Send a message in a Slack channel, a Discord channel, a Telegram group, a GitHub issue
  comment, and via the Web UI → verify logs show the correct `adapter`/`channelId` (and
  `channelName` for Discord/Telegram) for each.
- Ask the chat agent directly "what channel are you replying in?" on Discord/Telegram and
  confirm it can answer from the system prompt.
- Run a workflow with a `script:` node that echoes `$CHANNEL_ID` from each surface.

---

## Backward Compatibility

- ✅ `channelRef` is optional everywhere it's added — no existing call site is required to
  change to keep compiling.
- ✅ Omitting it produces byte-for-byte today's behavior: empty-string variable
  substitution, no new env vars set, no new log fields, no system-prompt section added,
  nothing new in `workflow_runs.metadata`.
- ✅ No DB schema changes — nothing to migrate, nothing to keep in parity across SQLite/Postgres.
- ✅ Adapters adopt it independently — Discord/Telegram/GitHub/Web/CLI can all ship in one
  PR, or Slack (name-lookup-less v1) can land ahead of the others, without coordination.

---

## Future Extensibility

- Slack channel-name resolution (follow-up issue): adapter-owned cache + `conversations.info`
  lookup, populating the same `channelName` field — no shape change needed.

```typescript
export interface ChannelReference {
  adapter: string;
  channelId: string;
  channelName?: string;
  // Future (if ever needed): workspaceId / parentChannelId for hierarchical platforms.
}
```

---

## Open Questions

1. Ship GitLab/Gitea forge adapters in the same PR as GitHub, or fast-follow? — **Recommend
   same PR**; it's the identical two-field construction as GitHub.
2. Should CLI populate `channelRef` given it has no real "channel"? — **Recommend yes**
   (`channelId: conversationId`), purely for `$ADAPTER` consistency across every surface.
3. Slack channel-name lookup — same epic or a separate follow-up issue? — **Recommend a
   separate follow-up issue**, referenced from this one, since it introduces a new
   rate-limited API call path this PRD deliberately excludes.
4. Exact wording of the `## Message Origin` system-prompt section — left as an
   implementation detail; keep it to one line so it doesn't compete with the routing rules
   for the model's attention.
