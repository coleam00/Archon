---
title: Gitea
description: Connect Archon to a Gitea instance for issue and PR automation.
category: adapters
area: adapters
audience: [operator]
sidebar:
  order: 6
---

:::note
Gitea is a **community adapter** — contributed and maintained by the community.
:::

Connect Archon to a self-hosted Gitea instance so you can interact with your AI coding assistant from Gitea issues and pull requests.

## Prerequisites

- Archon server running (see [Getting Started](/getting-started/))
- A Gitea instance with API access enabled
- A Gitea personal access token (or dedicated bot account token)
- Public endpoint for webhooks (or a tunnel for local development)

## Step 1: Create a Gitea Token

1. Log in to your Gitea instance
2. Go to **Settings > Applications > Manage Access Tokens**
3. Create a new token with repository read/write permissions
4. Copy the token -- you will need it for Step 3

## Step 2: Generate a Webhook Secret

On Linux/Mac:
```bash
openssl rand -hex 32
```

On Windows (PowerShell):
```powershell
-join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Maximum 256) })
```

Save this secret for Steps 3 and 4.

## Step 3: Set Environment Variables

```ini
GITEA_URL=https://gitea.example.com
GITEA_TOKEN=your_personal_access_token
GITEA_WEBHOOK_SECRET=your_secret_from_step_2
```

All three variables are required. The adapter starts automatically when all three are set.

**Optional variables:**

```ini
# Restrict who can trigger the bot (comma-separated usernames, case-insensitive)
GITEA_ALLOWED_USERS=alice,bob

# Custom @mention name (defaults to BOT_DISPLAY_NAME, then "Archon")
GITEA_BOT_MENTION=archon
```

## Step 4: Configure Gitea Webhook

Go to your repository settings in Gitea:
- Navigate to **Settings > Webhooks > Add Webhook > Gitea**

**Webhook Configuration:**

| Field | Value |
|-------|-------|
| **Target URL** | `https://your-domain.com/webhooks/gitea` |
| **HTTP Method** | `POST` |
| **Content Type** | `application/json` |
| **Secret** | Paste the secret from Step 2 |
| **Events** | Issues, Issue Comments, Pull Requests, Pull Request Comments |

Click **Add Webhook** and use the **Test Delivery** button to verify connectivity.

## Usage

Interact by @mentioning the bot in issue or PR **comments**:

```
@archon can you analyze this bug?
@archon review this implementation
@archon /workflow run assist "explain the auth flow"
```

**First mention behavior:**
- Automatically clones the repository to `~/.archon/workspaces/`
- Detects and loads commands from `.archon/commands/` if present
- Injects full issue/PR context (title, description, labels) for the AI assistant

**Subsequent mentions:**
- Resumes the existing conversation
- Maintains full context across comments

:::note
Only comments trigger the bot. @mentions in issue or PR descriptions are ignored -- descriptions often contain example commands or documentation that are not intended as bot invocations.
:::

## How It Works

The Gitea adapter is a webhook-based forge adapter, similar to the GitHub adapter:

- **Transport**: Receives HTTP POST webhooks from Gitea
- **Signature verification**: HMAC SHA-256 using the `X-Gitea-Signature` header
- **Streaming mode**: Always batch (single coherent comment per response, no comment spam)
- **Conversation ID format**: `owner/repo#number` for issues, `owner/repo!number` for PRs
- **Self-loop prevention**: Bot comments include a hidden HTML marker (`<!-- archon-bot-response -->`) to avoid re-triggering on its own messages
- **Retry logic**: Transient network errors (timeouts, connection resets) are retried up to 3 times with exponential backoff

### Close/Merge Cleanup

When an issue is closed or a PR is merged/closed, the adapter automatically cleans up any associated worktree isolation environment.

## Adding More Repositories

Add a webhook with the same secret to each repository you want the bot to monitor. The webhook secret must be identical across all repos pointing to the same Archon instance.

## Further Reading

- [Configuration](/reference/configuration/) -- Full environment variable reference
- [Security](/reference/security/) -- Webhook verification and authorization details
