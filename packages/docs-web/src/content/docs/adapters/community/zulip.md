---
title: Zulip
description: Connect Archon to Zulip for AI coding assistance in streams and direct messages.
category: adapters
area: adapters
audience: [user, operator]
status: current
sidebar:
  order: 6
---

:::note
Zulip is a **community adapter** — contributed and maintained by the community.
:::

Connect Archon to Zulip so you can interact with your AI coding assistant from any Zulip stream or direct message. The adapter polls the Zulip event queue (long-polling), so no public webhook URL is required.

## Prerequisites

- Archon server running (see [Getting Started](/getting-started/overview/))
- A Zulip account with admin access (to create a bot)
- A Zulip server (self-hosted or Zulip Cloud at `zulipchat.com`)

## Create a Zulip Bot

1. Go to **Settings** → **Personal settings** → **Bots**
2. Click **Add a new bot**
3. Set **Bot type** to "Generic bot"
4. Fill in **Full name** (e.g. `Archon`) and **Username** (e.g. `archon-bot`)
5. Click **Create bot**

## Get Bot Credentials

After creating the bot:

1. Find your bot in the **Active bots** list
2. Click the download icon (⬇) to download `zuliprc`
3. Note the values for `email`, `key`, and `site` — these map to the env vars below

## Subscribe Bot to Streams

For the bot to receive messages in a stream, add it as a subscriber to that stream (stream settings → **Add subscribers** → the bot's email address). The bot will also receive direct messages without further setup.

## Environment Variables

All six `ZULIP_*` variables are documented in `.env.example`. Three are **required**, three are **optional**:

| Variable | Required | Description |
|----------|----------|-------------|
| `ZULIP_URL` | **Yes** | Your Zulip realm URL (e.g. `https://your-org.zulipchat.com`). Same as the `site` field in `zuliprc`. |
| `ZULIP_BOT_EMAIL` | **Yes** | The bot's email (e.g. `archon-bot@your-org.zulipchat.com`). Same as `email` in `zuliprc`. |
| `ZULIP_BOT_API_KEY` | **Yes** | The bot's API key (`key` in `zuliprc`). |
| `ZULIP_BOT_FULL_NAME` | No (but **recommended**) | The bot's display name — required for `@**Bot Name**` mention detection in streams. Without it, the bot still replies to direct messages but cannot detect @mentions. |
| `ZULIP_ALLOWED_USER_IDS` | No | Comma-separated numeric Zulip user IDs allowed to interact with the bot. **Unset (or empty) → open access**; set → only listed users are answered. A set-but-malformed value (e.g. non-numeric or all-invalid tokens) is a misconfiguration and the bot will **fail to start** — fail-closed, not fail-open. |
| `ZULIP_STREAMING_MODE` | No | `batch` (default) — the bot edits a "thinking…" status message and posts the full answer once ready. `stream` is accepted but currently has **no runtime effect** in the Zulip adapter (it behaves like `batch`); progressive token streaming is a future addition. See [Configuration → Streaming Modes](/getting-started/configuration/) for the cross-platform overview. |

Example:

```ini
ZULIP_URL=https://your-org.zulipchat.com
ZULIP_BOT_EMAIL=archon-bot@your-org.zulipchat.com
ZULIP_BOT_API_KEY=your_api_key_here
ZULIP_BOT_FULL_NAME=Archon
# ZULIP_ALLOWED_USER_IDS=12345,67890
# ZULIP_STREAMING_MODE=batch
```

## Usage

The bot responds to:

- **Stream messages** when @mentioned: `@**Archon** help me with this code`. The reply lands in the same stream + topic.
- **Direct messages** sent to the bot — replies go back as DMs.

A stream + topic pair (or the set of DM recipients) is treated as one conversation. While the bot is "thinking", it edits a `Starting thinking…` status message so you get immediate visual feedback; it switches to `Done thinking.` (or `Done thinking (FAILED).`) when the reply lands.

If you edit your message to *add* the @mention (you forgot it first time), the bot picks that up via Zulip's `update_message` event and replies as if the mention had been there originally.

## Reliability Notes

- **Backfill on restart:** when the server restarts (e.g. crash, deploy), the adapter fetches unread @mentions + unread DMs through the Zulip API and answers them oldest-first. If that fetch fails, the cycle is aborted (logged as `zulip.backfill_aborted`) and the messages stay `unread` so the next restart retries — they are never silently lost.
- **Reply correspondence:** each inbound message is marked read only **once its own reply has posted**. If the server crashes between two queued replies, the unanswered one stays unread for the next boot to retry.
- **Queue recovery:** if the long-poll queue expires (e.g. extended inactivity), the adapter re-registers with the same event types as startup so edited-message mention pickup survives the recovery.

## Further Reading

- [Configuration → Streaming Modes](/getting-started/configuration/)
- [Archon Adapters Overview](/adapters/)
