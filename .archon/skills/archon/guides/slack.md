# Slack Bot Setup Guide

Slack setup is more involved than other platforms. A detailed walkthrough is available in the main docs.

## Full Guide

Follow the step-by-step instructions in **[docs/slack-setup.md](../../../../../docs/slack-setup.md)** in this repository.

## Summary

1. Create a Slack app at [api.slack.com/apps](https://api.slack.com/apps) (from scratch)
2. Enable **Socket Mode** — generates an App-Level Token (`xapp-...`) for `SLACK_APP_TOKEN`
3. Add **Bot Token Scopes**: `app_mentions:read`, `chat:write`, `channels:history`, `channels:join`, `im:history`, `im:write`, `im:read`
4. Subscribe to **Bot Events**: `app_mention`, `message.im`
5. **Install to Workspace** — generates a Bot User OAuth Token (`xoxb-...`) for `SLACK_BOT_TOKEN`
6. Invite the bot to your channel: `/invite @YourBotName`

## `.env` Configuration (in the archon repo root)

```env
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_APP_TOKEN=xapp-your-app-token
SLACK_ALLOWED_USER_IDS=<your Slack user ID>
SLACK_STREAMING_MODE=batch
```

To find your Slack user ID: click your profile > **...** > **Copy member ID**.

## Start the Server

Follow the [Server Setup Guide](server.md) to start the server. The Slack adapter auto-starts when both `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` are set.
