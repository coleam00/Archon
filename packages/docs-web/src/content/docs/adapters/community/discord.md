---
title: Discord
description: Connect Archon to Discord for AI coding assistance in servers and DMs.
category: adapters
area: adapters
audience: [user, operator]
status: current
sidebar:
  order: 5
---

:::note
Discord is a **community adapter** — contributed and maintained by the community.
:::

Connect Archon to Discord so you can interact with your AI coding assistant from any Discord server or DM.

## Prerequisites

- Archon server running (see [Getting Started](/getting-started/))
- A Discord account
- "Manage Server" permission on the Discord server you want to add the bot to

## Create Discord Bot

1. Visit [Discord Developer Portal](https://discord.com/developers/applications)
2. Click "New Application" > Enter a name > Click "Create"
3. Go to the "Bot" tab in the left sidebar
4. Click "Add Bot" > Confirm

## Get Bot Token

1. Under the Bot tab, click "Reset Token"
2. Copy the token (starts with a long alphanumeric string)
3. **Save it securely** -- you won't be able to see it again

## Enable Message Content Intent (Required)

1. Scroll down to "Privileged Gateway Intents"
2. Enable **"Message Content Intent"** (required for the bot to read messages)
3. Save changes

:::caution
Skipping this step causes Discord to reject the bot's connection with
`Used disallowed intents`. Archon will log
`discord.start_failed_continuing_without_adapter` and keep the rest of
the server running, but the Discord adapter will be unavailable until
the intent is enabled and the server is restarted.
:::

## Invite Bot to Your Server

1. Go to "OAuth2" > "URL Generator" in the left sidebar
2. Under "Scopes", select:
   - `bot`
3. Under "Bot Permissions", select:
   - Send Messages
   - Read Message History
   - Create Public Threads (optional, for thread support)
   - Send Messages in Threads (optional, for thread support)
4. Copy the generated URL at the bottom
5. Paste it in your browser and select your server
6. Click "Authorize"

**Note:** You need "Manage Server" permission to add bots.

## Set Environment Variable

```ini
DISCORD_BOT_TOKEN=your_bot_token_here
```

## Configure User Whitelist (Optional)

To restrict bot access to specific users, enable Developer Mode in Discord:
1. User Settings > Advanced > Enable "Developer Mode"
2. Right-click on users > "Copy User ID"
3. Add to environment:

```ini
DISCORD_ALLOWED_USER_IDS=123456789012345678,987654321098765432
```

## Configure Streaming Mode (Optional)

```ini
DISCORD_STREAMING_MODE=batch  # batch (default) | stream
```

For streaming mode details, see [Configuration](/getting-started/configuration/).

## Usage

The bot responds to:
- **Direct Messages**: Just send messages directly
- **Server Channels**: @mention the bot (e.g., `@YourBotName help me with this code`)
- **Threads**: Bot maintains context in thread conversations

## Further Reading

- [Configuration](/getting-started/configuration/)
