---
title: GitHub App Setup
description: Run Archon's bot identity as a registered GitHub App with multi-installation routing.
category: adapters
area: adapters
audience: [operator]
status: current
sidebar:
  order: 5
---

This is the recommended GitHub auth mode for teams sharing one Archon instance. It replaces the shared `GITHUB_TOKEN` PAT with a registered GitHub App so that:

- Bot comments appear as `archon[bot]` with the App badge, not under an operator's personal account.
- Installation access tokens rotate automatically every ~1h (smaller blast radius if leaked).
- Webhooks centralise — one URL per App covers every installation.
- A team's repos can span multiple GitHub orgs (or a mix of orgs and personal accounts) — Archon routes per-(owner, repo) to the right installation transparently.

Solo installs that only need the PAT model can ignore this page; see [GitHub](./github.md) for the legacy setup.

## When to use App mode vs. PAT mode

| Situation                                                           | Recommended mode |
| ------------------------------------------------------------------- | ---------------- |
| Solo developer, single GitHub account                               | PAT              |
| Team of 2+ sharing one Archon instance                              | App              |
| Repos across multiple orgs                                          | App              |
| You want bot comments to attribute as `<slug>[bot]` with App badge  | App              |
| You want short-lived (1h) tokens instead of long-lived PAT          | App              |

Archon refuses to start with **both** modes configured. Pick one set of env vars.

## Step 1: Register the GitHub App

1. Go to <https://github.com/settings/apps/new> (or `https://github.com/organizations/<org>/settings/apps/new` for an org-owned App).
2. Fill in:
   - **GitHub App name** — e.g. `Archon Bot`. The slug derived from this (visible in the App URL) is what you'll later set as `GITHUB_APP_SLUG`. Self-filter compares against `<slug>[bot]`.
   - **Homepage URL** — your team's Archon URL, e.g. `https://archon.example.com/`.
   - **Webhook URL** — `https://archon.example.com/webhooks/github`.
   - **Webhook secret** — same value as your `WEBHOOK_SECRET` env var.
3. Uncheck **Active** on the user authorisation callback URL — Archon doesn't use OAuth in PR-B.

## Step 2: Permissions (fine-grained)

**Repository permissions:**

| Permission       | Access       | Used for                                          |
| ---------------- | ------------ | ------------------------------------------------- |
| Contents         | Read         | Cloning + reading repo metadata                   |
| Issues           | Read & Write | `createComment` + `listComments`                  |
| Pull requests    | Read & Write | `pulls.get` + comment posting                     |
| Metadata         | Read         | Mandatory (auto-included)                         |

**Account permissions:** none.

## Step 3: Subscribe to webhook events

Subscribe to:

- Issue comments
- Pull request review comments
- Pull request
- Issues (used for `closed` cleanup)

## Step 4: Generate a private key

1. After saving the App, scroll to **Private keys** and click **Generate a private key**.
2. Save the downloaded `.pem` file in a location only readable by the Archon process — e.g. `/etc/archon/github-app.pem`.

## Step 5: Install the App

Install the App on every org or personal account that holds repos your team operates on:

1. From the App settings page, click **Install App**.
2. Pick the org → grant access to all repos (or selected repos).
3. Repeat for every org/account.

> **Multi-installation:** Archon resolves `owner/repo → installation_id` via `GET /repos/{owner}/{repo}/installation` automatically. No per-install config needed unless you're a single-install team — see `GITHUB_APP_INSTALLATION_ID` below.

## Step 6: Configure Archon

Add the following to your `.env` (or `~/.archon/.env`):

```dotenv
GITHUB_APP_ID=123456                 # numeric App ID, visible on the App settings page
GITHUB_APP_PRIVATE_KEY_PATH=/etc/archon/github-app.pem
GITHUB_APP_SLUG=archon-bot           # the slug from the App URL; e.g. https://github.com/apps/archon-bot
WEBHOOK_SECRET=<same value as on the GitHub side>

# Optional: skip the per-(owner, repo) installation lookup when you only have
# one installation. Saves one HTTP round trip per new repo after a restart.
# GITHUB_APP_INSTALLATION_ID=98765
```

### Inline private key (alternative)

If you can't write a file (e.g. a managed PaaS), set the PEM contents inline:

```dotenv
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----"
```

Archon normalises the literal `\n` sequence in `.env`-quoted values into real newlines.

### Unset the PAT

Archon refuses to start if both modes are configured. Remove `GITHUB_TOKEN` from your env when switching to App mode.

## Step 7: Restart Archon and verify

1. Restart the server.
2. Confirm the startup log shows `github.adapter_mode_app` with your slug.
3. Trigger a webhook from a repo where the App is installed (e.g. comment `@archon ping` on an issue).
4. Confirm the bot's reply appears as `<slug>[bot]` with the App badge in the GitHub UI.

## Operational notes

### Token rotation is invisible

Installation tokens are valid for 1h. Archon caches each `installation_id → token` pair and refreshes ~5 minutes before expiry on the next access. No background timer; no leaked handles.

### `event.installation.id` short-circuits the lookup

Every webhook delivery from a GitHub App carries `installation.id`. Archon primes its `owner/repo → installation_id` cache from the payload, so the next outbound call to that repo skips the `GET /repos/{owner}/{repo}/installation` round trip.

### 401 forces a single retry

A 401 from any installation Octokit evicts the cached token and the call is retried once with a fresh token. Persistent 401s propagate as the original error.

### Long-running workflow `git push`

Workflows that span >1h need a fresh token to push from the cloned worktree. Archon installs a git credential helper at clone time (App mode only): the worktree's `.git/config` points at `~/.archon/bin/git-credential-archon`, which talks back to Archon's internal endpoint for a fresh installation token on each operation.

### Internal endpoint security — IMPORTANT

The credential-helper backend is exposed at `POST /internal/git-credential` and hands out live installation access tokens. **It MUST NOT be reachable from outside the Archon host.** Two equally valid postures:

1. **Bind Archon to `127.0.0.1`** (`HOST=127.0.0.1`) and put a reverse proxy in front. The proxy MUST drop `/internal/*` paths.
2. **Bind to `0.0.0.0`** (default) but firewall the port so only loopback reaches it. The startup log emits `github_app.internal_endpoint_exposed_check_reverse_proxy` to remind you.

Example Caddy snippet that drops `/internal/*`:

```caddyfile
example.com {
  @internal path /internal/*
  respond @internal 404
  reverse_proxy 127.0.0.1:3090
}
```

## Migration from PAT mode

1. Register the App and install on your orgs (Steps 1–5 above).
2. Add `GITHUB_APP_*` env vars (Step 6).
3. **Remove** `GITHUB_TOKEN` from your env (or comment it out). Archon refuses to start if both are set.
4. Restart Archon.
5. Webhook URLs configured per-repo against the PAT-mode setup can stay or be removed — the App's single webhook URL covers everything once it's installed. New repos auto-join via App installation.

## Troubleshooting

### `AppPrivateKeyError: Provided value is not a valid PEM-encoded private key`

- Check the file content includes `-----BEGIN ... PRIVATE KEY-----` and `-----END ... PRIVATE KEY-----`.
- For inline keys, ensure the `.env` value preserves newlines (either literal newlines in a multi-line value or the `\n` escape inside double quotes).

### `AppNotInstalledError: The Archon GitHub App is not installed on "<owner>"`

- The App is not installed on that owner's org/account. Use the install link in the error message to add it.

### 401 loop in logs

- The webhook secret on the App doesn't match the `WEBHOOK_SECRET` env var. Verify both sides match.

### Bot comments still appear under your personal account

- You're still in PAT mode. Check `process.env.GITHUB_TOKEN` is unset and `GITHUB_APP_ID` is set; restart.

### Server log shows `github_app.internal_endpoint_exposed_check_reverse_proxy`

- The server is bound to a non-loopback interface with App mode active. Either bind to `127.0.0.1` or configure your reverse proxy to drop `/internal/*` — see the security note above.
