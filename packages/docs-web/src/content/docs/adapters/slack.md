---
title: Slack
description: Connect Archon to Slack using Socket Mode -- works behind firewalls with no public URL needed.
category: adapters
area: adapters
audience: [user, operator]
status: current
sidebar:
  order: 2
---

Connect Archon to Slack so you can interact with your AI coding assistant from any Slack workspace.

## Prerequisites

- Archon server running (see [Getting Started](/getting-started/overview/))
- A Slack workspace where you have permission to install apps

## Overview

Archon uses **Socket Mode** for Slack integration, which means:

- No public HTTP endpoints needed
- Works behind firewalls
- Simpler local development
- Not suitable for Slack App Directory (fine for personal/team use)

## Step 1: Create a Slack App

1. Go to [Slack API Apps](https://api.slack.com/apps)
2. Log in if prompted
3. Choose the workspace for your app
4. Click **Create New App**
5. Choose **From scratch**
6. Enter:
   - **App Name**: Any name (this is what you will use to @mention the bot)
   - **Workspace**: Select your workspace
7. Click **Create App**

## Step 2: Enable Socket Mode

1. In the left sidebar, click **Socket Mode**
2. Toggle **Enable Socket Mode** to ON
3. When prompted, create an App-Level Token:
   - **Token Name**: `socket-mode`
   - **Scopes**: Add `connections:write`
   - Click **Generate**
4. **Copy the token** (starts with `xapp-`) -- this is your `SLACK_APP_TOKEN`
5. Copy the token and put it in your `.env` file

## Step 3: Configure Bot Scopes

1. In the left sidebar, click **OAuth & Permissions**
2. Scroll down to **Scopes** > **Bot Token Scopes**
3. Add these scopes to bot token scopes:
   - `app_mentions:read` -- Receive @mention events
   - `chat:write` -- Send and edit messages (covers `chat.update` on the bot's own messages)
   - `channels:history` -- Read messages in public channels (for thread context)
   - `channels:join` -- Allow bot to join public channels
   - `groups:history` -- Read messages in private channels (optional)
   - `im:history` -- Read DM history (for DM support)
   - `im:write` -- Send DMs
   - `im:read` -- Read DM history (for DM support)
   - `mpim:history` -- Read group DM history (optional)
   - `mpim:write` -- Send group DMs
   - `reactions:write` -- Add lifecycle reactions (🔄 / ✅ / ❌) to the triggering message
   - `commands` -- Required for the `/archon` and `/archon-workflow` slash commands
   - `users:read` -- Look up real names via `users.info` for user attribution. The adapter degrades gracefully if this scope is missing (real names won't appear in the Archon DB, but messages still flow); a one-time `slack.users_info_missing_scope` warning surfaces the misconfiguration in the server log.

## Step 4: Subscribe to Events

1. In the left sidebar, click **Event Subscriptions**
2. Toggle **Enable Events** to ON
3. Under **Subscribe to bot events**, add:
   - `app_mention` -- When someone @mentions your bot
   - `message.im` -- Direct messages to your bot
   - `message.channels` -- Messages in public channels (optional, for broader context)
   - `message.groups` -- Messages in private channels (optional)
4. Click **Save Changes**

## Step 4b: Enable Interactivity

Interactive buttons (Approve / Reject / Cancel on workflow runs) ride the same
Socket Mode connection -- no public URL needed.

1. In the left sidebar, click **Interactivity & Shortcuts**
2. Toggle **Interactivity** to ON
3. Leave the **Request URL** field blank -- Socket Mode handles routing
4. Click **Save Changes**

## Step 4c: Register Slash Commands

Two slash commands give the team an alternative to @mention:

| Command | What it does |
| --- | --- |
| `/archon <message>` | Talks to Archon in the current channel. Equivalent to `@archon <message>`. |
| `/archon-workflow <subcommand>` | Direct workflow control. Supports `list`, `status`, `run <name> <args>`, `approve <id> [comment]`, `reject <id> [reason]`, `abandon <id>`, `resume <id>`. |

For each command:

1. In the left sidebar, click **Slash Commands**
2. Click **Create New Command**
3. Fill in:
   - **Command**: `/archon` (or `/archon-workflow`)
   - **Request URL**: leave blank -- Socket Mode handles routing
   - **Short Description**: e.g. "Talk to Archon" or "Archon workflow control"
   - **Usage Hint**: e.g. `<message>` or `<subcommand>`
4. Save

Reinstall the app (Step 5) after adding scopes or commands so Slack issues a
fresh token with the new permissions.

## Step 5: Install to Workspace

1. In the left sidebar, click **Install App**
2. Click **Install to Workspace**
3. Review the permissions and click **Allow**
4. **Copy the Bot User OAuth Token** (starts with `xoxb-`) -- this is your `SLACK_BOT_TOKEN`
5. Set the bot token in your `.env` file

## Step 6: Set Environment Variables

Add to your `.env` file:

```ini
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_APP_TOKEN=xapp-your-app-token
```

## Step 7: Invite Bot to Channel

1. Go to the Slack channel where you want to use the bot
2. Type `/invite @your-bot` (your bot's display name)
3. The bot should now respond to @mentions in that channel

## Configure User Whitelist (Optional)

To restrict bot access to specific users:
1. In Slack, go to a user's profile > click "..." > "Copy member ID"
2. Add to environment:

```ini
SLACK_ALLOWED_USER_IDS=U01ABC123,U02DEF456
```

When set, only listed user IDs can interact with the bot. When empty/unset, the bot responds to all users.

## Configure Streaming Mode (Optional)

```ini
SLACK_STREAMING_MODE=batch  # batch (default) | stream
```

For streaming mode details, see [Configuration](/getting-started/configuration/).

## Usage

### @Mention in Channels

```
@your-bot /clone https://github.com/user/repo
```

### Continue Work in Thread

Reply in the thread created by the initial message:

```
@your-bot /status
```

### Start Parallel Work (Worktree)

```
@your-bot /worktree feature-branch
```

### Direct Messages

You can also DM the bot directly -- no @mention needed:

```
/help
```

## In-Thread UX

When a workflow runs in a Slack thread, Archon now:

- Adds 🔄 to your triggering message when the run starts, and swaps it for ✅
  on completion or ❌ on failure / cancellation
- Posts a single status message in the thread that's edited in place as DAG
  nodes start, complete, fail, or get skipped
- Renders approval gates as interactive **Approve** / **Reject** buttons
  in-thread -- no need to leave Slack to resume a paused run
- Adds a **Cancel** button on the status message while the run is
  non-terminal, so anyone on the allowed user list can abandon a runaway run
  with a click
- Appends a small italic cost / token footer after direct-chat replies
  (e.g. `_cost: $0.0234 · 12.4k tokens · stop: end_turn_`) and on the
  final status message when a workflow completes
- Annotates long responses split across multiple Slack messages with
  `_part i/n_` footers so it's clear they belong together

All clicks on Approve / Reject / Cancel run through the same
`SLACK_ALLOWED_USER_IDS` whitelist as inbound messages -- unauthorized
clicks are silently dropped and logged.

## Troubleshooting

### Bot Doesn't Respond

1. Check that Socket Mode is enabled
2. Verify both tokens are correct in `.env`
3. Check the app logs for errors
4. Ensure the bot is invited to the channel
5. Make sure you're @mentioning the bot (not just typing)

### "channel_not_found" Error

The bot needs to be invited to the channel:

```
/invite @your-bot
```

### "missing_scope" Error

Add the required scope in **OAuth & Permissions** and reinstall the app.

### Thread Context Not Working

Ensure these scopes are added:

- `channels:history` (public channels)
- `groups:history` (private channels)

## Security Recommendations

1. **Use User Whitelist**: Set `SLACK_ALLOWED_USER_IDS` to restrict bot access
2. **Private Channels**: Invite the bot only to channels where it's needed
3. **Token Security**: Never commit tokens to version control

## Reference Links

- [Slack API Documentation](https://api.slack.com/docs)
- [Bolt for JavaScript](https://tools.slack.dev/bolt-js/)
- [Socket Mode Guide](https://api.slack.com/apis/connections/socket)
- [Permission Scopes](https://api.slack.com/scopes)
