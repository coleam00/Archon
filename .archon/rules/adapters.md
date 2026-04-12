---
paths:
  - "packages/adapters/**/*.ts"
---

# Adapters Conventions

## Key Patterns

- **Auth is inside adapters** — every adapter checks authorization before calling `onMessage()`. Silent rejection (no error response), log with masked user ID: `userId.slice(0, 4) + '***'`.
- **Whitelist parsing in constructor** — parse env var (`SLACK_ALLOWED_USER_IDS`, `TELEGRAM_ALLOWED_USER_IDS`, `GITHUB_ALLOWED_USERS`) using a co-located `parseAllowedUserIds()` / `parseAllowedUsers()` function. Empty list = open access.
- **Lazy logger pattern** — ALL adapter files use a module-level `cachedLog` + `getLog()` getter so test mocks intercept `createLogger` before the logger is instantiated. Never initialize logger at module scope.
- **Two handler patterns** (both valid):
  - **Chat adapters** (Slack, Telegram, Discord): `onMessage(handler)` — adapter owns the event loop (polling/WebSocket), fires registered callback. Lock manager lives in the server's callback closure. Errors handled by caller via `createMessageErrorHandler`.
  - **Forge adapters** (GitHub, Gitea): `handleWebhook(payload, signature)` — server HTTP route calls directly, returns 200 immediately. Full pipeline inside adapter (signature verification, repo cloning, command loading, context building). Lock manager injected in constructor. Errors caught internally and posted to issue/PR.
- **Message splitting** — use shared `splitIntoParagraphChunks(message, maxLength)` from `../../utils/message-splitting`. Two-pass: paragraph breaks first, then line breaks. Limits: Slack 12000, Telegram 4096, GitHub 65000.
- **`ensureThread()` is often a no-op** — Slack returns the same ID (already encoded as `channel:ts`), Telegram has no threads, GitHub issues are inherently threaded.

## Conversation ID Formats

| Platform | Format | Example |
|----------|--------|---------|
| Slack | `channel:thread_ts` | `C123ABC:1234567890.123456` |
| Telegram | numeric chat ID as string | `"1234567890"` |
| GitHub | `owner/repo#number` | `"acme/api#42"` |
| Web | user-provided string | `"my-chat"` |
| Discord | channel ID string | `"987654321098765432"` |

## Architecture

- All chat adapters implement `IPlatformAdapter` from `@archon/core`
- GitHub adapter is webhook-based (no polling); Slack/Telegram/Discord use polling
- GitHub adapter holds its own `ConversationLockManager` (injected in constructor)
- Slack conversation ID encodes both channel and thread: `sendMessage()` splits on `:` to extract `thread_ts`
- GitHub adapter adds `<!-- archon-bot-response -->` marker to prevent self-triggering loops
- GitHub only responds to `issue_comment.created` events — NOT `issues.opened` / `pull_request.opened` (descriptions contain documentation, not commands; see #96)

## Anti-patterns

- Never put auth logic outside the adapter (no auth middleware in server routes)
- Never throw from `onMessage` handlers; errors surface to the caller
- Never call `sendMessage()` with a raw token or credential string in the message
- Never use the generic `exec` — always use `execFileAsync` for subprocess calls
- Never add a new adapter method to `IPlatformAdapter` unless ALL adapters need it; use optional methods (`sendStructuredEvent?`) for platform-specific capabilities
