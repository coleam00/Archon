---
title: GitLab
description: Connect Archon to GitLab for AI coding assistance in issues and merge requests.
category: adapters
area: adapters
audience: [operator]
sidebar:
  order: 7
---

:::note
GitLab is a **community adapter** — contributed and maintained by the community.
:::

Connect Archon to a GitLab instance (gitlab.com or self-hosted) so you can interact with your AI coding assistant from issues and merge requests.

## Prerequisites

- Archon server running (see [Getting Started](/getting-started/overview/))
- GitLab project with issues and merge requests enabled
- GitLab Personal Access Token or Project Access Token with `api` scope
- Public endpoint for webhooks (see ngrok setup below for local development)

## Step 1: Create a GitLab Access Token

### Personal Access Token (recommended for getting started)

1. Go to **GitLab → User Settings → Access Tokens**
2. Create a token with:
   - **Name**: `archon`
   - **Scopes**: `api`
   - **Expiration**: Set as needed
3. Copy the token (starts with `glpat-`)

### Project Access Token (recommended for production)

1. Go to **Project → Settings → Access Tokens**
2. Create a token with:
   - **Role**: Developer or Maintainer
   - **Scopes**: `api`
3. This creates a bot user scoped to the project

## Step 2: Generate Webhook Secret

```bash
openssl rand -hex 32
```

Windows (PowerShell):

```powershell
-join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Maximum 256) })
```

Save this secret — you'll need it for steps 3 and 4.

## Step 3: Expose Local Server (Development Only)

```bash
ngrok http 3090
# Copy the HTTPS URL (e.g., https://abc123.ngrok-free.app)
```

For production, use your deployed server URL directly.

## Step 4: Configure GitLab Webhook

Navigate to **Project → Settings → Webhooks → Add new webhook**:

| Field | Value |
|-------|-------|
| **URL** | `https://your-domain.com/webhooks/gitlab` |
| **Secret token** | The secret from Step 2 |
| **Triggers** | Enable: `Comments`, `Issues events`, `Merge request events` |
| **SSL verification** | Enable (recommended) |

Click "Add webhook" and use **Test → Note events** to verify.

:::note
GitLab uses a plain secret token in the `X-Gitlab-Token` header (not HMAC like GitHub). The token must match your `GITLAB_WEBHOOK_SECRET` exactly.
:::

## Step 5: Set Environment Variables

```ini
GITLAB_URL=https://gitlab.com
GITLAB_TOKEN=glpat-your-token-here
GITLAB_WEBHOOK_SECRET=your-secret-here
```

Optional:

```ini
GITLAB_ALLOWED_USERS=alice,bob
GITLAB_BOT_MENTION=archon
```

See the [full environment variable reference](/reference/configuration/) for details.

## Usage

Mention your bot in issue or MR comments:

```
@archon can you analyze this bug?
@archon /status
@archon review this implementation
```

**First mention** automatically clones the repository to `~/.archon/workspaces/<group>/<project>`, detects `.archon/commands/` if present, and injects full issue/MR context.

**Subsequent mentions** resume the existing conversation with full context.

## Conversation ID Format

| Type | Format | Example |
|------|--------|---------|
| Issue | `group/project#iid` | `myteam/api#42` |
| Merge Request | `group/project!iid` | `myteam/api!15` |
| Nested group | `group/subgroup/project#iid` | `org/team/api#7` |

## Supported Events

| GitLab Event | Action |
|-------------|--------|
| **Note Hook** (comment with @mention) | Triggers AI conversation |
| **Issue Hook** (close) | Cleans up isolation environment |
| **MR Hook** (close/merge) | Cleans up isolation environment |
| Issue/MR opened | Ignored (descriptions are not commands) |

## Adding Additional Projects

Add the same webhook to other projects:

```bash
glab api projects/<PROJECT_ID>/hooks \
  --method POST \
  -f url="https://YOUR_DOMAIN/webhooks/gitlab" \
  -f token="YOUR_WEBHOOK_SECRET" \
  -f note_events=true \
  -f issues_events=true \
  -f merge_requests_events=true
```

Or via GitLab UI with the same secret.

## Troubleshooting

| Issue | Cause | Fix |
|-------|-------|-----|
| `gitlab.invalid_webhook_token` | Secret mismatch | Ensure `GITLAB_WEBHOOK_SECRET` matches the webhook config exactly |
| Clone hangs | macOS Keychain credential helper | The adapter disables it automatically |
| `404 Project Not Found` | Token lacks access | Ensure token has `api` scope and project access |
| `403 You are not allowed` | Insufficient permissions | Use a token with Developer role or higher |
| No webhook delivery | ngrok URL changed | Update the webhook URL after restarting ngrok |
| Webhook auto-disabled | 4+ consecutive failures | Fix the issue, then send a test event to re-enable |

## glab CLI Reference

The AI agent uses `glab` CLI commands. Install and authenticate:

```bash
brew install glab
glab auth login
```

| Command | Purpose |
|---------|---------|
| `glab issue view <IID>` | View issue details |
| `glab issue note <IID> -m "..."` | Comment on issue |
| `glab mr view <IID>` | View merge request |
| `glab mr diff <IID>` | View MR diff |
| `glab mr note <IID> -m "..."` | Comment on MR |
| `glab mr create --title "..." --description "..."` | Create MR |
