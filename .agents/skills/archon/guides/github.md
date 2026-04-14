# GitHub Webhook Setup Guide

GitHub integration lets Archon respond to issue comments, PR comments, and @mentions via webhooks.

**IMPORTANT — Freeform input rule**: This guide collects URLs, tokens, and usernames. **Never use AskUserQuestion for freeform text input** (URLs, tokens, usernames, paths). Ask the user directly in plain text — e.g., "Paste the ngrok URL here." Use AskUserQuestion **only** for multiple-choice decisions.

## 0. Check Existing .env Values

Before starting, read the existing `.env` file and check which GitHub-related values are already populated:

```bash
cat <archon-repo>/.env
```

Check these keys: `WEBHOOK_SECRET`, `GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_ALLOWED_USERS`.

**If all are already filled in**: Tell the user "GitHub tokens are already configured in `.env`. Skipping to webhook setup." Jump to Step 5 (configure the repo webhook).

**If some are filled in**: Tell the user which values are already set and which are missing. Only collect the missing ones in the steps below.

**If none are filled in**: Proceed with all steps.

## 1. Set Up a Public URL (ngrok)

GitHub webhooks need to reach your local server. Check if ngrok is installed:

```bash
which ngrok
```

**If not installed**, use **AskUserQuestion**:

```
Header: "Install ngrok"
Question: "ngrok is not installed. Want me to install it via Homebrew?"
Options:
  1. "Yes, install it" (Recommended) — runs `brew install ngrok`
  2. "I'll install it myself" — user handles it, wait for confirmation
```

If yes, run:
```bash
brew install ngrok
```

**If ngrok is not authenticated**, check and guide:
```bash
ngrok config check 2>&1
```

If it needs auth:
1. Tell the user: "Sign up at https://ngrok.com (free tier works), then copy your auth token from the dashboard."
2. Ask the user in plain text to paste the token, then run:
```bash
ngrok config add-authtoken <token>
```

## 2. Start ngrok

Tell the user to run this in a **separate terminal** (ngrok must stay running):

```
Run this in another terminal:  ngrok http 3090
```

Then ask in **plain text** (NOT AskUserQuestion):

> "Paste the ngrok HTTPS URL here (e.g., `https://abc123.ngrok-free.app`)."

If the user pastes the full ngrok terminal output, parse the URL from the `Forwarding` line (the `https://...` URL before the `->` arrow).

Store the URL as `<ngrok-url>`.

## 3. Generate a Webhook Secret

**Only if `WEBHOOK_SECRET` is empty/missing in `.env`.**

```bash
openssl rand -hex 32
```

Store this as `<webhook-secret>`.

## 4. Collect GitHub Token and Username

**Only collect values that are missing from `.env`.**

Present all missing items together in a single message, then let the user respond. Do not ask one at a time.

For example, if both token and username are missing:

> "I need two things from you:
> 1. **GitHub token** — Go to github.com/settings/tokens and create a fine-grained token with repository access for `<target-repo>` and permissions: Issues (R/W), Pull Requests (R/W), Contents (Read).
> 2. **GitHub username** — Your GitHub username (used for authorization).
>
> Paste them here when ready (token first, then username), or tell me you've added them to `.env` directly."

If the user says they've already added values to `.env`, read the file to confirm and skip to the next step. Do not ask again for values the user says are already there.

## 5. Write to `.env`

Write only the **missing** values to `.env`. Do not overwrite existing values.

Values to set (if missing):
```env
WEBHOOK_SECRET=<webhook-secret>
GITHUB_TOKEN=<token>
GH_TOKEN=<same token>
GITHUB_ALLOWED_USERS=<username>
```

## 6. Configure the Repository Webhook

Tell the user to go to their **target repo** on GitHub > **Settings** > **Webhooks** > **Add webhook** and configure:

- **Payload URL**: `<ngrok-url>/webhooks/github`
- **Content type**: `application/json`
- **Secret**: `<webhook-secret>` (the value from step 3, or the existing value from `.env`)
- Select events: **Issue comments** + **Pull request review comments** (or "Send me everything")
- Click **Add webhook**

Use **AskUserQuestion** to confirm when done:
```
Header: "Webhook"
Question: "Have you added the webhook to your GitHub repo?"
Options:
  1. "Done" — webhook is configured
  2. "I need help" — walk me through it step by step
```

## 7. Verify the Webhook

Start the server and test the webhook endpoint:

```bash
cd <archon-repo> && bun run dev &
sleep 3
curl -s http://localhost:3090/health
```

If health check returns `{"status":"ok"}`, also verify the ngrok tunnel is forwarding:

```bash
curl -s <ngrok-url>/health
```

Both should return `{"status":"ok"}`. If the ngrok check fails, make sure the ngrok terminal is still running.

Stop the background server when done verifying:
```bash
kill %1 2>/dev/null
```

## Notes

- **Free tier URLs change on restart** — you'll need to update the webhook URL in GitHub each time you restart ngrok.
- **Persistent URLs**: Use a paid ngrok plan, Cloudflare Tunnel, or cloud deployment (see `docs/cloud-deployment.md`).
- Both the **server** (`bun run dev`) and **ngrok** must be running for GitHub webhooks to work.
