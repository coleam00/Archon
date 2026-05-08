# GitLab Webhook Setup Guide

GitLab integration lets Archon respond to issue comments and MR comments with @mentions via webhooks. Works with gitlab.com and self-hosted GitLab instances.

**IMPORTANT — Freeform input rule**: This guide collects URLs, tokens, and usernames. **Never use AskUserQuestion for freeform text input** (URLs, tokens, usernames, paths). Ask the user directly in plain text — e.g., "Paste the ngrok URL here." Use AskUserQuestion **only** for multiple-choice decisions.

## 0. Check Existing .env Values

Before starting, check which GitLab-related values are already set:

```bash
cat <archon-repo>/.env
```

Check these keys: `GITLAB_TOKEN`, `GITLAB_WEBHOOK_SECRET`, `GITLAB_URL`, `GITLAB_ALLOWED_USERS`.

**If all are already filled in**: Tell the user "GitLab tokens are already configured in `.env`. Skipping to webhook setup." Jump to Step 5 (configure the project webhook).

**If some are filled in**: Tell the user which values are set and which are missing. Only collect the missing ones.

**If none are filled in**: Proceed with all steps.

## 1. Set Up a Public URL (ngrok)

GitLab webhooks need to reach your local server. Check if ngrok is installed:

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

## 3. Check for Self-Hosted GitLab

Ask in **plain text** (NOT AskUserQuestion):

> "Are you using gitlab.com or a self-hosted GitLab instance? If self-hosted, paste the base URL (e.g., `https://gitlab.example.com`)."

- If **gitlab.com**: no `GITLAB_URL` env var needed (it's the default).
- If **self-hosted**: store the URL as `<gitlab-url>` — it will be written to `GITLAB_URL`.

## 4. Generate a Webhook Secret

**Only if `GITLAB_WEBHOOK_SECRET` is empty/missing in `.env`.**

```bash
openssl rand -hex 32
```

Store this as `<webhook-secret>`.

> **Note**: GitLab sends this secret as a plain token in the `X-Gitlab-Token` header (not HMAC). Archon compares it directly using a timing-safe comparison.

## 5. Collect GitLab Token

**Only if `GITLAB_TOKEN` is empty/missing in `.env`.**

Ask the user in **plain text**:

> "I need a GitLab Personal Access Token (or Project/Group Access Token).
>
> To create one:
> - **gitlab.com**: Profile → Preferences → Access Tokens → Add new token
> - **Self-hosted**: `<gitlab-url>/-/user_settings/personal_access_tokens`
>
> Required scope: **`api`** (read/write access to issues and MR comments).
>
> Paste the token here when ready, or let me know if you've added it to `.env` directly."

Store the token as `<gitlab-token>`.

Optionally ask in plain text for an allowed-users list:

> "To restrict which GitLab users can trigger Archon, provide a comma-separated list of GitLab usernames (e.g., `alice,bob`). Leave blank to allow anyone who can comment on the project."

Store as `<allowed-users>` (may be empty).

## 6. Write to `.env`

Write only the **missing** values to `.env`. Do not overwrite existing values.

Values to set (if missing):
```env
GITLAB_TOKEN=<gitlab-token>
GITLAB_WEBHOOK_SECRET=<webhook-secret>
# Only set GITLAB_URL for self-hosted instances:
GITLAB_URL=<gitlab-url>
# Optional — omit to allow all users:
GITLAB_ALLOWED_USERS=<allowed-users>
```

## 7. Configure the Project Webhook

Tell the user to go to their **GitLab project** > **Settings** > **Webhooks** and add a new webhook:

- **URL**: `<ngrok-url>/webhooks/gitlab`
- **Secret token**: `<webhook-secret>` (the value from Step 4, or the existing value from `.env`)
- **Trigger events** (check all three):
  - **Comments** (note events — triggers on issue and MR comments)
  - **Issues events** (required for issue close cleanup)
  - **Merge request events** (required for MR merge/close cleanup)
- **SSL verification**: leave enabled (ngrok provides valid SSL)
- Click **Add webhook**

Use **AskUserQuestion** to confirm when done:
```
Header: "Webhook"
Question: "Have you added the webhook to your GitLab project?"
Options:
  1. "Done" — webhook is configured
  2. "I need help" — walk me through it step by step
```

## 8. Verify the Webhook

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

## Triggering Archon on GitLab

Once set up, mention `@Archon` (or the name configured in `GITLAB_BOT_MENTION`) in any issue or MR comment to trigger Archon. Example:

```
@Archon please investigate this bug and suggest a fix
```

Archon responds only to **comments**, not to issue/MR descriptions (which may contain example commands or documentation).

## Notes

- **Free tier ngrok URLs change on restart** — update the webhook URL in GitLab each time you restart ngrok.
- **Persistent URLs**: Use a paid ngrok plan, Cloudflare Tunnel, or cloud deployment.
- Both the **server** (`bun run dev`) and **ngrok** must be running for GitLab webhooks to work.
- **`GITLAB_BOT_MENTION`**: Defaults to `BOT_DISPLAY_NAME` or `archon`. Set this if your GitLab bot account has a different username.
- **Self-hosted tip**: Make sure the GitLab instance can reach your ngrok URL (some corporate self-hosted instances block external outbound webhooks).
