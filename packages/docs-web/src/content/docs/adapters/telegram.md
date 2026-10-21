---
title: Telegram
description: Connect Archon to Telegram using the Bot API for mobile and desktop access.
category: adapters
area: adapters
audience: [user, operator]
status: current
sidebar:
  order: 3
---

Connect Archon to Telegram so you can interact with your AI coding assistant from any Telegram client.

:::caution[Deprecated]
The Telegram adapter is deprecated and will be removed in the next minor release, 0.13.0. No Archon maintainer owns it. It keeps working until then, and the server logs a deprecation notice when it starts the adapter. If you need Telegram after that, build and own it as a [chat plugin](/guides/publishing-plugins/#chat-plugins). [#4641](https://github.com/coleam00/Archon/issues/4641) tracks the removal.
:::

New identities are created as members. The operator can designate admins with [`archon user role <id> admin`](/reference/security/#users-and-roles); only a run's starter or an admin can act on it. See [Who can act on a run](/reference/security/#who-can-act-on-a-run).

## Prerequisites

- Archon server running (`archon serve`; see [Web UI](/adapters/web/))
- A Telegram account

## Create Telegram Bot

1. Message [@BotFather](https://t.me/BotFather) on Telegram
2. Send `/newbot` and follow the prompts
3. Copy the bot token (format: `123456789:ABCdefGHIjklMNOpqrsTUVwxyz`)

## Set Environment Variable

```ini
TELEGRAM_BOT_TOKEN=123456789:ABCdefGHI...
```

## Configure User Whitelist (Optional)

To restrict bot access to specific users:
1. Message [@userinfobot](https://t.me/userinfobot) on Telegram to get your user ID
2. Add to environment:

```ini
TELEGRAM_ALLOWED_USER_IDS=123456789,987654321
```

When set, only listed user IDs can interact with the bot. When empty/unset, the bot responds to all users.

## Configure Streaming Mode (Optional)

```ini
TELEGRAM_STREAMING_MODE=stream  # stream (default) | batch
```

For streaming mode details, see [Configuration](/getting-started/configuration/).

## Project selection

Select a registered project by submitting `/setproject <name>` in the conversation or thread where you want to work. To register a local directory first, submit `/register-project [--folder] <name> <path>`, then select it; registration alone does not bind the conversation. Projectless questions still work. Selection applies to that conversation, not every channel.

Once scoped, the assistant launches and manages runs through its native tools (Claude, Codex, Pi) or the existing CLI (Copilot/OpenCode). CLI launches are detached and headless, use CLI identity and return a run ID for inspection; they do not deliver progress or results to the originating chat. See [Deprecated providers](/getting-started/ai-assistants/#deprecated-providers).

## Further Reading

- [Configuration](/getting-started/configuration/)
