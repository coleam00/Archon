---
title: GitHub OAuth App Setup
description: Connect Archon to GitHub via an OAuth App with per-user device flow authentication and webhook integration.
category: adapters
area: adapters
audience: [operator]
status: current
sidebar:
  order: 5
---

Archon's GitHub adapter operates in **OAuth App mode** with per-user credentials stored securely in an encrypted vault.

- Every GitHub operation (comments, issue responses, commits, pushes) authenticates via the connected user's token.
- Users connect their accounts via the GitHub Device Flow (`archon auth github`, Web UI, or chat platforms).
- Inbound webhooks are verified via HMAC SHA-256 (`WEBHOOK_SECRET`).
- Critical server secrets (`TOKEN_ENCRYPTION_KEY`, `DATABASE_URL`, `WEBHOOK_SECRET`) are automatically scrubbed from agent subprocesses.

## Prerequisites

- Archon server running
- A registered GitHub OAuth App (or GitHub App with Device Flow enabled)
- Public HTTPS endpoint for webhooks (via ngrok, Cloudflare Tunnel, or production domain)

## Step 1: Register a GitHub OAuth App

1. Go to <https://github.com/settings/developers> (or your organisation's Developer settings).
2. Click **New OAuth App** (or **New GitHub App**).
3. Fill in:
   - **Application name** — e.g. `Archon`.
   - **Homepage URL** — your Archon URL (e.g. `https://archon.example.com`).
   - **Authorization callback URL** — `https://archon.example.com` (not strictly needed for Device Flow, but required by GitHub).
   - If creating a GitHub App: Enable **Device Flow** under "Identifying and authorizing users", and configure Webhook URL to `https://archon.example.com/webhooks/github`.
4. Save the application and note the **Client ID** (starts with `Iv1.` or `Iv23...`).

## Step 2: Generate Encryption and Webhook Secrets

Generate two random 32-byte hex secrets:

```bash
# Token encryption key (for AES-256-GCM vault encryption)
openssl rand -hex 32

# Webhook secret (for HMAC signature validation)
openssl rand -hex 32
```

## Step 3: Configure Archon Server

Set the following environment variables in `~/.archon/.env` or your server environment:

```dotenv
# Required for GitHub adapter:
GITHUB_CLIENT_ID=Iv1.xxxxxxxxxxxxxxxx
TOKEN_ENCRYPTION_KEY=<64-char hex key from step 2>
WEBHOOK_SECRET=<webhook secret from step 2>

# Optional:
GITHUB_BOT_MENTION=Archon             # @mention handle bot responds to (default: Archon)
GITHUB_ALLOWED_USERS=user1,user2      # Comma-separated allowlist of GitHub logins
```

## Step 4: Configure Webhooks on GitHub

In your GitHub repository (or organisation) settings:

1. Go to **Settings → Webhooks → Add webhook**.
2. **Payload URL**: `https://your-domain.com/webhooks/github` (or your tunnel URL).
3. **Content type**: `application/json`.
4. **Secret**: Paste the `WEBHOOK_SECRET` from Step 2.
5. **Events**: Select individual events:
   - Issues
   - Issue comments
   - Pull requests
   - Pull request review comments
6. Save webhook.

## Step 5: Connect User Accounts

Each team member connects their personal GitHub identity:

- **CLI**: Run `archon auth github` and follow the device code instructions.
- **Web UI**: Navigate to **Settings → Connect GitHub**.
- **Slack**: Run `/archon connect github`.

Once connected, all workflows run by that user will authenticate using their GitHub identity.

## Agent Environment Security

Archon enforces defense-in-depth isolation:
- Agent subprocesses never receive `TOKEN_ENCRYPTION_KEY`, `DATABASE_URL`, or `WEBHOOK_SECRET` (`AGENT_ENV_DENYLIST`).
- Git operations in worktrees authenticate via ephemeral short-lived tokens injected at runtime or through Archon's internal credential broker.
