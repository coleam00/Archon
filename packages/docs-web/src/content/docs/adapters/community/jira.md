---
title: Jira
description: Talk to Archon inside Jira issues — @mention the bot in a comment and it replies on the ticket.
category: adapters
area: adapters
audience: [operator]
sidebar:
  order: 8
---

:::note
Jira is a **community adapter** in the `task-management` category — contributed and maintained by the community.
:::

Connect Archon to Jira Cloud so each issue becomes a live conversation: `@mention` the bot in a comment, and Archon runs through the orchestrator and replies back as a comment on the same ticket. Many tickets means many parallel conversations, the same way Slack threads work.

This adapter is a **conversation point, not an end-to-end auto-resolver.** It routes a comment into Archon and posts the reply back. Actually resolving a ticket (explore → implement → open a PR → transition the issue) is a *workflow* concern, not the adapter's job — Jira hosts no code, so the adapter never clones a repo or manages a worktree.

## Prerequisites

- Archon server running (see [Getting Started](/getting-started/overview/))
- A Jira Cloud site where you can create issues and register a webhook
- An Atlassian API token (created against the account the bot posts as)
- A public endpoint for webhooks (see the ngrok step below for local development)

## Step 1: Create an Atlassian API Token

1. Go to **[id.atlassian.com → Security → API tokens](https://id.atlassian.com/manage-profile/security/api-tokens)**
2. **Create API token**, give it a label (e.g. `archon`), and copy it (starts with `ATAT…`)
3. Note the **email address** of that Atlassian account — Archon authenticates as `email:api_token` (HTTP Basic auth)

:::caution
The token must belong to an account that can view and comment on the target project. An invalid email/token returns `401 Unauthorized` (or a `404` on the issue) — see Troubleshooting.
:::

## Step 2: Generate a Webhook Secret

```bash
openssl rand -hex 32
```

Windows (PowerShell):

```powershell
-join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Maximum 256) })
```

Save this — you'll use it in Steps 4 and 5.

## Step 3: Expose Your Local Server (Development Only)

```bash
ngrok http 3090
# Copy the HTTPS URL (e.g., https://abc123.ngrok-free.app)
```

For production, use your deployed server URL directly.

## Step 4: Configure the Jira Webhook

In Jira, go to **Settings → System → WebHooks → Create a WebHook**:

| Field | Value |
|-------|-------|
| **URL** | `https://your-domain.com/webhooks/jira?secret=YOUR_SECRET` |
| **Events** | Enable **Comment → created** |

:::note
Jira does **not** HMAC-sign webhook bodies the way GitHub does. Authentication is the shared secret passed in the URL as `?secret=…`, which must match `JIRA_WEBHOOK_SECRET` exactly. Make sure the `?secret=` query string survives any URL editing.
:::

## Step 5: Set Environment Variables

```ini
JIRA_DOMAIN=yourorg.atlassian.net
JIRA_EMAIL=you@example.com
JIRA_API_TOKEN=ATATT-your-token-here
JIRA_WEBHOOK_SECRET=your-secret-here
```

Optional:

```ini
# Display name to match in @mentions; case-insensitive (default: Archon)
JIRA_BOT_MENTION=Archon
# Comma-separated Jira accountIds; when set, only these users can trigger the bot
JIRA_ALLOWED_ACCOUNT_IDS=
```

`JIRA_DOMAIN` accepts a bare domain (`yourorg.atlassian.net`) or a full URL (`https://yourorg.atlassian.net`). The adapter starts automatically once `JIRA_DOMAIN`, `JIRA_EMAIL`, `JIRA_API_TOKEN`, and `JIRA_WEBHOOK_SECRET` are set.

## Usage

Mention the bot in any issue comment:

```
@Archon what's the simplest fix for this ticket?
@Archon /status
@Archon summarize the discussion so far
```

The mention is matched by **display name**, case-insensitive (`@Archon`, `@archon`) — there is no bot Atlassian account to set up. Archon replies as a comment on the same issue, using the account from `JIRA_EMAIL`.

## Conversation ID Format

| Type | Format | Example |
|------|--------|---------|
| Issue | `ISSUE-KEY` | `DFE-7` |

Each issue key is its own conversation, so replies stay scoped to the ticket and multiple tickets run in parallel.

## Supported Events

| Jira Event | Action |
|-----------|--------|
| **Comment created** (with @mention of the bot) | Triggers an Archon conversation |
| Comment created (no mention) | Ignored |
| The bot's own comments | Ignored via an invisible self-trigger marker (no loops) |

## Troubleshooting

| Issue | Cause | Fix |
|-------|-------|-----|
| `jira.invalid_webhook_secret` | `?secret=` missing or mismatched | Ensure the webhook URL ends with `?secret=` and the value matches `JIRA_WEBHOOK_SECRET` exactly |
| `404 Not Found` from ngrok | Wrong path | The route is `/webhooks/jira` (two o's) |
| `401 Unauthorized` / `404 ... do not have permission` on reply | Bad `JIRA_EMAIL` / `JIRA_API_TOKEN` | Verify the email matches the token's account and the token is current; regenerate if unsure |
| No reply, webhook returns `200` | Mention not detected | The comment must contain `@<JIRA_BOT_MENTION>` (default `@Archon`), case-insensitive |
| No webhook delivery | ngrok URL changed | Update the webhook URL after restarting ngrok |

## Notes

- The adapter reads the comment from the webhook payload (Jira delivers the body as text) and posts replies in Atlassian Document Format (ADF) via `POST /rest/api/3/issue/{key}/comment`.
- Long replies are split into multiple comments.
- No repository is cloned and no isolation environment is created — this is a conversation adapter, not a forge.
