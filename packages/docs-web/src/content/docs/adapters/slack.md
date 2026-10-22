---
title: Slack
description: Install the Slack chat plugin and connect Archon to Slack over Socket Mode -- works behind firewalls with no public URL needed.
category: adapters
area: adapters
audience: [user, operator]
status: current
sidebar:
  order: 2
---

Connect Archon to Slack so you can interact with your AI coding assistant from any Slack workspace.

Slack runs as a chat plugin, `chat-slack`, released with Archon. The server starts the plugin as its own process and talks to it over the chat plugin protocol; the server itself contains no Slack code. You create a Slack app, set its two tokens in the server environment, and install the plugin. Docker provisions the image-provided plugin automatically when `SLACK_BOT_TOKEN` is configured.

New identities are created as members. The operator can designate admins with [`archon user role <id> admin`](/reference/security/#users-and-roles); only a run's starter or an admin can act on it. See [Who can act on a run](/reference/security/#who-can-act-on-a-run).

## Prerequisites

- Archon server running (`archon serve`; see [Web UI](/adapters/web/))
- A Slack workspace where you have permission to install apps
- An Archon release that publishes the Slack plugin asset (`archon-chat-slack-<os>-<arch>`)

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
   - `users:read` -- Look up real names via `users.info` for user attribution. Without this scope messages still flow, but real names do not appear in the Archon database.

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

Interactive buttons (gate decisions and Cancel on workflow runs) ride the same
Socket Mode connection -- no public URL needed.

1. In the left sidebar, click **Interactivity & Shortcuts**
2. Toggle **Interactivity** to ON
3. Leave the **Request URL** field blank -- Socket Mode handles routing
4. Click **Save Changes**

## Step 4c: Register Slash Commands

Two slash commands give the team an alternative to @mention:

| Command | What it does |
| --- | --- |
| `/archon <message>` | Starts a new thread in the current channel. To continue an existing thread, post `@archon <message>` in that thread. |
| `/archon-workflow <subcommand>` | Direct workflow control. Supports `list`, `status`, `get <id>`, `run <name> <args>`, `approve <id> [comment]`, `reject <id> [reason]`, `respond <id> <decision> [text]`, `abandon <id>`, `resume <id>`. |

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

## Step 6: Set Environment Variables

Add both tokens to the server's env file (`~/.archon/.env`, or the compose `.env` in Docker):

```ini
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_APP_TOKEN=xapp-your-app-token
```

In Docker, a nonempty `SLACK_BOT_TOKEN` declares installation at startup, including tokens in `/.archon/.env`. Both tokens are required for a connection.

The plugin reads them from the environment the server starts it with. If either is missing, the plugin fails to start and the server does not retry it.

## Step 7: Install the Slack Plugin

With the release binary or Homebrew:

```bash
archon plugin add coleam00/Archon/plugins/chat-slack
```

In a source checkout, run `bun run cli plugin add coleam00/Archon/plugins/chat-slack`.

In Docker, restart the container with its tokens configured. The image-provided release installs offline before the server starts, writes a verified receipt to `/.archon/plugins`, and logs why it was provisioned. No manual install is needed. A valid installed Slack plugin is retained at its current version. See [Building the image](/deployment/docker/#building-the-image) for the release pin and build args.

Without a tag, manual `plugin add` installs the latest release. Restart the server; Slack appears in `/api/health` once the plugin connects. Keep the plugin current with `archon plugin update coleam00/Archon/plugins/chat-slack`, and remove it with `archon plugin remove coleam00/Archon/plugins/chat-slack`. In Docker, remove Slack tokens from every effective env source as well, or the image plugin is reinstalled on restart. Outside Docker, removal followed by a restart keeps Slack off. See [`archon plugin`](/reference/cli/#plugin).

## Step 8: Invite Bot to Channel

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

When set, only listed user IDs can interact with the bot. When empty/unset, the bot responds to all users. The server enforces this list, for messages and for button clicks alike, before anything reaches Archon.

## Configure Streaming Mode (Optional)

```ini
SLACK_STREAMING_MODE=batch  # batch (default) | stream
```

For streaming mode details, see [Configuration](/getting-started/configuration/).

## Usage

Select a registered project by posting `@your-bot /setproject <name>` in the target thread. To register a local directory first, post `@your-bot /register-project [--folder] <name> <path>`, then select it; registration alone does not bind the conversation. Projectless questions still work. Selection applies to that conversation, not every channel.

Slack registers `/archon` and `/archon-workflow`, not raw `/setproject` or `/register-project` slash commands. `/archon <message>` creates a new thread; use an @mention in the existing thread to scope that conversation.

Once scoped, the assistant launches and manages runs through its native tools (Claude, Codex, Pi) or the existing CLI (Copilot/OpenCode). CLI launches are detached and headless, use CLI identity and return a run ID for inspection; they do not deliver progress or results to the originating chat. See [Deprecated providers](/getting-started/ai-assistants/#deprecated-providers).

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
  on execution completion or ❌ on execution failure / cancellation. If a declared
  authored outcome disagrees, it also adds the outcome reaction, so both facts remain visible
- Posts a single status message in the thread that's edited in place as DAG
  nodes start, complete, fail, or get skipped
- When approval details are available, renders the gate's declared decisions as
  buttons, using labels when supplied and sending the exact decision ID.
  Legacy gates keep **Approve** / **Reject**.
  The fallback text lists `/archon-workflow respond <id> <decision> [text]` commands;
  use these to include optional text with a decision. For a parent blocked on a
  child run, these parent controls redirect to the child instead of recording a
  parent decision. Answer the child run using the displayed child command
- If approval details cannot be loaded, posts an **Approval details unavailable**
  notice naming the run instead of decision buttons or response commands. Check
  the run status before responding
- Adds a **Cancel** button on the status message while the run is
  non-terminal, so the run's starter or an admin can abandon a runaway run
  with a click
- Appends a small italic cost / token footer after direct-chat replies
  (e.g. `_cost: $0.0234 · 12.4k tokens · stop: end_turn_`) and on the
  final status message when a workflow completes
- Labels execution status and a non-null authored outcome separately in the final status message;
  workflows without an authored outcome retain the existing status-only message
- Annotates long responses split across multiple Slack messages with
  `_part i/n_` footers so it's clear they belong together

All gate-decision and Cancel clicks run through the same
`SLACK_ALLOWED_USER_IDS` whitelist as inbound messages -- clicks from users
outside it are dropped. A member who is not the run's starter or an admin sees
a refusal only they can see.

`/archon connect github` replies with a pointer to the Web UI or
`archon auth github`; it does not run the GitHub device flow in Slack.

## Upgrading From the Bundled Slack Adapter

Earlier Archon versions ran Slack inside the server whenever `SLACK_BOT_TOKEN` and
`SLACK_APP_TOKEN` were set. The server no longer contains that adapter: without the
plugin, Slack stays off. When `SLACK_BOT_TOKEN` is set and no Slack plugin is installed,
startup logs a `chat.bundled_adapter_retired` warning with Docker provisioning guidance and the manual install command.

In Docker, existing token configuration provisions the image-provided plugin offline on restart; no manual step is needed. The boot log names the release and why it was installed. Outside Docker, install the plugin (Step 7) and restart. Nothing else changes: the tokens, the Slack app
configuration, `SLACK_ALLOWED_USER_IDS` and `SLACK_STREAMING_MODE` stay as they are, and
existing conversations, linked identities and workspaces carry over because the plugin
keeps the platform id `slack`.

## Troubleshooting

### Bot Doesn't Respond

1. Check that the plugin is installed: `archon plugin list` shows `coleam00/Archon/plugins/chat-slack`
2. Check that Socket Mode is enabled
3. Verify both tokens are correct in `.env`, then check the server log for `chat.bundled_adapter_retired` or a plugin start failure
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
