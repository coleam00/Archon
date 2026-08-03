# Telegram Bot Setup Guide

## 1. Create a Bot via BotFather

1. Open Telegram and search for **@BotFather**
2. Send `/newbot`
3. Choose a display name (e.g., "Archon Bot")
4. Choose a username (must end in `bot`, e.g., `my_archon_bot`)
5. **Copy the bot token** — this is your `TELEGRAM_BOT_TOKEN`

## 2. Get Your User ID

1. Search for **@userinfobot** on Telegram
2. Send any message
3. It replies with your user ID (a number like `123456789`)
4. This is your `TELEGRAM_ALLOWED_USER_IDS`

## 3. Add to `.env` (in the archon repo root)

```env
TELEGRAM_BOT_TOKEN=<token from BotFather>
TELEGRAM_ALLOWED_USER_IDS=<your user ID>
TELEGRAM_STREAMING_MODE=stream
```

- `TELEGRAM_STREAMING_MODE=stream` shows responses as they're generated (recommended).
- `TELEGRAM_STREAMING_MODE=batch` waits for the full response before sending.
- Multiple user IDs can be comma-separated.

## 4. Start the Server

Follow the [Server Setup Guide](server.md) to start the server. The Telegram adapter auto-starts when `TELEGRAM_BOT_TOKEN` is set.

## 5. Test

Send a message to your bot on Telegram:

```
/help
```

The bot should respond with available commands.
