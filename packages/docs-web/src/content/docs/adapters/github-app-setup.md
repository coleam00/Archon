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
WEBHOOK_SECRET=<same value as on the GitHub side>

# Optional:
# GITHUB_APP_SLUG=archon-bot         # defaults to 'archon'; set this if you named your App
#                                    # differently. The bot's posted-comment login is `<slug>[bot]`.
# GITHUB_APP_INSTALLATION_ID=98765   # skip the per-(owner, repo) installation lookup when you only
#                                    # have one installation. Saves one HTTP round trip per new
#                                    # repo after a restart.
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

## Step 8 (optional): Enable per-user GitHub identity

By default every comment, commit, and push goes through the **bot** (`<slug>[bot]`). On a multi-user install you can let each teammate connect their own GitHub identity so those actions attribute to the human instead.

Enable the feature by adding two env vars on top of App mode:

```bash
# The App's Client ID (App settings → "Client ID", starts with Iv1./Iv23…).
# Distinct from the numeric GITHUB_APP_ID.
GITHUB_APP_CLIENT_ID=Iv23xxxxxxxxxxxx
# 32-byte key used to encrypt stored per-user tokens at rest (AES-256-GCM).
TOKEN_ENCRYPTION_KEY=$(openssl rand -hex 32)
```

Then, on the GitHub App settings page, enable **Device Flow** (under "Identifying and authorizing users"). The feature gate activates when `GITHUB_APP_ID` and `TOKEN_ENCRYPTION_KEY` are both set; `GITHUB_APP_CLIENT_ID` is required for the connect flow itself.

Teammates connect once via any surface:

- **CLI:** `archon auth github`
- **Slack:** `/archon connect github`
- **Web UI:** Settings → **Connect GitHub**

Once enabled:

- Workflows declaring `requires: [github]` **hard-block** unconnected users before any worktree/clone/AI cost.
- An unconnected user's workflow `gh`/`git` has its GitHub token **scrubbed** by default (rather than silently using the shared org/bot token). Opt back into the shared token with `ARCHON_ALLOW_ORG_GITHUB_TOKEN_FALLBACK=true`.
- Rotating `TOKEN_ENCRYPTION_KEY` invalidates all stored user tokens — everyone must reconnect.

This is fully backward compatible: leave the two vars unset and the App keeps working as the bot only. See the [configuration reference](/reference/configuration/#per-user-github-identity-app-mode-optional) for the full env var table.

## Operational notes

### Token rotation is invisible

Installation tokens are valid for 1h. Archon caches each `installation_id → token` pair and refreshes ~5 minutes before expiry on the next access. No background timer; no leaked handles.

### `event.installation.id` short-circuits the lookup

Every webhook delivery from a GitHub App carries `installation.id`. Archon primes its `owner/repo → installation_id` cache from the payload, so the next outbound call to that repo skips the `GET /repos/{owner}/{repo}/installation` round trip.

### 401 forces a single retry

A 401 from any installation Octokit evicts the cached token and the call is retried once with a fresh token. Persistent 401s propagate as the original error.

### Long-running workflow `git push`

Workflows that span >1h need a fresh token to push from the cloned worktree. Archon installs a git credential helper at clone time (App mode only): the worktree's `.git/config` points at `~/.archon/bin/git-credential-archon`, which talks back to Archon's internal endpoint for a fresh installation token on each operation.

> **Compiled binary builds:** the credential helper is installed from `scripts/git-credential-archon.sh` in the source tree. Compiled binaries that don't ship `scripts/` on disk silently skip the install — workflows up to 1h still succeed via the URL-embedded installation token and the `GH_TOKEN` env injection, but longer workflows will see `git push` fail with "Authentication failed" past the 1h mark. Track this when running App mode in a binary deployment.

### Internal endpoint security — REQUIRED

The credential-helper backend is exposed at `POST /internal/git-credential` and hands out live installation access tokens. **It MUST NOT be reachable from outside the Archon host.**

Archon enforces this at startup: with App mode active and the server bound to a non-loopback interface (e.g. `0.0.0.0`), the process **refuses to start** and exits with `github_app.internal_endpoint_public_bind_rejected`. Two correct configurations:

1. **Recommended (bare-metal / systemd) — bind Archon to `127.0.0.1`** (`HOST=127.0.0.1`) and put a reverse proxy in front. Configure the proxy to drop `/internal/*` paths.
2. **Opt-in escape hatch — `ARCHON_ALLOW_INTERNAL_ON_PUBLIC_BIND=1`** combined with `HOST=0.0.0.0` (or unset). Use ONLY when your reverse proxy already drops `/internal/*` AND your deployment topology genuinely requires the upstream to bind non-loopback (e.g. a container network where loopback isn't reachable from the proxy). **Docker / docker-compose deployments fall here** — the app container *must* bind `0.0.0.0` inside the container for docker-proxy to forward traffic, so option 1 isn't directly usable. See the [Canonical Docker setup](#canonical-docker-setup) below. Startup logs `github_app.internal_endpoint_exposed_acknowledged` so the choice is auditable.

Example Caddy snippet that drops `/internal/*` (bare-metal):

```caddyfile
example.com {
  @internal path /internal/*
  respond @internal 404
  reverse_proxy 127.0.0.1:3090
}
```

### Canonical Docker setup

The canonical Archon Docker stack (`docker-compose.yml` + `docker-compose.override.yml` + Caddy) publishes the app container's port `3000` and runs Caddy as a reverse proxy. Because the app container can't bind `127.0.0.1` and still have docker-proxy forward traffic to it, option 1 above isn't directly usable. Take option 2 with three layers of defense:

**1. In `docker-compose.override.yml` — bind the published host port to loopback only.**

```yaml
services:
  app:
    ports: !override
      - "127.0.0.1:${PORT:-3000}:${PORT:-3000}"
```

The `!override` tag (compose-spec) replaces the base file's `ports` list instead of merging. After this, port `3000` is reachable only via the Docker network (where Caddy lives) or from the host itself — not from the public internet.

**2. In `Caddyfile` — drop `/internal/*` requests.**

Insert this `handle` block before the fallthrough `handle { }` block:

```caddyfile
handle /internal/* {
  respond "Not Found" 404
}
```

Caddy evaluates `handle` blocks by path specificity, so `/internal/*` (more specific) wins over the generic fallthrough regardless of order.

**3. In `.env` — opt out of the loopback-bind guard.**

```ini
# Safe because:
#  1. docker-compose binds port 3000 to 127.0.0.1 only (override above)
#  2. Caddy drops /internal/* (handle block above)
ARCHON_ALLOW_INTERNAL_ON_PUBLIC_BIND=1
```

Without this flag, Archon refuses to start in App mode and exits with `github_app.internal_endpoint_public_bind_rejected`.

**Apply + verify:**

```sh
# Apply the override + Caddyfile + env changes, then restart app + caddy.
docker compose up -d --force-recreate app caddy

# From outside the host — must be 404/403 from the proxy.
# Use POST (the endpoint's actual method) — a GET probe can false-pass when
# the proxy 404s unmatched GETs while still forwarding the POST upstream.
curl -i -X POST https://your-archon/internal/git-credential \
  -H 'Content-Type: application/json' \
  -d '{"host":"github.com","path":"any/repo"}'

# On the host — port should bind to loopback only
ss -tlnp | grep :3000
# Expected: 127.0.0.1:3000   (NOT 0.0.0.0:3000)

# Startup log should contain:
docker compose logs app --tail 200 | grep "internal_endpoint_exposed_acknowledged"
# This event confirms the opt-out path was taken (audit trail).
```

If the external POST probe returns anything other than `404` or `403` from the proxy — i.e. anything that suggests the request reached the Archon process — **stop and fix the proxy config** before going live. The endpoint hands out live installation tokens to whoever can reach it.

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

### 401 loop on GitHub API calls

Repeated 401s on outbound API calls (`createComment`, `listComments`, `repos.get`, `pulls.get`) point at installation / token issues, not webhook config. Walk through:

- Verify the App is installed on the target `owner` and has not been suspended or uninstalled. Visit `https://github.com/settings/installations` (or the org equivalent) to confirm.
- Verify the App's permissions still include the scopes the operation needs (Contents:Read for clone; Issues:RW + Pull requests:RW for comments and reactions). Permission scope changes require operators to **review and accept** the new permissions on every installation; Archon will 401 until that's done.
- Verify the private key in your env (`GITHUB_APP_PRIVATE_KEY` or `_PATH`) matches the same App that `GITHUB_APP_ID` points at. Mismatched key+ID is a common cause of "401 from JWT" errors at token-issuance time.
- Verify `GITHUB_APP_INSTALLATION_ID` (if set) still corresponds to a live installation — uninstall + reinstall assigns a new ID.

### Webhook deliveries fail signature verification

A webhook-secret mismatch causes `github.signature_mismatch` / `github.signature_length_mismatch` errors at the `POST /webhooks/github` endpoint — distinct from outbound API 401s. If GitHub's webhook delivery page shows red ❌ next to the delivery (rather than your bot just silently not responding), check:

- `WEBHOOK_SECRET` in Archon's env matches the value entered in the GitHub App's webhook configuration page exactly.

### Bot comments still appear under your personal account

- You're still in PAT mode. Check `process.env.GITHUB_TOKEN` is unset and `GITHUB_APP_ID` is set; restart.

### Server refused to start: `github_app.internal_endpoint_public_bind_rejected`

- App mode is active but the server is bound to a non-loopback interface. This is a fail-fast guard — the `/internal/git-credential` endpoint hands out live installation access tokens and would leak credentials to the network. Either set `HOST=127.0.0.1` (bare-metal / systemd), or, if you're on Docker, follow the [Canonical Docker setup](#canonical-docker-setup) above (port→127.0.0.1 binding + Caddy `/internal/*` drop + `ARCHON_ALLOW_INTERNAL_ON_PUBLIC_BIND=1`).

### Server log shows `github_app.internal_endpoint_exposed_acknowledged`

- You set `ARCHON_ALLOW_INTERNAL_ON_PUBLIC_BIND=1`. Double-check that your reverse proxy actually drops `/internal/*` — a `curl https://your-archon/internal/git-credential -d '{"host":"github.com","path":"any/repo"}'` from outside the host must return 404 or 403 from the proxy (NOT a token from Archon). On the canonical Docker stack, also confirm `ss -tlnp | grep :3000` shows `127.0.0.1:3000` (not `0.0.0.0:3000`).
