# Discord Bot Setup Guide

## 1. Create a Discord Application

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
2. Click **New Application**
3. Enter a name (e.g., "Archon Bot") and click **Create**

## 2. Create a Bot

1. In the left sidebar, click **Bot**
2. Click **Reset Token** to generate a new bot token
3. **Copy the token** — this is your `DISCORD_BOT_TOKEN`
4. Under **Privileged Gateway Intents**, enable:
   - **MESSAGE CONTENT INTENT** (required to read message text)

## 3. Generate Invite URL

1. In the left sidebar, click **OAuth2**
2. Under **OAuth2 URL Generator**, select scopes:
   - `bot`
3. Under **Bot Permissions**, select:
   - Send Messages
   - Read Message History
   - Use Slash Commands
4. Copy the generated URL and open it in your browser
5. Select your server and click **Authorize**

## 4. Get Your User ID

1. In Discord, go to **Settings > Advanced > Developer Mode** (enable it)
2. Right-click your username anywhere and click **Copy User ID**
3. This is your `DISCORD_ALLOWED_USER_IDS`

## 5. Add to `.env` (in the archon repo root)

```env
DISCORD_BOT_TOKEN=<token from step 2>
DISCORD_ALLOWED_USER_IDS=<your user ID>
DISCORD_STREAMING_MODE=batch
```

- `DISCORD_STREAMING_MODE=batch` waits for the full response (recommended for Discord).
- `DISCORD_STREAMING_MODE=stream` shows responses as they're generated.
- Multiple user IDs can be comma-separated.

## 6. Start the Server

Follow the [Server Setup Guide](server.md) to start the server. The Discord adapter auto-starts when `DISCORD_BOT_TOKEN` is set.

## 7. Test

In the Discord channel where you invited the bot:

```
@Archon Bot /help
```

The bot should respond with available commands.
