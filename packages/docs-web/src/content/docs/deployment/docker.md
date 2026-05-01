---
title: Docker Guide
description: Deploy Archon with Docker, including automatic HTTPS, PostgreSQL, and the Web UI.
category: deployment
area: infra
audience: [operator]
status: current
sidebar:
  order: 2
---

Deploy Archon on a server with Docker. Includes automatic HTTPS, PostgreSQL, and the Web UI.

> **Claude Code is pre-installed in the image.** The official `ghcr.io/coleam00/archon` image
> ships with Claude Code installed via npm and `CLAUDE_BIN_PATH` pre-set — no extra configuration
> required. If you build a custom image that omits the npm install, set `CLAUDE_BIN_PATH` yourself
> to point at a mounted `cli.js` (see [AI Assistants → Binary path configuration](/getting-started/ai-assistants/#binary-path-configuration-compiled-binaries-only)).

---

## Cloud-Init (Fastest Setup)

The fastest way to deploy. Paste the cloud-init config into your VPS provider's **User Data** field when creating a server — it installs everything automatically.

**File:** `deploy/cloud-init.yml`

### How to use

1. **Create a VPS** (Ubuntu 22.04+ recommended) at DigitalOcean, AWS, Linode, Hetzner, etc.
2. **Paste** the contents of `deploy/cloud-init.yml` into the "User Data" / "Cloud-Init" field
3. **Add your SSH key** via the provider's UI
4. **Create the server** and wait ~5-8 minutes for setup to complete

### What it installs

- Docker + Docker Compose
- UFW firewall (ports 22, 80, 443)
- Clones the repo to `/opt/archon`
- Copies `.env.example` -> `.env` and `Caddyfile.example` -> `Caddyfile`
- Pre-pulls PostgreSQL and Caddy images
- Builds the Archon Docker image

### After boot

SSH into the server and finish configuration:

```bash
# Check setup completed
cat /opt/archon/SETUP_COMPLETE

# Edit credentials and domain
nano /opt/archon/.env

# Set at minimum:
#   CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...
#   DOMAIN=archon.example.com
#   DATABASE_URL=postgresql://postgres:postgres@postgres:5432/remote_coding_agent

# (Optional) Set up basic auth to protect Web UI:
# docker run caddy caddy hash-password --plaintext 'YOUR_PASSWORD'
# Add to .env: CADDY_BASIC_AUTH=basicauth @protected { admin $$2a$$14$$<hash> }

# Start
cd /opt/archon
docker compose --profile with-db --profile cloud up -d
```

> **Don't forget DNS**: Before starting, point your domain's A record to the server's IP.

### Provider-specific notes

| Provider | Where to paste cloud-init |
|----------|--------------------------|
| **DigitalOcean** | Create Droplet -> Advanced Options -> User Data |
| **AWS EC2** | Launch Instance -> Advanced Details -> User Data |
| **Linode** | Create Linode -> Add Tags -> Metadata (User Data) |
| **Hetzner** | Create Server -> Cloud config -> User Data |
| **Vultr** | Deploy -> Additional Features -> Cloud-Init User-Data |

---

## Local Docker Desktop (Windows / macOS)

Run Archon locally with Docker Desktop — no domain, no VPS required. Uses SQLite and the Web UI only.

### Quick start

```bash
git clone https://github.com/coleam00/Archon.git
cd Archon
cp .env.example .env
# Edit .env: set CLAUDE_CODE_OAUTH_TOKEN or CLAUDE_API_KEY
docker compose up -d
```

Access the Web UI at **http://localhost:3000**.

### Windows-specific notes

**Build from WSL, not PowerShell.** Docker Desktop on Windows cannot follow Bun workspace symlinks during the build context transfer. If you see `The file cannot be accessed by the system`, open a WSL terminal:

```bash
cd /mnt/c/Users/YourName/path/to/Archon
docker compose up -d
```

**Line endings:** The repo uses `.gitattributes` to force LF endings for shell scripts. If you cloned before this was added and see `exec docker-entrypoint.sh: no such file or directory`, re-clone or run:

```bash
git rm --cached -r .
git reset --hard
```

### What you get

| Feature | Status |
|---------|--------|
| Web UI | http://localhost:3000 |
| Database | SQLite (automatic, zero setup) |
| HTTPS / Caddy | Not needed locally |
| Auth | None (single-user, localhost only) |
| Platform adapters | Optional (Telegram, Slack, etc.) |

### Using PostgreSQL locally (optional)

```bash
docker compose --profile with-db up -d
```

Then add to `.env`:
```env
DATABASE_URL=postgresql://postgres:postgres@postgres:5432/remote_coding_agent
```

---

## Manual Server Setup

Step-by-step alternative if you prefer not to use cloud-init, or need more control.

### 1. Install Docker

```bash
# On Ubuntu/Debian
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER

# Log out and back in for group change to take effect
exit
# ssh back in

# Verify
docker --version
docker compose version
```

### 2. Clone the repo

```bash
git clone https://github.com/coleam00/Archon.git
cd Archon
```

### 3. Configure environment

```bash
cp .env.example .env
cp Caddyfile.example Caddyfile
nano .env
```

Set these values in `.env`:

```ini
# AI Assistant — at least one is required
# Option A: Claude OAuth token (run `claude setup-token` on your local machine to get one)
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-xxxxx
# Option B: Claude API key (from console.anthropic.com/settings/keys)
# CLAUDE_API_KEY=sk-ant-xxxxx

# Domain — your domain or subdomain pointing to this server
DOMAIN=archon.example.com

# Database — connect to the Docker PostgreSQL container
# Without this, the app uses SQLite (fine for getting started, but PostgreSQL recommended)
DATABASE_URL=postgresql://postgres:postgres@postgres:5432/remote_coding_agent

# Basic Auth (optional) — protects Web UI when exposed to the internet
# Skip if using IP-based firewall rules instead.
# Generate hash: docker run caddy caddy hash-password --plaintext 'YOUR_PASSWORD'
# CADDY_BASIC_AUTH=basicauth @protected { admin $$2a$$14$$... }

# Platform tokens (set the ones you use)
# TELEGRAM_BOT_TOKEN=123456789:ABCdef...
# SLACK_BOT_TOKEN=xoxb-...
# SLACK_APP_TOKEN=xapp-...
# GH_TOKEN=ghp_...
# GITHUB_TOKEN=ghp_...
```

> **Docker does not support `CLAUDE_USE_GLOBAL_AUTH=true`** — there is no local `claude` CLI inside the container. You must provide either `CLAUDE_CODE_OAUTH_TOKEN` or `CLAUDE_API_KEY` explicitly.
>
> **If you use `--profile with-db` without setting `DATABASE_URL`**, the app will fall back to SQLite and log a warning. The PostgreSQL container runs but is unused.

### 4. Point your domain to the server

Create a DNS **A record** at your domain registrar:

| Type | Name | Value |
|------|------|-------|
| A | `archon` (or `@` for root domain) | Your server's public IP |

Wait for DNS propagation (usually 5-60 minutes). Verify with `dig archon.example.com`.

### 5. Open firewall ports

```bash
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443
sudo ufw --force enable
```

### 6. Start

```bash
docker compose --profile with-db --profile cloud up -d
```

This starts three containers:
- **app** — Archon server + Web UI
- **postgres** — PostgreSQL 17 database (auto-initialized)
- **caddy** — Reverse proxy with automatic HTTPS (Let's Encrypt)

### 7. Verify

```bash
# Check all containers are running
docker compose --profile with-db --profile cloud ps

# Watch logs
docker compose logs -f app
docker compose logs -f caddy

# Test HTTPS (from your local machine)
curl https://archon.example.com/api/health
```

Open **https://archon.example.com** in your browser — you should see the Archon Web UI.

---

## Profiles

Archon uses Docker Compose profiles to optionally add PostgreSQL and/or HTTPS. Mix and match:

| Command | What runs |
|---------|-----------|
| `docker compose up -d` | App with SQLite |
| `docker compose --profile with-db up -d` | App + PostgreSQL |
| `docker compose --profile cloud up -d` | App + Caddy (HTTPS) |
| `docker compose --profile with-db --profile cloud up -d` | App + PostgreSQL + Caddy |

:::note
There is no `external-db` profile. When using an external PostgreSQL database (Supabase, Neon, etc.), just set `DATABASE_URL` in `.env` and run `docker compose up -d` without any profile. The base `app` service always starts.
:::

### No profile (SQLite)

Zero-config default. No database container needed — SQLite file is stored in the `archon_data` volume.

### `--profile with-db` (PostgreSQL)

Starts a PostgreSQL 17 container. Set the connection URL in `.env`:

```ini
DATABASE_URL=postgresql://postgres:postgres@postgres:5432/remote_coding_agent
```

The schema is auto-initialized on first startup. PostgreSQL is exposed on `${POSTGRES_PORT:-5432}` for external tools.

### `--profile cloud` (Caddy HTTPS)

Adds a [Caddy](https://caddyserver.com/) reverse proxy with automatic TLS certificates from Let's Encrypt.

**Requires before starting:**

1. `Caddyfile` created: `cp Caddyfile.example Caddyfile`
2. `DOMAIN` set in `.env`
3. DNS A record pointing to your server's IP
4. Ports 80 and 443 open

Caddy handles HTTPS certificates, HTTP->HTTPS redirect, HTTP/3, and SSE streaming.

### Authentication (Optional Basic Auth)

Caddy can enforce HTTP Basic Auth on all routes except webhooks (`/webhooks/*`) and the health check (`/api/health`). This is optional — skip it if you use IP-based firewall rules or other network-level access control.

**To enable:**

1. Generate a bcrypt password hash:

   ```bash
   docker run caddy caddy hash-password --plaintext 'YOUR_PASSWORD'
   ```

2. Set `CADDY_BASIC_AUTH` in `.env` (use `$$` to escape `$` in bcrypt hashes):

   ```ini
   CADDY_BASIC_AUTH=basicauth @protected { admin $$2a$$14$$abc123... }
   ```

3. Restart: `docker compose --profile cloud restart caddy`

Your browser will prompt for username/password when accessing the Archon URL. Webhook endpoints bypass auth since they use HMAC signature verification.

To disable, leave `CADDY_BASIC_AUTH` empty or unset — the Caddyfile expands it to nothing.

> **Important:** Always use the `docker run caddy caddy hash-password` command to generate hashes — never put plaintext passwords in `.env`.

### Form-Based Authentication (HTML Login Page)

An alternative to basic auth that serves a styled HTML login form instead of the browser's credential popup. Uses a lightweight `auth-service` sidecar and Caddy's `forward_auth` directive.

**When to use form auth vs basic auth:**
- **Form auth**: Styled dark-mode login page, 24h session cookie, logout support. Requires an extra container.
- **Basic auth**: Zero extra containers, simpler setup. Browser shows a native credential dialog.

**Setup:**

1. Generate a bcrypt password hash:

   ```bash
   docker compose --profile auth run --rm auth-service \
     node -e "require('bcryptjs').hash('YOUR_PASSWORD', 12).then(h => console.log(h))"
   ```

   > First run builds the auth-service image. Save the output hash (starts with `$2b$12$...`).

2. Generate a random cookie signing secret:

   ```bash
   docker run --rm node:22-alpine \
     node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

3. Set the following in `.env`:

   ```ini
   AUTH_USERNAME=admin
   AUTH_PASSWORD_HASH=$2b$12$REPLACE_WITH_YOUR_HASH
   COOKIE_SECRET=REPLACE_WITH_64_HEX_CHARS
   ```

4. Update `Caddyfile` (copy from `Caddyfile.example` if not done yet):

   - **Uncomment** the "Option A" form auth block (the `handle /login`, `handle /logout`, and `handle { forward_auth ... }` blocks)
   - **Comment out** the "No auth" default `handle` block (the last `handle { ... }` block near the bottom of the site block)

5. Start with both `cloud` and `auth` profiles:

   ```bash
   docker compose --profile with-db --profile cloud --profile auth up -d
   ```

6. Visit your domain — you should be redirected to `/login`.

**Logout:** Navigate to `/logout` to clear the session cookie and return to the login form.

**Session duration:** Defaults to 24 hours (`COOKIE_MAX_AGE=86400`). Override in `.env`:
```ini
COOKIE_MAX_AGE=3600  # 1 hour
```

> **Note:** Do not use form auth and basic auth simultaneously. Choose one method and leave the other disabled (either empty `CADDY_BASIC_AUTH` or remove the basic auth `@protected` block from your Caddyfile).

---

## Configuration

### Port Defaults

:::caution
Docker defaults to port **3000** (`${PORT:-3000}` in docker-compose.yml), while local development defaults to **3090**. Set `PORT` in `.env` to change the Docker port.
:::

The Docker healthcheck uses `/api/health` (not `/health`):

```bash
# Inside Docker
curl http://localhost:3000/api/health

# Local development (both work)
curl http://localhost:3090/health
curl http://localhost:3090/api/health
```

### AI Credentials (required)

Docker containers cannot use `CLAUDE_USE_GLOBAL_AUTH=true` — there is no local `claude` CLI inside the container. You must set credentials explicitly in `.env`:

**Claude (choose one):**

```ini
# OAuth token — run `claude setup-token` on your local machine, copy the token
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-xxxxx

# Or API key — from console.anthropic.com/settings/keys
CLAUDE_API_KEY=sk-ant-xxxxx
```

**Codex (alternative):**

```ini
CODEX_ID_TOKEN=eyJhbGc...
CODEX_ACCESS_TOKEN=eyJhbGc...
CODEX_REFRESH_TOKEN=rt_...
CODEX_ACCOUNT_ID=6a6a7ba6-...
```

### Platform Tokens (optional)

```ini
TELEGRAM_BOT_TOKEN=123456789:ABCdef...
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
DISCORD_BOT_TOKEN=...
GH_TOKEN=ghp_...
GITHUB_TOKEN=ghp_...
WEBHOOK_SECRET=...
```

### Server Settings (optional)

```ini
PORT=3000                          # Default: 3000
DOMAIN=archon.example.com          # Required for --profile cloud
LOG_LEVEL=info                     # fatal|error|warn|info|debug|trace
MAX_CONCURRENT_CONVERSATIONS=10
```

See `.env.example` for the full list with documentation.

### Data Directory

The container stores all data at `/.archon/` (workspaces, worktrees, artifacts, logs, SQLite DB).

By default this is a Docker-managed volume. To store data at a specific location on the host, set `ARCHON_DATA` in `.env`:

```ini
# Store Archon data at a specific host path
ARCHON_DATA=/opt/archon-data
```

:::note
`ARCHON_HOME` from `.env.example` is **ignored inside Docker** — the container always uses `/.archon`. Use `ARCHON_DATA` (host-side bind-mount source) to control *where on the host* `/.archon` lives. Both `ARCHON_HOME` and `ARCHON_DATA` leak into the container env via `env_file: .env`, which is harmless but expected.
:::

The directory is created automatically. Make sure the path is writable by UID 1001 (the container user):

```bash
mkdir -p /opt/archon-data
sudo chown -R 1001:1001 /opt/archon-data
```

If `ARCHON_DATA` is not set, Docker manages the volume automatically (`archon_data`) — data persists across restarts and rebuilds but lives inside Docker's storage.

### User Home Directory (Persisted)

The container runs as `appuser` with `$HOME=/home/appuser`. The base compose mounts `/home/appuser` as a named volume (`archon_user_home`) by default, so user-specific state survives container rebuilds without any operator action:

| Path | What it persists |
|------|------------------|
| `~/.claude/` | Claude Code skills, commands, agents, hooks, MCP config, projects (conversation history), memory, OAuth state, keybindings, file-history |
| `~/.codex/` | Codex auth (`auth.json` from interactive `codex login`; the env-var path via `setup-auth` overwrites this on every container start) |
| `~/.pi/agent/` | Pi `auth.json` from interactive `pi /login` (Archon's Pi adapter reads this on every request) |
| `~/.gitconfig` | Author identity, signing config, custom aliases, plus the `safe.directory` entries baked into the image |
| `~/.bash_history` | Shell history when you `docker compose exec app bash` |
| `~/.config/gh/` | GitHub CLI auth from interactive `gh auth login` (the `GH_TOKEN` env-var path works without it) |

To bind-mount a host path instead of the default named volume, set `ARCHON_USER_HOME` in `.env`:

```ini
ARCHON_USER_HOME=/opt/archon-user-home
```

The host path must be writable by UID 1001 — chown it once before first start:

```bash
mkdir -p /opt/archon-user-home
sudo chown -R 1001:1001 /opt/archon-user-home
```

The entrypoint re-applies ownership on every container start, so subsequent rebuilds work without re-running `chown`.

:::caution
Bind-mount paths do **not** inherit the image's baked `~/.gitconfig` (Docker only copies image content into named volumes on first creation, never into bind mounts). The entrypoint still registers git `safe.directory` entries for `/.archon/workspaces` and `/.archon/worktrees` repos at runtime, so functionality is preserved — but a bind-mounted `~/.gitconfig` starts empty and any author identity / signing config you want must be set explicitly with `git config --global` inside the container.
:::

If `ARCHON_USER_HOME` is not set, Docker manages the volume automatically (`archon_user_home`) — config persists across restarts and rebuilds but lives inside Docker's storage. To wipe it: `docker compose down && docker volume rm archon_archon_user_home`.

### GitHub CLI Authentication

`GH_TOKEN` from `.env` is picked up automatically. Alternatively:

```bash
docker compose exec app gh auth login
```

---

## GitHub Webhooks

After the server is reachable via HTTPS:

1. Go to `https://github.com/<owner>/<repo>/settings/hooks`
2. Add webhook:
   - **Payload URL**: `https://archon.example.com/webhooks/github`
   - **Content type**: `application/json`
   - **Secret**: Your `WEBHOOK_SECRET` from `.env`
   - **Events**: Issues, Issue comments, Pull requests

---

## Pre-built Image

For users who don't need to build from source:

```bash
mkdir archon && cd archon
curl -O https://raw.githubusercontent.com/coleam00/Archon/main/deploy/docker-compose.yml
curl -O https://raw.githubusercontent.com/coleam00/Archon/main/.env.example

cp .env.example .env
# Edit .env — set AI credentials, DOMAIN, etc.

docker compose up -d
```

Uses `ghcr.io/coleam00/archon:latest`. To add PostgreSQL, uncomment the `postgres` service in the compose file and set `DATABASE_URL` in `.env`.

To layer custom tools on top of the pre-built image, see [Customizing the Image](#customizing-the-image).

---

## Building the Image

The Dockerfile uses three stages:

1. **deps** — Installs all dependencies (including devDependencies for the web build)
2. **web-build** — Builds the React web UI with Vite
3. **production** — Production image with only production dependencies + pre-built web assets

```bash
docker build -t archon .
docker run --env-file .env -p 3000:3000 archon
```

**What's in the image:**

- **Runtime**: Bun 1.2 (runs TypeScript directly, no compile step)
- **System deps**: git, curl, gh (GitHub CLI), postgresql-client, Chromium
- **Browser tooling**: [agent-browser](https://github.com/vercel-labs/agent-browser) (Vercel Labs) — enables E2E testing workflows via CDP. Uses system Chromium (`AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium`)
- **App**: All 10 workspace packages (source), pre-built web UI
- **User**: Non-root `appuser` (UID 1001) — required by Claude Code SDK
- **Archon dirs**: `/.archon/workspaces`, `/.archon/worktrees`

The multi-stage build keeps the image lean — no devDependencies, test files, docs, or `.git/`.

### Customizing the Image

To add extra tools without modifying the tracked Dockerfile:

1. Copy the example:
   - **Local/dev**: `cp Dockerfile.user.example Dockerfile.user`
   - **Server/deploy**: `cp deploy/Dockerfile.user.example Dockerfile.user`
2. Edit `Dockerfile.user` — uncomment and extend the examples as needed.
3. Copy the override file:
   - **Local/dev**: `cp docker-compose.override.example.yml docker-compose.override.yml`
   - **Server/deploy**: `cp deploy/docker-compose.override.example.yml docker-compose.override.yml`
4. Run `docker compose up -d` — Compose merges the override automatically.

`Dockerfile.user` and `docker-compose.override.yml` are gitignored so your customizations stay local.

---

## Maintenance

### View Logs

```bash
docker compose logs -f              # All services
docker compose logs -f app          # App only
docker compose logs --tail=100 app  # Last 100 lines
```

### Update

```bash
git pull
docker compose --profile with-db --profile cloud up -d --build
```

### Restart

```bash
docker compose restart         # All
docker compose restart app     # App only
```

### Stop

```bash
docker compose down            # Stop containers (data preserved)
docker compose down -v         # Stop + delete volumes (destructive!)
```

### Database Migrations (PostgreSQL)

Migrations run automatically on first startup via `000_combined.sql`. When upgrading to a newer version that adds database tables, you need to apply incremental migrations manually:

```bash
# Example: apply the env vars migration (required when upgrading to v0.3.x)
docker compose exec postgres psql -U postgres -d remote_coding_agent -f /migrations/020_codebase_env_vars.sql
```

The `migrations/` directory is mounted read-only into the postgres container. Check for any new migration files after pulling updates.

### Clean Up Docker Resources

```bash
docker system prune -a         # Remove unused images/containers
docker volume prune            # Remove unused volumes (caution!)
docker system df               # Check disk usage
```

---

## Troubleshooting

### App won't start: "no_ai_credentials"

No AI assistant configured. Docker does not support `CLAUDE_USE_GLOBAL_AUTH=true`. Set one of these in `.env`:
- `CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...` (run `claude setup-token` locally to get one)
- `CLAUDE_API_KEY=sk-ant-...` (from console.anthropic.com)
- Or Codex credentials (`CODEX_ID_TOKEN`, `CODEX_ACCESS_TOKEN`, etc.)

### Caddy fails to start: "not a directory"

```
error mounting "Caddyfile": not a directory
```

The `Caddyfile` doesn't exist — Docker created a directory in its place. Fix:

```bash
rm -rf Caddyfile
cp Caddyfile.example Caddyfile
docker compose --profile cloud up -d
```

### Caddy not getting SSL certificate

```bash
# Check DNS propagation
dig archon.example.com
# Should return your server IP

# Check Caddy logs
docker compose logs caddy

# Check firewall
sudo ufw status
# Ports 80 and 443 must be open
```

Common causes: DNS not propagated (wait 5-60min), firewall blocking 80/443, domain typo in `.env`.

### Health check failing

The Docker healthcheck uses `/api/health` (not `/health`):

```bash
curl http://localhost:3000/api/health
```

### PostgreSQL connection refused

When using `--profile with-db`, ensure:

1. `DATABASE_URL` uses `postgres` as hostname (Docker service name), not `localhost`:
   ```ini
   DATABASE_URL=postgresql://postgres:postgres@postgres:5432/remote_coding_agent
   ```
2. The postgres container is healthy: `docker compose ps postgres`
3. Migrations ran: check `docker compose logs postgres` for init script output

### Permission errors in `/.archon/`

The container runs as `appuser` (UID 1001). If using bind mounts instead of Docker volumes:

```bash
sudo chown -R 1001:1001 /path/to/archon-data
```

### Port conflicts

Default Docker port is 3000 (local dev is 3090). Change in `.env`:

```ini
PORT=3001
```

### Container keeps restarting

```bash
docker compose ps
docker compose logs --tail=50 app
```

Common causes: missing `.env` file, invalid credentials, database unreachable.
