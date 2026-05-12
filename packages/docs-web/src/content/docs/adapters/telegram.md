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

## Prerequisites

- Archon server running (see [Getting Started](/getting-started/))
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

## Further Reading

- [Configuration](/getting-started/configuration/)
