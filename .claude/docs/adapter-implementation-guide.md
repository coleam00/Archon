# Adapter Implementation Guide

> **Purpose**: Complete reference for understanding and building platform adapters in Archon.
> **When to use**: Building a new adapter, debugging adapter behavior, understanding cross-platform message flow.
> **Size**: ~400 lines — use a scout sub-agent to check relevance before loading.

---

## The Interface: `IPlatformAdapter`

Defined at `packages/core/src/types/index.ts:106-151`.

| Method | Signature | Required |
|--------|-----------|----------|
| `sendMessage` | `(conversationId: string, message: string, metadata?: MessageMetadata): Promise<void>` | Yes |
| `ensureThread` | `(originalConversationId: string, messageContext?: unknown): Promise<string>` | Yes |
| `getStreamingMode` | `(): 'stream' \| 'batch'` | Yes |
| `getPlatformType` | `(): string` | Yes |
| `start` | `(): Promise<void>` | Yes |
| `stop` | `(): void` | Yes |
| `sendStructuredEvent` | `(conversationId: string, event: MessageChunk): Promise<void>` | Optional |
| `emitRetract` | `(conversationId: string): Promise<void>` | Optional |

`IWebPlatformAdapter` (line 158) extends this with web-only methods: `sendStructuredEvent` (required), `setConversationDbId`, `setupEventBridge`, `emitLockEvent`, `registerOutputCallback`, `removeOutputCallback`. Type guard: `isWebAdapter()` checks `getPlatformType() === 'web'`.

---

## Common Template (All Adapters Share)

### 1. Lazy Logger Pattern

Every adapter file uses this at module scope:

```typescript
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('adapter.<name>');
  return cachedLog;
}
```

Never initialize the logger at module scope — test mocks must intercept `createLogger` before first use.

### 2. Auth: Constructor Whitelist + Silent Rejection

Every adapter reads its env var in the constructor and stores the parsed whitelist:

| Adapter | Env Var | ID Type | Auth File |
|---------|---------|---------|-----------|
| Slack | `SLACK_ALLOWED_USER_IDS` | `string[]` (regex `/^[UW][A-Z0-9]+$/`) | `chat/slack/auth.ts` |
| Telegram | `TELEGRAM_ALLOWED_USER_IDS` | `number[]` (positive integers) | `chat/telegram/auth.ts` |
| GitHub | `GITHUB_ALLOWED_USERS` | `string[]` (lowercase normalized) | `forge/github/auth.ts` |
| Discord | `DISCORD_ALLOWED_USER_IDS` | `string[]` (numeric snowflakes) | `community/chat/discord/auth.ts` |

Each auth module exports `parseAllowedXxx(envValue)` and `isXxxAuthorized(userId, allowedIds)`. Empty whitelist = open access. On failure: log with `userId.slice(0, 4) + '***'` masking, then `return` silently (no error sent to user).

### 3. Message Handler Registration

```typescript
// In adapter class
onMessage(handler: MessageHandler): void {
  this.messageHandler = handler;
}

// In start() — fire-and-forget
void this.messageHandler(event);
```

### 4. Message Splitting

All adapters use `splitIntoParagraphChunks(message, maxLength)` from `packages/adapters/src/utils/message-splitting.ts`:

| Platform | Limit | Buffer | Effective Split At |
|----------|-------|--------|-------------------|
| Slack | 12,000 | 500 | 11,500 |
| Telegram | 4,096 | 200 | 3,896 |
| GitHub | 65,000 | 500 | 64,500 |
| Discord | 2,000 | 100 | 1,900 |

Two-pass algorithm: split on `\n\n+` first, then `\n` for oversized paragraphs.

### 5. `ensureThread()` is Usually a No-op

Only Discord creates real threads. Slack's `channel:ts` format already ensures threading. Telegram and GitHub have no thread concept (or use inherent threading).

---

## Per-Adapter Deep Dive

### Slack (`SlackAdapter`)

**File:** `packages/adapters/src/chat/slack/adapter.ts`

**Receiving:** Socket Mode (WebSocket) via `@slack/bolt`. Handles two events:
- `app_mention` (line 246): bot is `@mentioned` in a channel
- `message` (line 269): DMs only (`channel_type === 'im'`), skips bot messages via `bot_id` check

**Conversation ID:** `channel:thread_ts` or `channel:ts`. The `getConversationId()` function (line 190) encodes both channel and thread into a single string. `sendMessage()` splits on `:` to extract the parts for `chat.postMessage`.

**Sending:** Uses `sendWithMarkdownBlock()` which posts via `app.client.chat.postMessage` with a `markdown` block type. Falls back to plain text on error.

**Streaming mode:** `'batch'` by default, overridden via `SLACK_STREAMING_MODE`.

**Unique:**
- `stripBotMention(text)` strips `<@USERID>` prefixes and normalizes Slack `<url|label>` format
- `fetchThreadHistory(event)` fetches up to 100 replies via `conversations.replies`

---

### Telegram (`TelegramAdapter`)

**File:** `packages/adapters/src/chat/telegram/adapter.ts`

**Receiving:** Long polling via Telegraf `bot.launch()`. Constructor sets `handlerTimeout: Infinity` (line 31) to avoid 90s timeout on long AI operations. Launches with `dropPendingUpdates: true` to discard offline messages.

**Conversation ID:** Numeric chat ID as string (`ctx.chat.id.toString()`).

**Sending:** Two-stage markdown: converts to MarkdownV2 via `convertToTelegramMarkdown()`, sends with `parse_mode: 'MarkdownV2'`, falls back to `stripMarkdown()` on rejection. Helper functions in `chat/telegram/markdown.ts`.

**Streaming mode:** `'stream'` by default, overridden via `TELEGRAM_STREAMING_MODE`.

**Unique:**
- Auth IDs are `number[]` (Telegram user IDs are numeric)
- `handlerTimeout: Infinity` for long-running AI operations
- `dropPendingUpdates: true` on launch

---

### GitHub (`GitHubAdapter`)

**File:** `packages/adapters/src/forge/github/adapter.ts`

**Receiving:** Webhooks. `start()` is a no-op. Server registers `POST /webhooks/github` which calls `handleWebhook(payload, signature)`. Fire-and-forget (returns 200 immediately).

**Webhook processing flow (`handleWebhook()`, line 677):**
1. HMAC-SHA256 signature verification via `timingSafeEqual`
2. Auth check against `GITHUB_ALLOWED_USERS` (username from `event.sender.login`)
3. `parseEvent()` extracts fields — **only handles `issue_comment.created`, `issues.closed`, `pull_request.closed`** — NOT `issues.opened` or `pull_request.opened` (descriptions contain docs, not commands; see #96)
4. Self-loop prevention: ignores comments containing `<!-- archon-bot-response -->`
5. Bot mention check via `hasMention()`
6. `getOrCreateCodebaseForRepo()` upserts codebase record
7. `ensureRepoReady()` clones (new) or syncs (existing) the repository
8. Builds `IsolationHints` for PR/issue workflows

**Conversation ID:** `owner/repo#number` (e.g., `acme/api#42`).

**Sending:** `octokit.rest.issues.createComment` with retry logic (3 attempts, exponential backoff). Appends `<!-- archon-bot-response -->` marker to every comment.

**Streaming mode:** Always `'batch'` (hardcoded).

**Unique:**
- Only adapter with its own `ConversationLockManager` (injected in constructor)
- Only adapter that calls `handleMessage()` directly (not via server.ts)
- Has `ensureRepoReady()` for on-demand repo clone/sync
- Builds `IsolationHints` with PR branch, SHA, fork detection

---

### Discord (`DiscordAdapter`)

**File:** `packages/adapters/src/community/chat/discord/adapter.ts`

**Receiving:** discord.js WebSocket via `client.login()`. Gateway intents: `Guilds`, `GuildMessages`, `MessageContent`, `DirectMessages`. `Partials.Channel` required for DM support. Registers `Events.MessageCreate` listener in `start()`.

**Conversation ID:** Channel ID string (Discord snowflake). Thread messages use the thread's own channel ID, so each thread is a separate conversation automatically.

**`ensureThread()` — The only adapter with real implementation (line 195):**
1. If already in a thread → return thread's `channelId`
2. If in a DM → no threading, return unchanged
3. Deduplication: checks `this.pendingThreads` map to prevent double creation
4. Creates thread via `message.startThread()` with `autoArchiveDuration: OneDay`
5. Thread name: first 97 chars of message content, fallback `'Bot Response'`

**Streaming mode:** `'stream'` by default, overridden via `DISCORD_STREAMING_MODE`.

**Unique:**
- Real thread creation with deduplication map
- `isBotMentioned(message)` checks `message.mentions.has(botUser)`
- 2,000-char message limit (smallest of all platforms)

---

### Web (`WebAdapter`)

**File:** `packages/server/src/adapters/web.ts`

**Receiving:** None — purely output-driven. Messages arrive via REST API (`POST /api/conversations/:id/message`). The adapter's job is SSE streaming + message persistence.

**Architecture:** Facade over three injected components:
- `SSETransport` (`web/transport.ts`): manages `Map<string, SSEWriter>` of active connections
- `MessagePersistence` (`web/persistence.ts`): buffers text + tool calls, flushes to DB
- `WorkflowEventBridge` (`web/workflow-bridge.ts`): forwards workflow events from workers to parent SSE

**`sendMessage()` (line 44):**
1. Calls `persistence.appendText()` first (always buffer for DB)
2. Skips SSE for `tool_call_formatted` and `isolation_context` categories
3. Emits `{ type: 'text', content, isComplete: true }` via `SSETransport.emit()`
4. Forces immediate `persistence.flush()` for `workflow_result` category

**`sendStructuredEvent()` (line 81):** Handles `'tool'`, `'result'` (session info), `'workflow_dispatch'` message chunks.

**`emitRetract()` (line 212):** Removes last buffered segment from persistence, emits `{ type: 'retract' }` over SSE.

**Streaming mode:** Always `'stream'` (hardcoded).

**Unique:**
- No auth (single-developer tool on local machine)
- No polling/WebSocket — output-only
- Message persistence layer (other adapters don't persist)
- `emitLockEvent()` for UI lock indicators
- `setupEventBridge()` for workflow worker → parent SSE forwarding
- `SSETransport.scheduleCleanup()` with `RECONNECT_GRACE_MS = 5000ms`

---

## How Adapters Are Registered (`server/src/index.ts`)

```
1. Check env var: Boolean(process.env.XYZ_BOT_TOKEN)
2. Instantiate: new XyzAdapter(token, streamingMode)
3. Register handler: adapter.onMessage(async event => {
     conversationId = getConversationId(event)
     conversationId = await ensureThread(conversationId, event)
     history = await fetchThreadHistory(event)  // optional
     await lockManager.acquireLock(conversationId, async () => {
       await handleMessage(adapter, conversationId, content, context)
     })
   })
4. Start: await adapter.start()
```

GitHub is different — self-contained, handles its own lock acquisition internally.
Web is always enabled (not conditional on env vars).

---

## Building a New Adapter: Checklist

1. Create `packages/adapters/src/{category}/{platform}/adapter.ts`
2. Create `packages/adapters/src/{category}/{platform}/auth.ts` with `parseAllowedXxx()` + `isXxxAuthorized()`
3. Implement `IPlatformAdapter` — all 6 required methods
4. Use the lazy logger pattern (never module-scope init)
5. Parse auth whitelist in constructor from env var
6. Check auth in message handler before calling `onMessage` callback
7. Use `splitIntoParagraphChunks()` from `../../utils/message-splitting`
8. Register in `packages/server/src/index.ts` following the env-check → instantiate → onMessage → start pattern
9. Add the platform type string to any switch/if chains that check `getPlatformType()`
10. Export from `packages/adapters/src/index.ts`
