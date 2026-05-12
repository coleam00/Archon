---
title: GitHub
description: Connect Archon to GitHub via webhooks to interact from issues and pull requests.
category: adapters
area: adapters
audience: [user, operator]
status: current
sidebar:
  order: 4
---

Connect Archon to GitHub so you can interact with your AI coding assistant from issues and pull requests.

## Prerequisites

- Archon server running (see [Getting Started](/getting-started/))
- GitHub repository with issues enabled
- `GITHUB_TOKEN` set in your environment (see [Getting Started](/getting-started/))
- Public endpoint for webhooks (see ngrok setup below for local development)

## Step 1: Generate Webhook Secret

On Linux/Mac:
```bash
openssl rand -hex 32
```

On Windows (PowerShell):
```powershell
-join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Maximum 256) })
```

Save this secret -- you'll need it for steps 3 and 4.

## Step 2: Expose Local Server (Development Only)

### Using ngrok (Free Tier)

```bash
# Install ngrok: https://ngrok.com/download
# Or: choco install ngrok (Windows)
# Or: brew install ngrok (Mac)

# Start tunnel
ngrok http 3090

# Copy the HTTPS URL (e.g., https://abc123.ngrok-free.app)
# Free tier URLs change on restart
```

Keep this terminal open while testing.

### Using Cloudflare Tunnel (Persistent URLs)

```bash
# Install: https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/
cloudflared tunnel --url http://localhost:3090

# Get persistent URL from Cloudflare dashboard
```

Persistent URLs survive restarts.

**For production deployments**, use your deployed server URL (no tunnel needed).

## Step 3: Configure GitHub Webhook

Go to your repository settings:
- Navigate to: `https://github.com/owner/repo/settings/hooks`
- Click "Add webhook"
- **Note**: For multiple repositories, you'll need to add the webhook to each one individually

**Webhook Configuration:**

| Field | Value |
|-------|-------|
| **Payload URL** | Local: `https://abc123.ngrok-free.app/webhooks/github`<br>Production: `https://your-domain.com/webhooks/github` |
| **Content type** | `application/json` |
| **Secret** | Paste the secret from Step 1 |
| **SSL verification** | Enable SSL verification (recommended) |
| **Events** | Select "Let me select individual events":<br>- Issues<br>- Issue comments<br>- Pull requests |

Click "Add webhook" and verify it shows a green checkmark after delivery.

## Step 4: Set Environment Variables

```ini
WEBHOOK_SECRET=your_secret_from_step_1
```

**Important**: The `WEBHOOK_SECRET` must match exactly what you entered in GitHub's webhook configuration.

## Step 5: Configure Streaming (Optional)

The GitHub adapter always uses `batch` mode (hardcoded) since GitHub issues and PRs are best served by single complete comments rather than streaming updates.

## Usage

Interact by @mentioning your bot in issue or PR **comments**:

```
@archon can you analyze this bug?
@archon prime the codebase
@archon review this implementation
```

**First mention behavior:**
- Automatically clones the repository to `~/.archon/workspaces/`
- Detects and loads commands from `.archon/commands/` if present
- Injects full issue/PR context for the AI assistant

**Subsequent mentions:**
- Resumes existing conversation
- Maintains full context across comments

:::note
Only comments trigger the bot. @mentions in issue or PR descriptions are ignored -- descriptions often contain example commands or documentation that are not intended as bot invocations.
:::

## Adding Additional Repositories

Once your server is running, add more repos by creating a webhook with the same secret.

**Via GitHub UI:** Repo Settings > Webhooks > Add webhook
- **Payload URL**: Your server URL + `/webhooks/github`
- **Content type**: `application/json`
- **Secret**: Same `WEBHOOK_SECRET` from your `.env`
- **Events**: Issues, Issue comments, Pull requests

**Via CLI:**

```bash
# Get your existing webhook secret
WEBHOOK_SECRET=$(grep WEBHOOK_SECRET .env | cut -d= -f2)

# Add webhook to new repo (replace OWNER/REPO)
gh api repos/OWNER/REPO/hooks --method POST \
  -f "config[url]=https://YOUR_DOMAIN/webhooks/github" \
  -f "config[content_type]=json" \
  -f "config[secret]=$WEBHOOK_SECRET" \
  -f "events[]=issues" \
  -f "events[]=issue_comment" \
  -f "events[]=pull_request"
```

**Important**: The webhook secret must be identical across all repos.

## Further Reading

- [Configuration](/getting-started/configuration/)
