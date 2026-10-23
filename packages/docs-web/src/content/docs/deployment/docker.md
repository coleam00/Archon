---
title: Docker Guide
description: Run Archon with Docker Compose, locally or on a server with PostgreSQL and automatic HTTPS.
category: deployment
area: infra
audience: [operator]
status: current
sidebar:
  order: 2
---

This page installs and runs Archon with Docker Compose: on your own machine, or on a server with PostgreSQL and Caddy for automatic HTTPS. To prepare a VPS first (a user, SSH, the firewall and DNS), see [Cloud Deployment](/deployment/cloud/).

The image includes the Claude Code binary from the Claude Agent SDK. On start, the entrypoint points `CLAUDE_BIN_PATH` at it unless you set `CLAUDE_BIN_PATH` yourself.

## Cloud-init (fastest setup)

`deploy/cloud-init.yml` prepares a new VPS when it first boots. Paste its contents into the provider's User Data field when you create the server (Ubuntu 22.04+ or Debian 12+), add your SSH key, and point your domain's A record at the server's IP.

| Provider | Where to paste it |
|---|---|
| DigitalOcean | Create Droplet, Advanced Options, User Data |
| AWS EC2 | Launch Instance, Advanced Details, User Data |
| Linode | Create Linode, Add Tags, Metadata (User Data) |
| Hetzner | Create Server, Cloud config, User Data |
| Vultr | Deploy, Additional Features, Cloud-Init User-Data |

The script installs Docker, opens ports 22, 80 and 443 (TCP, plus UDP 443 for HTTP/3), adds a 2 GB swapfile, clones the repository to `/opt/archon`, copies `.env.example` to `.env` and `Caddyfile.example` to `Caddyfile`, and builds the image. It also creates an `archon` user with Docker access but no sudo, and copies your SSH key to it. Use the default cloud user or root for system maintenance.

Setup takes 5 to 8 minutes and writes `/opt/archon/SETUP_COMPLETE` when it finishes. Then:

```bash
ssh archon@your-server-ip
nano /opt/archon/.env          # see "Configure .env" below
cd /opt/archon
docker compose --profile with-db --profile cloud up -d
```

## Local Docker Desktop (Windows and macOS)

Run Archon on your own machine with SQLite and the Web UI. No domain or VPS is needed.

```bash
git clone https://github.com/coleam00/Archon.git
cd Archon
cp .env.example .env           # set a Claude or Codex credential
docker compose up -d
```

Open `http://localhost:3000`. Add `--profile with-db` to use the PostgreSQL container instead of SQLite (see [Profiles](#profiles)).

On Windows, build from a WSL terminal (for example in `/mnt/c/Users/YourName/path/to/Archon`), not PowerShell. Docker Desktop cannot follow Bun workspace symlinks from a Windows build context and fails with `The file cannot be accessed by the system`. If the container fails with `exec docker-entrypoint.sh: no such file or directory`, the checkout has CRLF line endings. `.gitattributes` forces LF for shell scripts, so re-clone the repository.

## Manual server setup

Use this instead of cloud-init when you want each step under your control. Prepare the server with [Cloud Deployment](/deployment/cloud/) first.

1. Install Docker, then log out and back in so the group change applies:

   ```bash
   curl -fsSL https://get.docker.com | sh
   sudo usermod -aG docker $USER
   ```

2. Clone the repository and create the config files:

   ```bash
   git clone https://github.com/coleam00/Archon.git
   cd Archon
   cp .env.example .env
   cp Caddyfile.example Caddyfile
   ```

3. Edit `.env` as described in [Configure .env](#configure-env).

4. Start the app, PostgreSQL and Caddy:

   ```bash
   docker compose --profile with-db --profile cloud up -d
   ```

5. Check it:

   ```bash
   docker compose --profile with-db --profile cloud ps
   docker compose logs -f app
   curl https://archon.example.com/api/health    # from your machine
   ```

## Pre-built image

To run `ghcr.io/coleam00/archon:latest` without building from source:

```bash
mkdir archon && cd archon
curl -O https://raw.githubusercontent.com/coleam00/Archon/main/deploy/docker-compose.yml
curl -O https://raw.githubusercontent.com/coleam00/Archon/main/.env.example
cp .env.example .env           # see "Configure .env" below
docker compose up -d
```

This compose file has only the app service. To add PostgreSQL, uncomment the `postgres` service and the `postgres_data` volume, and set `DATABASE_URL`. It has no Caddy service.

### Verify image attestations

Published images carry BuildKit provenance and SPDX SBOM attestations. Resolve the tag to a digest, then inspect that digest so the image cannot change between inspection and deployment:

```bash
docker buildx imagetools inspect ghcr.io/coleam00/archon:latest
# Copy the top-level Digest, not a platform manifest's digest.
image='ghcr.io/coleam00/archon@sha256:<digest>'
docker buildx imagetools inspect "$image" --format '{{ json .Provenance }}'
docker buildx imagetools inspect "$image" --format '{{ json .SBOM }}'
```

Both results must be non-empty: each platform has a `SLSA` provenance object and an `SPDX` SBOM object. In the provenance, check three things:

- The source is `https://github.com/coleam00/Archon` and the revision is the release commit you intend to run. Current releases record them in `buildDefinition.externalParameters.request.args` as `label:org.opencontainers.image.source` and `label:org.opencontainers.image.revision`. Older BuildKit versions use `invocation.configSource` and `invocation.environment`.
- The workflow ref in `buildDefinition.internalParameters.github_workflow_ref` names `.github/workflows/publish.yml` at the expected ref.
- The builder ID (`builder.id` or `runDetails.builder.id`) links to the GitHub Actions run.

The package inventory is under `SPDX.packages`. The `unknown/unknown` entries in the manifest list are the attestation manifests. The attestations are unsigned metadata, so they do not authenticate the publisher by themselves. See [Docker's provenance documentation](https://docs.docker.com/build/metadata/attestations/slsa-provenance/).

## Configure .env

Docker Compose reads the repository's `.env`. Edit it directly. Don't run `archon setup` for a Docker install: the wizard writes Archon's CLI env files, not this one. `.env.example` documents every variable.

### AI credentials

Set at least one provider:

```ini
# Claude: an OAuth token from `claude setup-token` on your own machine
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-xxxxx
# or an API key from console.anthropic.com
# CLAUDE_API_KEY=sk-ant-xxxxx

# Codex: values from ~/.codex/auth.json after `codex login`
# ARCHON_CODEX_ID_TOKEN=eyJhbGc...
# ARCHON_CODEX_ACCESS_TOKEN=eyJhbGc...
# ARCHON_CODEX_REFRESH_TOKEN=rt_...
# ARCHON_CODEX_ACCOUNT_ID=6a6a7ba6-...
```

`.env.example` sets `CLAUDE_USE_GLOBAL_AUTH=true`. That flag only satisfies the server's startup check: it tells Archon to rely on a `claude /login` session, and a fresh container has none. Set a token or key. When one is set, Archon uses it whatever the flag says. See [AI Assistants](/getting-started/ai-assistants/) for every provider.

### Server, domain and database

| Variable | Default in Docker | Purpose |
|---|---|---|
| `PORT` | `3000` | App port, published on the host. Local development defaults to 3090. |
| `DOMAIN` | none | Public hostname. Required for `--profile cloud`. |
| `DATABASE_URL` | unset (SQLite) | PostgreSQL connection string. |
| `POSTGRES_PORT` | `5432` | Host port for the PostgreSQL container, bound to `127.0.0.1`. |
| `LOG_LEVEL` | `info` | `fatal`, `error`, `warn`, `info`, `debug` or `trace`. |

For the PostgreSQL container, use the service name as the host:

```ini
DATABASE_URL=postgresql://postgres:postgres@postgres:5432/remote_coding_agent
```

Platform tokens (`TELEGRAM_BOT_TOKEN`, `SLACK_BOT_TOKEN`, `GH_TOKEN`, `WEBHOOK_SECRET` and so on) are covered in each adapter's page under [Adapters](/adapters/). For a GitHub webhook, the payload URL is `https://archon.example.com/webhooks/github`; see [GitHub](/adapters/github/).

## Profiles

Compose profiles add PostgreSQL, HTTPS or form login to the base app service:

| Command | What runs |
|---|---|
| `docker compose up -d` | App with SQLite |
| `docker compose --profile with-db up -d` | App and PostgreSQL 17 |
| `docker compose --profile cloud up -d` | App and Caddy |
| `docker compose --profile with-db --profile cloud up -d` | App, PostgreSQL and Caddy |

Add `--profile auth` for the [form login sidecar](#form-login-sidecar). For an external database such as Supabase or Neon, set `DATABASE_URL` and use no database profile. There is no `external-db` profile.

- **No profile:** SQLite, stored in the data volume at `/.archon/archon.db`.
- **`with-db`:** a PostgreSQL 17 container. The app creates and upgrades the schema on every start. If you start this profile without setting `DATABASE_URL`, the app logs a warning and uses SQLite, and the container sits unused.
- **`cloud`:** [Caddy](https://caddyserver.com/) in front of the app, with Let's Encrypt certificates, HTTP to HTTPS redirects, HTTP/3 and unbuffered `/api/stream/*` for live updates. It needs a `Caddyfile` (copied from `Caddyfile.example`), `DOMAIN` set, the DNS A record in place, and ports 80 and 443 open. Caddy waits for the app's health check before it starts.

## Protect the Web UI

A Web UI on a public domain needs a login. Choose one of these:

- **Better Auth** (PostgreSQL only, recommended): per-user accounts, and the server rejects every `/api/*` request without a session. Set `BETTER_AUTH_SECRET`; see [Web UI login](/reference/configuration/#web-ui-login-better-auth-optional). Signup is closed by default: invite people with `ARCHON_AUTH_ALLOWED_EMAILS`, or open it with `ARCHON_AUTH_OPEN_SIGNUP=true`. With Better Auth on, you don't need either Caddy option below; the [Security reference](/reference/security/#adapter-authorization) explains how to retire them.
- **Caddy basic auth:** the browser's own login prompt, with no extra container.
- **Form login sidecar:** a styled login page and a session cookie, served by the `auth-service` container.

Use one Caddy option at a time, not both. Caddy always leaves `/webhooks/*` and `/api/health` open, and webhooks verify their own signatures. Caddy answers `/internal/*` with a 404 and never forwards it.

### Caddy basic auth

1. Generate a bcrypt hash. Never put a plaintext password in `.env`.

   ```bash
   docker run --rm caddy caddy hash-password --plaintext 'YOUR_PASSWORD'
   ```

2. Set `CADDY_BASIC_AUTH` in `.env`. Replace `admin` with your username and paste the complete hash unchanged:

   ```ini
   CADDY_BASIC_AUTH='basic_auth @protected {
     admin REPLACE_WITH_COMPLETE_HASH_OUTPUT
   }'
   ```

   This is a single-quoted multiline Compose value, so newlines and `$` characters survive as written. Don't double the dollar signs, and don't source the file in a shell. See [Compose interpolation](https://docs.docker.com/compose/how-tos/environment-variables/variable-interpolation/) and [Caddy's basic_auth](https://caddyserver.com/docs/caddyfile/directives/basic_auth).

3. Recreate Caddy so it reads the new value:

   ```bash
   docker compose --profile cloud up -d --force-recreate caddy
   ```

To turn it off, leave `CADDY_BASIC_AUTH` empty or unset.

### Form login sidecar

1. Generate a bcrypt hash. The first run builds the `auth-service` image.

   ```bash
   docker compose --profile auth run --rm auth-service \
     node -e "require('bcryptjs').hash('YOUR_PASSWORD', 12).then(h => console.log(h))"
   ```

2. Generate a cookie signing secret:

   ```bash
   docker run --rm node:22-alpine \
     node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

3. Set them in `.env`, writing every `$` in the hash as `$$` so Compose does not interpolate it:

   ```ini
   AUTH_USERNAME=admin
   AUTH_PASSWORD_HASH=$$2b$$12$$REPLACE_WITH_YOUR_HASH
   COOKIE_SECRET=REPLACE_WITH_64_HEX_CHARS
   # COOKIE_MAX_AGE=86400   # session length in seconds
   ```

4. In `Caddyfile`, uncomment the Option A block (`handle /login`, `handle /logout` and the `forward_auth` handle), and comment out the "No auth" `handle` block below it.

5. Start with the `auth` profile:

   ```bash
   docker compose --profile with-db --profile cloud --profile auth up -d
   ```

Your domain now redirects to `/login`. Visit `/logout` to end the session.

## Data and home volumes

The container keeps Archon's data in `/.archon`: workspaces, worktrees, artifacts, logs, plugins and the SQLite database. The user's home, `/home/appuser`, holds provider and tool state:

| Path | What it holds |
|---|---|
| `~/.claude/` | Claude Code skills, commands, agents, hooks, MCP config, sessions, memory and OAuth state |
| `~/.codex/` | Codex `auth.json` from `codex login`. With the `ARCHON_CODEX_*` variables set, startup overwrites it each time. |
| `~/.pi/agent/` | Pi `auth.json` from `pi /login`, `models.json`, `settings.json` and sessions |
| `~/.gitconfig` | Git identity, signing config, aliases and `safe.directory` entries |
| `~/.config/gh/` | GitHub CLI login from `gh auth login` |
| `~/.bash_history` | Shell history from `docker compose exec app bash` |

Both are Docker named volumes by default (`archon_data` and `archon_user_home`), so they survive restarts and rebuilds. To keep them at a host path instead, set `ARCHON_DATA` or `ARCHON_USER_HOME` in `.env`, and make the directory writable by UID 1001, the container user:

```bash
sudo mkdir -p /opt/archon-data /opt/archon-user-home
sudo chown -R 1001:1001 /opt/archon-data /opt/archon-user-home
```

```ini
ARCHON_DATA=/opt/archon-data
ARCHON_USER_HOME=/opt/archon-user-home
```

On every start the entrypoint fixes ownership of both paths, touching only files with the wrong owner.

- `ARCHON_HOME` has no effect inside the container, which always uses `/.archon`. Use `ARCHON_DATA` to choose where that lives on the host.
- A bind-mounted home starts with an empty `~/.gitconfig`, because Docker copies image content into new named volumes but never into bind mounts. The entrypoint still adds the `safe.directory` entries Archon needs. Set your Git identity with `git config --global` inside the container.
- `safe.directory` entries added at runtime stay in the home volume, even after the checkout is gone. Archon never removes them, because concurrent setup may rely on the same entry. See [Git directory trust](/reference/security/#git-directory-trust).
- To keep Pi's data on the data volume, set `PI_CODING_AGENT_DIR=/.archon/pi` before the container starts.
- To wipe the home volume: `docker compose down && docker volume rm archon_archon_user_home`.

### Root fallback for macOS bind mounts

On a macOS bind mount (VirtioFS), the ownership fix always fails: the host will not remap files to UID 1001. The entrypoint prints the `chown` error and exits 1, so the container restarts in a loop. Read-only mounts and SELinux or AppArmor denials on Linux fail the same way.

`ARCHON_ALLOW_ROOT_FALLBACK=1` in `.env` makes the entrypoint print a warning and keep running as root instead. Any other value, or none, keeps the exit. The variable does nothing when the ownership fix succeeds.

:::caution
Running as root also sets `IS_SANDBOX=1`, which disables the Claude provider's refusal to run `bypassPermissions` as root, so AI subprocesses run as root in the container. That is acceptable on a single-operator Mac where the bind mount already limits what the container can reach. On Linux the failure means the volume ownership is wrong: run `sudo chown -R 1001:1001 <path>` on the host instead.
:::

## GitHub credentials

The container uses `GH_TOKEN` from `.env`. You can also log in inside the container, and the login lands on the home volume:

```bash
docker compose exec -u appuser -e HOME=/home/appuser app gh auth login
```

- With `GH_TOKEN` set and GitHub App mode off, every start resets Git's `https://github.com` credential helper to one that uses `GH_TOKEN`. A helper written by `gh auth login` applies only without `GH_TOKEN`.
- In [GitHub App mode](/adapters/github-app-setup/) (`GITHUB_APP_ID`, a private key and `WEBHOOK_SECRET` set, `GITHUB_TOKEN` unset), startup removes only the PAT helper that the entrypoint wrote earlier. An incomplete App configuration leaves it in place. Other helpers are yours and stay.
- The entrypoint reads these variables from the container environment, not from `/.archon/.env`. Keep `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` or `GITHUB_APP_PRIVATE_KEY_PATH`, `WEBHOOK_SECRET`, `GITHUB_TOKEN` and `GH_TOKEN` in the compose `.env`. If they are only in `/.archon/.env`, the server runs in App mode while clones keep using the old PAT.
- With `ARCHON_SDLC_FORGE=gh`, delete an empty `GH_TOKEN=` line. The SDLC workflows refuse an empty `GH_TOKEN` when `GITHUB_TOKEN` is unset, rather than let `gh` fall back to the stored login.

## Plugins

Install plugins inside the running container, as `appuser` so the server owns the files:

```bash
docker compose exec -u appuser app bun run cli plugin add coleam00/Archon/plugins/forge-github
docker compose exec -u appuser app bun run cli plugin add Wirasm/archon-video
```

`plugin update`, `plugin remove` and `plugin list` work the same way. Plugins live in `/.archon/plugins` on the data volume, so they survive restarts and rebuilds. See [Forge operations](/reference/forge/#install-the-github-plugin) and [Installed workflow packs](/guides/global-workflows/#installed-workflow-packs).

The bundled SDLC workflows use `gh` by default. To use the forge plugin instead, set `ARCHON_SDLC_FORGE=forge` and install forge-github v0.12.1 or later; some pack steps still need `gh`. The plugin looks for `GH_TOKEN`, then `GITHUB_TOKEN`, then the container's `gh` login. Your host's `gh` login is not visible inside the container. See [Use the forge path in the SDLC pack](/reference/forge/#use-the-forge-path-in-the-sdlc-pack).

The image includes a verified Slack plugin outside the data volume. When `SLACK_BOT_TOKEN` is set, in the container environment or in `/.archon/.env`, the entrypoint installs it offline into `/.archon/plugins` before the server starts, and logs the release and commit. You don't run `plugin add` for Slack. Slack still needs both `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` to connect; see [Slack](/adapters/slack/).

- An installed, verified Slack plugin stays as it is, including a release you pinned from another source. The image does not update it.
- Missing or changed Slack executables, ownership conflicts, or a broken image receipt when a new install is needed stop provisioning with an error in the boot logs. Repair the install before restarting.
- To turn Slack off, remove its tokens from every env source, run `docker compose exec -u appuser app bun run cli plugin remove coleam00/Archon/plugins/chat-slack`, and restart. Removing only the plugin reinstalls it on the next start. Removing only the tokens leaves it installed and reporting missing credentials.

The image has `git` and Bun, but not `uv`, Python, or tools a pack's scripts call, such as ffmpeg. Add them with [Dockerfile.user](#customizing-the-image).

## Container isolation is unavailable

`archon workflow run ... --container` starts a sibling Docker container for each run. Inside this compose stack it fails at preflight with "Cannot connect to the Docker daemon": the image has no `docker` CLI, and the stack does not mount `/var/run/docker.sock`. Worktree isolation and in-place folder runs work normally.

:::caution
Mounting the Docker socket into the app container is not part of the supported stack. The socket is root-equivalent: anything that can reach it can start a privileged container and take over the host. If you accept that on a single-operator host, read `packages/isolation/docker/SECURITY.md` first. To use `--container` without that risk, run Archon directly on a host with a local Docker daemon.
:::

## Building the image

```bash
docker build -t archon .
docker run --env-file .env -e ARCHON_DOCKER=true -p 3000:3000 archon
```

The Dockerfile builds in these stages:

1. `manifests` and `sources` derive the workspace layout from `packages/`, so a new package needs no Dockerfile edit.
2. `deps` installs all dependencies, including the dev dependencies the web build needs.
3. `image-plugins` downloads the pinned Slack release, checks its commit and checksum, and records a verified receipt.
4. `web-build` builds the Web UI with Vite.
5. `production` keeps production dependencies and the built Web UI.

The production image runs Bun as the non-root `appuser` (UID 1001), which Claude Code requires. It includes `git`, `curl`, `gh`, `postgresql-client`, `ripgrep`, `jq`, Chromium and [agent-browser](https://github.com/vercel-labs/agent-browser), which drives the system Chromium for browser testing. It ships the source of every workspace package except `docs-web`, `web` (only the built UI ships) and `chat-slack` (shipped as the verified release under `/opt/archon/image-plugins`).

The Slack release is pinned separately from Archon's version by the build args `SLACK_PLUGIN_TAG` (default `v0.12.1`) and `SLACK_PLUGIN_COMMIT` (default `5f2b4841aaca38180c0abbd32bc6345593292019`). Override both together; the build rejects a tag that resolves to a different commit. Downloads happen only at build time.

### Customizing the image

To add tools without editing the tracked Dockerfile:

1. Copy `Dockerfile.user.example` to `Dockerfile.user` (use `deploy/Dockerfile.user.example` for a server deploy) and edit it.
2. Copy `docker-compose.override.example.yml` to `docker-compose.override.yml` (or `deploy/docker-compose.override.example.yml`).
3. Run `docker compose up -d`. Compose merges the override file automatically.

Both files are gitignored, so your changes stay local.

## Maintenance

```bash
docker compose logs -f app            # follow app logs
docker compose logs --tail=100 app    # last 100 lines
docker compose restart app
docker compose down                   # stop, keep data
docker compose down -v                # stop and delete volumes, including data
docker system df                      # Docker disk usage
```

### Update

```bash
git pull
docker compose --profile with-db --profile cloud up -d --build
```

Use the same profiles you deployed with. The app applies schema changes on startup: it runs the idempotent `migrations/000_combined.sql` under a PostgreSQL advisory lock, so there is no manual migration step.

## Troubleshooting

### App exits with `no_ai_credentials`

The server found no Claude credential and no Codex credential. Set `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_API_KEY`, or `ARCHON_CODEX_ID_TOKEN` with `ARCHON_CODEX_ACCESS_TOKEN`. See [AI credentials](#ai-credentials).

### Caddy fails with "not a directory"

```
error mounting "Caddyfile": not a directory
```

`Caddyfile` did not exist, so Docker created a directory in its place:

```bash
rm -rf Caddyfile
cp Caddyfile.example Caddyfile
docker compose --profile cloud up -d
```

### Caddy gets no certificate

Check that `dig archon.example.com` returns the server's IP, that `sudo ufw status` shows 80 and 443 open, and that `DOMAIN` in `.env` is spelled right. Then read `docker compose logs caddy`. DNS changes can take up to an hour to propagate.

### Health check fails

The container health check calls `/api/health` on `PORT`, not `/health`:

```bash
curl http://localhost:3000/api/health
```

### PostgreSQL connection refused

With `--profile with-db`, `DATABASE_URL` must use the service name `postgres` as the host, not `localhost`. Check the container with `docker compose ps postgres`.

### Permission errors in `/.archon`

The entrypoint exits 1 with the `chown` error when it cannot give `/.archon` or `/home/appuser` to UID 1001. On Linux with a bind mount, run `sudo chown -R 1001:1001 /path/to/archon-data` on the host. On a macOS bind mount, `chown` on the host does not help; see [Root fallback for macOS bind mounts](#root-fallback-for-macos-bind-mounts).

### Port already in use

Set another `PORT` in `.env`, such as `PORT=3001`.

### Container keeps restarting

Run `docker compose ps` and `docker compose logs --tail=50 app`. The usual causes are a missing `.env`, an invalid credential or an unreachable database.
