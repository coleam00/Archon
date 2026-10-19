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

> **Teams sharing one Archon instance:** prefer the [GitHub App setup](./github-app-setup.md). The PAT-mode setup on this page is the legacy path — it still works for solo installs, but bot comments all post under the PAT owner's avatar and tokens never auto-rotate. App mode gives you `<slug>[bot]` attribution, 1h token rotation, multi-org support, and one webhook URL.

## Prerequisites

- Archon server running (`archon serve`; see [Web UI](/adapters/web/))
- GitHub repository with issues enabled
- A GitHub personal access token set as `GITHUB_TOKEN` in `~/.archon/.env`
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
| **Events** | Select "Let me select individual events":<br>- Check runs<br>- Issues<br>- Issue comments<br>- Pull requests |

Click "Add webhook" and verify it shows a green checkmark after delivery.

Webhook bodies are limited to **32 MiB (33,554,432 bytes)**, inclusive. Larger bodies receive HTTP **413** before the signature is checked; Archon stops reading them and creates no receipt or workflow start. This limit applies only to webhook routes.

## Step 4: Set Environment Variables

```ini
WEBHOOK_SECRET=your_secret_from_step_1
```

**Important**: The `WEBHOOK_SECRET` must match exactly what you entered in GitHub's webhook configuration.

## Step 5: Configure Streaming (Optional)

The GitHub adapter always uses `batch` mode (hardcoded). It assembles the reply before delivery and splits long replies into multiple comments.

## Usage

Interact by @mentioning your bot in issue or PR **comments**:

```
@archon can you analyze this bug?
@archon prime the codebase
@archon review this implementation
```

**First mention behavior:**
- Reuses an existing local registration at its saved checkout path, including a subdirectory of a Git checkout. Otherwise, registers and clones the repository to `~/.archon/workspaces/owner/repo/source/`, or to a suffixed path such as `owner/repo-2/source/` when that project name is taken.
- For an existing registration, readiness skips syncing the checkout to preserve local changes.
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
- **Events**: Check runs, Issues, Issue comments, Pull requests

**Via CLI:**

```bash
# Get your existing webhook secret
WEBHOOK_SECRET=$(grep WEBHOOK_SECRET .env | cut -d= -f2)

# Add webhook to new repo (replace OWNER/REPO)
gh api repos/OWNER/REPO/hooks --method POST \
  -f "config[url]=https://YOUR_DOMAIN/webhooks/github" \
  -f "config[content_type]=json" \
  -f "config[secret]=$WEBHOOK_SECRET" \
  -f "events[]=check_run" \
  -f "events[]=issues" \
  -f "events[]=issue_comment" \
  -f "events[]=pull_request"
```

**Important**: The webhook secret must be identical across all repos.

Check-run deliveries wake CI waits quickly. They are not required for correctness: when GitHub does not deliver one, the workflow reaches its deadline and probes CI again.

## GitHub Enterprise Server

To run the adapter against a self-hosted GitHub Enterprise Server, set its base URL:

```ini
GITHUB_URL=https://github.example.com
```

With `GITHUB_URL` set, the adapter calls `https://github.example.com/api/v3`, clones from `https://github.example.com/<owner>/<repo>.git`, and `GH_TOKEN`/`GITHUB_TOKEN` authenticate HTTPS clones of that exact scheme, host and port. Leave it unset for github.com. A value with a path, query or credentials is rejected: the adapter and the GitHub App fail startup, and clones to the Enterprise host get no GitHub token. Clones from other forges are unaffected.

- **Webhook:** create it on the Enterprise repository or organization, pointing at the same `/webhooks/github` endpoint with the same secret (Step 3).
- **GitHub App mode:** register the App on the Enterprise instance (**Settings → Developer settings → GitHub Apps**) with the permissions listed in [GitHub App Setup](/adapters/github-app-setup/). The App's API calls and installation tokens go to the Enterprise instance.
- **SDLC workflows:** the forge plugin needs a `forge.hosts` entry for the Enterprise host; see [forge plugin configuration](/reference/forge/#plugin-configuration).

Current limits: in App mode, git operations after the first clone (sync, workflow pushes) and per-user identity (`archon auth github`, the device flow) still target github.com. Use PAT mode on Enterprise Server for now.

## Further Reading

- [Configuration](/getting-started/configuration/)
