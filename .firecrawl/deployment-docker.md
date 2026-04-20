[Skip to content](https://archon.diy/deployment/docker/#_top)

[Archon](https://archon.diy/)

Search `CtrlK`

Cancel

Clear

[GitHub](https://github.com/coleam00/Archon)

Select themeDarkLightAuto

- The Book of Archon
  - [The Book of Archon](https://archon.diy/book/)
  - [What Is Archon?](https://archon.diy/book/what-is-archon/)
  - [Your First Five Minutes](https://archon.diy/book/first-five-minutes/)
  - [How Archon Actually Works](https://archon.diy/book/how-it-works/)
  - [The Essential Workflows](https://archon.diy/book/essential-workflows/)
  - [Isolation and Worktrees](https://archon.diy/book/isolation/)
  - [Creating Your First Command](https://archon.diy/book/first-command/)
  - [Creating Your First Workflow](https://archon.diy/book/first-workflow/)
  - [DAG Workflows](https://archon.diy/book/dag-workflows/)
  - [Hooks and Quality Loops](https://archon.diy/book/hooks-and-quality/)
  - [Quick Reference](https://archon.diy/book/quick-reference/)

- Getting Started
  - [Installation](https://archon.diy/getting-started/installation/)
  - [Getting Started](https://archon.diy/getting-started/overview/)
  - [Core Concepts](https://archon.diy/getting-started/concepts/)
  - [Quick Start](https://archon.diy/getting-started/quick-start/)
  - [Configuration](https://archon.diy/getting-started/configuration/)
  - [AI Assistants](https://archon.diy/getting-started/ai-assistants/)

- Guides
  - [Guides](https://archon.diy/guides/)
  - [Authoring Workflows](https://archon.diy/guides/authoring-workflows/)
  - [Authoring Commands](https://archon.diy/guides/authoring-commands/)
  - [Loop Nodes](https://archon.diy/guides/loop-nodes/)
  - [Approval Nodes](https://archon.diy/guides/approval-nodes/)
  - [Per-Node Hooks](https://archon.diy/guides/hooks/)
  - [Per-Node MCP Servers](https://archon.diy/guides/mcp-servers/)
  - [Per-Node Skills](https://archon.diy/guides/skills/)
  - [Global Workflows](https://archon.diy/guides/global-workflows/)
  - [Remotion Video Generation Workflow](https://archon.diy/guides/remotion-workflow/)

- Adapters
  - [Platform Adapters](https://archon.diy/adapters/)
  - [Web UI](https://archon.diy/adapters/web/)
  - [Slack](https://archon.diy/adapters/slack/)
  - [Telegram](https://archon.diy/adapters/telegram/)
  - [GitHub](https://archon.diy/adapters/github/)
  - community
    - [Discord](https://archon.diy/adapters/community/discord/)
    - [Gitea](https://archon.diy/adapters/community/gitea/)
    - [GitLab](https://archon.diy/adapters/community/gitlab/)

- Deployment
  - [Deployment Overview](https://archon.diy/deployment/)
  - [Local Development](https://archon.diy/deployment/local/)
  - [Docker Guide](https://archon.diy/deployment/docker/)
  - [Cloud Deployment](https://archon.diy/deployment/cloud/)
  - [Windows Setup](https://archon.diy/deployment/windows/)
  - [E2E Testing](https://archon.diy/deployment/e2e-testing/)
  - [E2E Testing on WSL](https://archon.diy/deployment/e2e-testing-wsl/)

- Reference
  - [Reference](https://archon.diy/reference/)
  - [Architecture](https://archon.diy/reference/architecture/)
  - [Archon Directories](https://archon.diy/reference/archon-directories/)
  - [CLI Reference](https://archon.diy/reference/cli/)
  - [Commands Reference](https://archon.diy/reference/commands/)
  - [Database](https://archon.diy/reference/database/)
  - [Variable Reference](https://archon.diy/reference/variables/)
  - [API Reference](https://archon.diy/reference/api/)
  - [Configuration Reference](https://archon.diy/reference/configuration/)
  - [Troubleshooting](https://archon.diy/reference/troubleshooting/)
  - [Security](https://archon.diy/reference/security/)

- Contributing
  - [Contributing](https://archon.diy/contributing/)
  - [New Developer Guide](https://archon.diy/contributing/new-developer-guide/)
  - [CLI Internals](https://archon.diy/contributing/cli-internals/)
  - [Releasing](https://archon.diy/contributing/releasing/)
  - [DX Quirks](https://archon.diy/contributing/dx-quirks/)

[GitHub](https://github.com/coleam00/Archon)

Select themeDarkLightAuto

On this page

- [Overview](https://archon.diy/deployment/docker/#_top)
- [Cloud-Init (Fastest Setup)](https://archon.diy/deployment/docker/#cloud-init-fastest-setup)
  - [How to use](https://archon.diy/deployment/docker/#how-to-use)
  - [What it installs](https://archon.diy/deployment/docker/#what-it-installs)
  - [After boot](https://archon.diy/deployment/docker/#after-boot)
  - [Provider-specific notes](https://archon.diy/deployment/docker/#provider-specific-notes)
- [Local Docker Desktop (Windows / macOS)](https://archon.diy/deployment/docker/#local-docker-desktop-windows--macos)
  - [Quick start](https://archon.diy/deployment/docker/#quick-start)
  - [Windows-specific notes](https://archon.diy/deployment/docker/#windows-specific-notes)
  - [What you get](https://archon.diy/deployment/docker/#what-you-get)
  - [Using PostgreSQL locally (optional)](https://archon.diy/deployment/docker/#using-postgresql-locally-optional)
- [Manual Server Setup](https://archon.diy/deployment/docker/#manual-server-setup)
  - [1\. Install Docker](https://archon.diy/deployment/docker/#1-install-docker)
  - [2\. Clone the repo](https://archon.diy/deployment/docker/#2-clone-the-repo)
  - [3\. Configure environment](https://archon.diy/deployment/docker/#3-configure-environment)
  - [4\. Point your domain to the server](https://archon.diy/deployment/docker/#4-point-your-domain-to-the-server)
  - [5\. Open firewall ports](https://archon.diy/deployment/docker/#5-open-firewall-ports)
  - [6\. Start](https://archon.diy/deployment/docker/#6-start)
  - [7\. Verify](https://archon.diy/deployment/docker/#7-verify)
- [Profiles](https://archon.diy/deployment/docker/#profiles)
  - [No profile (SQLite)](https://archon.diy/deployment/docker/#no-profile-sqlite)
  - [--profile with-db (PostgreSQL)](https://archon.diy/deployment/docker/#--profile-with-db-postgresql)
  - [--profile cloud (Caddy HTTPS)](https://archon.diy/deployment/docker/#--profile-cloud-caddy-https)
  - [Authentication (Optional Basic Auth)](https://archon.diy/deployment/docker/#authentication-optional-basic-auth)
  - [Form-Based Authentication (HTML Login Page)](https://archon.diy/deployment/docker/#form-based-authentication-html-login-page)
- [Configuration](https://archon.diy/deployment/docker/#configuration)
  - [Port Defaults](https://archon.diy/deployment/docker/#port-defaults)
  - [AI Credentials (required)](https://archon.diy/deployment/docker/#ai-credentials-required)
  - [Platform Tokens (optional)](https://archon.diy/deployment/docker/#platform-tokens-optional)
  - [Server Settings (optional)](https://archon.diy/deployment/docker/#server-settings-optional)
  - [Data Directory](https://archon.diy/deployment/docker/#data-directory)
  - [GitHub CLI Authentication](https://archon.diy/deployment/docker/#github-cli-authentication)
- [GitHub Webhooks](https://archon.diy/deployment/docker/#github-webhooks)
- [Pre-built Image](https://archon.diy/deployment/docker/#pre-built-image)
- [Building the Image](https://archon.diy/deployment/docker/#building-the-image)
  - [Customizing the Image](https://archon.diy/deployment/docker/#customizing-the-image)
- [Maintenance](https://archon.diy/deployment/docker/#maintenance)
  - [View Logs](https://archon.diy/deployment/docker/#view-logs)
  - [Update](https://archon.diy/deployment/docker/#update)
  - [Restart](https://archon.diy/deployment/docker/#restart)
  - [Stop](https://archon.diy/deployment/docker/#stop)
  - [Database Migrations (PostgreSQL)](https://archon.diy/deployment/docker/#database-migrations-postgresql)
  - [Clean Up Docker Resources](https://archon.diy/deployment/docker/#clean-up-docker-resources)
- [Troubleshooting](https://archon.diy/deployment/docker/#troubleshooting)
  - [App won’t start: “no_ai_credentials”](https://archon.diy/deployment/docker/#app-wont-start-no_ai_credentials)
  - [Caddy fails to start: “not a directory”](https://archon.diy/deployment/docker/#caddy-fails-to-start-not-a-directory)
  - [Caddy not getting SSL certificate](https://archon.diy/deployment/docker/#caddy-not-getting-ssl-certificate)
  - [Health check failing](https://archon.diy/deployment/docker/#health-check-failing)
  - [PostgreSQL connection refused](https://archon.diy/deployment/docker/#postgresql-connection-refused)
  - [Permission errors in /.archon/](https://archon.diy/deployment/docker/#permission-errors-in-archon)
  - [Port conflicts](https://archon.diy/deployment/docker/#port-conflicts)
  - [Container keeps restarting](https://archon.diy/deployment/docker/#container-keeps-restarting)

## On this page

- [Overview](https://archon.diy/deployment/docker/#_top)
- [Cloud-Init (Fastest Setup)](https://archon.diy/deployment/docker/#cloud-init-fastest-setup)
  - [How to use](https://archon.diy/deployment/docker/#how-to-use)
  - [What it installs](https://archon.diy/deployment/docker/#what-it-installs)
  - [After boot](https://archon.diy/deployment/docker/#after-boot)
  - [Provider-specific notes](https://archon.diy/deployment/docker/#provider-specific-notes)
- [Local Docker Desktop (Windows / macOS)](https://archon.diy/deployment/docker/#local-docker-desktop-windows--macos)
  - [Quick start](https://archon.diy/deployment/docker/#quick-start)
  - [Windows-specific notes](https://archon.diy/deployment/docker/#windows-specific-notes)
  - [What you get](https://archon.diy/deployment/docker/#what-you-get)
  - [Using PostgreSQL locally (optional)](https://archon.diy/deployment/docker/#using-postgresql-locally-optional)
- [Manual Server Setup](https://archon.diy/deployment/docker/#manual-server-setup)
  - [1\. Install Docker](https://archon.diy/deployment/docker/#1-install-docker)
  - [2\. Clone the repo](https://archon.diy/deployment/docker/#2-clone-the-repo)
  - [3\. Configure environment](https://archon.diy/deployment/docker/#3-configure-environment)
  - [4\. Point your domain to the server](https://archon.diy/deployment/docker/#4-point-your-domain-to-the-server)
  - [5\. Open firewall ports](https://archon.diy/deployment/docker/#5-open-firewall-ports)
  - [6\. Start](https://archon.diy/deployment/docker/#6-start)
  - [7\. Verify](https://archon.diy/deployment/docker/#7-verify)
- [Profiles](https://archon.diy/deployment/docker/#profiles)
  - [No profile (SQLite)](https://archon.diy/deployment/docker/#no-profile-sqlite)
  - [--profile with-db (PostgreSQL)](https://archon.diy/deployment/docker/#--profile-with-db-postgresql)
  - [--profile cloud (Caddy HTTPS)](https://archon.diy/deployment/docker/#--profile-cloud-caddy-https)
  - [Authentication (Optional Basic Auth)](https://archon.diy/deployment/docker/#authentication-optional-basic-auth)
  - [Form-Based Authentication (HTML Login Page)](https://archon.diy/deployment/docker/#form-based-authentication-html-login-page)
- [Configuration](https://archon.diy/deployment/docker/#configuration)
  - [Port Defaults](https://archon.diy/deployment/docker/#port-defaults)
  - [AI Credentials (required)](https://archon.diy/deployment/docker/#ai-credentials-required)
  - [Platform Tokens (optional)](https://archon.diy/deployment/docker/#platform-tokens-optional)
  - [Server Settings (optional)](https://archon.diy/deployment/docker/#server-settings-optional)
  - [Data Directory](https://archon.diy/deployment/docker/#data-directory)
  - [GitHub CLI Authentication](https://archon.diy/deployment/docker/#github-cli-authentication)
- [GitHub Webhooks](https://archon.diy/deployment/docker/#github-webhooks)
- [Pre-built Image](https://archon.diy/deployment/docker/#pre-built-image)
- [Building the Image](https://archon.diy/deployment/docker/#building-the-image)
  - [Customizing the Image](https://archon.diy/deployment/docker/#customizing-the-image)
- [Maintenance](https://archon.diy/deployment/docker/#maintenance)
  - [View Logs](https://archon.diy/deployment/docker/#view-logs)
  - [Update](https://archon.diy/deployment/docker/#update)
  - [Restart](https://archon.diy/deployment/docker/#restart)
  - [Stop](https://archon.diy/deployment/docker/#stop)
  - [Database Migrations (PostgreSQL)](https://archon.diy/deployment/docker/#database-migrations-postgresql)
  - [Clean Up Docker Resources](https://archon.diy/deployment/docker/#clean-up-docker-resources)
- [Troubleshooting](https://archon.diy/deployment/docker/#troubleshooting)
  - [App won’t start: “no_ai_credentials”](https://archon.diy/deployment/docker/#app-wont-start-no_ai_credentials)
  - [Caddy fails to start: “not a directory”](https://archon.diy/deployment/docker/#caddy-fails-to-start-not-a-directory)
  - [Caddy not getting SSL certificate](https://archon.diy/deployment/docker/#caddy-not-getting-ssl-certificate)
  - [Health check failing](https://archon.diy/deployment/docker/#health-check-failing)
  - [PostgreSQL connection refused](https://archon.diy/deployment/docker/#postgresql-connection-refused)
  - [Permission errors in /.archon/](https://archon.diy/deployment/docker/#permission-errors-in-archon)
  - [Port conflicts](https://archon.diy/deployment/docker/#port-conflicts)
  - [Container keeps restarting](https://archon.diy/deployment/docker/#container-keeps-restarting)

# Docker Guide

Deploy Archon on a server with Docker. Includes automatic HTTPS, PostgreSQL, and the Web UI.

---

## Cloud-Init (Fastest Setup)

[Section titled “Cloud-Init (Fastest Setup)”](https://archon.diy/deployment/docker/#cloud-init-fastest-setup)

The fastest way to deploy. Paste the cloud-init config into your VPS provider’s **User Data** field when creating a server — it installs everything automatically.

**File:**`deploy/cloud-init.yml`

### How to use

[Section titled “How to use”](https://archon.diy/deployment/docker/#how-to-use)

1. **Create a VPS** (Ubuntu 22.04+ recommended) at DigitalOcean, AWS, Linode, Hetzner, etc.
2. **Paste** the contents of `deploy/cloud-init.yml` into the “User Data” / “Cloud-Init” field
3. **Add your SSH key** via the provider’s UI
4. **Create the server** and wait ~5-8 minutes for setup to complete

### What it installs

[Section titled “What it installs”](https://archon.diy/deployment/docker/#what-it-installs)

- Docker + Docker Compose
- UFW firewall (ports 22, 80, 443)
- Clones the repo to `/opt/archon`
- Copies `.env.example` -\> `.env` and `Caddyfile.example` -\> `Caddyfile`
- Pre-pulls PostgreSQL and Caddy images
- Builds the Archon Docker image

### After boot

[Section titled “After boot”](https://archon.diy/deployment/docker/#after-boot)

SSH into the server and finish configuration:

Terminal window

```
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

> **Don’t forget DNS**: Before starting, point your domain’s A record to the server’s IP.

### Provider-specific notes

[Section titled “Provider-specific notes”](https://archon.diy/deployment/docker/#provider-specific-notes)

| Provider         | Where to paste cloud-init                             |
| ---------------- | ----------------------------------------------------- |
| **DigitalOcean** | Create Droplet -> Advanced Options -> User Data       |
| **AWS EC2**      | Launch Instance -> Advanced Details -> User Data      |
| **Linode**       | Create Linode -> Add Tags -> Metadata (User Data)     |
| **Hetzner**      | Create Server -> Cloud config -> User Data            |
| **Vultr**        | Deploy -> Additional Features -> Cloud-Init User-Data |

---

## Local Docker Desktop (Windows / macOS)

[Section titled “Local Docker Desktop (Windows / macOS)”](https://archon.diy/deployment/docker/#local-docker-desktop-windows--macos)

Run Archon locally with Docker Desktop — no domain, no VPS required. Uses SQLite and the Web UI only.

### Quick start

[Section titled “Quick start”](https://archon.diy/deployment/docker/#quick-start)

Terminal window

```
git clone https://github.com/coleam00/Archon.git

cd Archon

cp .env.example .env

# Edit .env: set CLAUDE_CODE_OAUTH_TOKEN or CLAUDE_API_KEY

docker compose up -d
```

Access the Web UI at **[http://localhost:3000](http://localhost:3000/)**.

### Windows-specific notes

[Section titled “Windows-specific notes”](https://archon.diy/deployment/docker/#windows-specific-notes)

**Build from WSL, not PowerShell.** Docker Desktop on Windows cannot follow Bun workspace symlinks during the build context transfer. If you see `The file cannot be accessed by the system`, open a WSL terminal:

Terminal window

```
cd /mnt/c/Users/YourName/path/to/Archon

docker compose up -d
```

**Line endings:** The repo uses `.gitattributes` to force LF endings for shell scripts. If you cloned before this was added and see `exec docker-entrypoint.sh: no such file or directory`, re-clone or run:

Terminal window

```
git rm --cached -r .

git reset --hard
```

### What you get

[Section titled “What you get”](https://archon.diy/deployment/docker/#what-you-get)

| Feature           | Status                                          |
| ----------------- | ----------------------------------------------- |
| Web UI            | [http://localhost:3000](http://localhost:3000/) |
| Database          | SQLite (automatic, zero setup)                  |
| HTTPS / Caddy     | Not needed locally                              |
| Auth              | None (single-user, localhost only)              |
| Platform adapters | Optional (Telegram, Slack, etc.)                |

### Using PostgreSQL locally (optional)

[Section titled “Using PostgreSQL locally (optional)”](https://archon.diy/deployment/docker/#using-postgresql-locally-optional)

Terminal window

```
docker compose --profile with-db up -d
```

Then add to `.env`:

```
DATABASE_URL=postgresql://postgres:postgres@postgres:5432/remote_coding_agent
```

---

## Manual Server Setup

[Section titled “Manual Server Setup”](https://archon.diy/deployment/docker/#manual-server-setup)

Step-by-step alternative if you prefer not to use cloud-init, or need more control.

### 1\. Install Docker

[Section titled “1. Install Docker”](https://archon.diy/deployment/docker/#1-install-docker)

Terminal window

```
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

### 2\. Clone the repo

[Section titled “2. Clone the repo”](https://archon.diy/deployment/docker/#2-clone-the-repo)

Terminal window

```
git clone https://github.com/coleam00/Archon.git

cd Archon
```

### 3\. Configure environment

[Section titled “3. Configure environment”](https://archon.diy/deployment/docker/#3-configure-environment)

Terminal window

```
cp .env.example .env

cp Caddyfile.example Caddyfile

nano .env
```

Set these values in `.env`:

```
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

### 4\. Point your domain to the server

[Section titled “4. Point your domain to the server”](https://archon.diy/deployment/docker/#4-point-your-domain-to-the-server)

Create a DNS **A record** at your domain registrar:

| Type | Name                              | Value                   |
| ---- | --------------------------------- | ----------------------- |
| A    | `archon` (or `@` for root domain) | Your server’s public IP |

Wait for DNS propagation (usually 5-60 minutes). Verify with `dig archon.example.com`.

### 5\. Open firewall ports

[Section titled “5. Open firewall ports”](https://archon.diy/deployment/docker/#5-open-firewall-ports)

Terminal window

```
sudo ufw allow 22/tcp

sudo ufw allow 80/tcp

sudo ufw allow 443

sudo ufw --force enable
```

### 6\. Start

[Section titled “6. Start”](https://archon.diy/deployment/docker/#6-start)

Terminal window

```
docker compose --profile with-db --profile cloud up -d
```

This starts three containers:

- **app** — Archon server + Web UI
- **postgres** — PostgreSQL 17 database (auto-initialized)
- **caddy** — Reverse proxy with automatic HTTPS (Let’s Encrypt)

### 7\. Verify

[Section titled “7. Verify”](https://archon.diy/deployment/docker/#7-verify)

Terminal window

```
# Check all containers are running

docker compose --profile with-db --profile cloud ps

# Watch logs

docker compose logs -f app

docker compose logs -f caddy

# Test HTTPS (from your local machine)

curl https://archon.example.com/api/health
```

Open **[https://archon.example.com](https://archon.example.com/)** in your browser — you should see the Archon Web UI.

---

## Profiles

[Section titled “Profiles”](https://archon.diy/deployment/docker/#profiles)

Archon uses Docker Compose profiles to optionally add PostgreSQL and/or HTTPS. Mix and match:

| Command                                                  | What runs                |
| -------------------------------------------------------- | ------------------------ |
| `docker compose up -d`                                   | App with SQLite          |
| `docker compose --profile with-db up -d`                 | App + PostgreSQL         |
| `docker compose --profile cloud up -d`                   | App + Caddy (HTTPS)      |
| `docker compose --profile with-db --profile cloud up -d` | App + PostgreSQL + Caddy |

Note

There is no `external-db` profile. When using an external PostgreSQL database (Supabase, Neon, etc.), just set `DATABASE_URL` in `.env` and run `docker compose up -d` without any profile. The base `app` service always starts.

### No profile (SQLite)

[Section titled “No profile (SQLite)”](https://archon.diy/deployment/docker/#no-profile-sqlite)

Zero-config default. No database container needed — SQLite file is stored in the `archon_data` volume.

### `--profile with-db` (PostgreSQL)

[Section titled “--profile with-db (PostgreSQL)”](https://archon.diy/deployment/docker/#--profile-with-db-postgresql)

Starts a PostgreSQL 17 container. Set the connection URL in `.env`:

```
DATABASE_URL=postgresql://postgres:postgres@postgres:5432/remote_coding_agent
```

The schema is auto-initialized on first startup. PostgreSQL is exposed on `${POSTGRES_PORT:-5432}` for external tools.

### `--profile cloud` (Caddy HTTPS)

[Section titled “--profile cloud (Caddy HTTPS)”](https://archon.diy/deployment/docker/#--profile-cloud-caddy-https)

Adds a [Caddy](https://caddyserver.com/) reverse proxy with automatic TLS certificates from Let’s Encrypt.

**Requires before starting:**

1. `Caddyfile` created: `cp Caddyfile.example Caddyfile`
2. `DOMAIN` set in `.env`
3. DNS A record pointing to your server’s IP
4. Ports 80 and 443 open

Caddy handles HTTPS certificates, HTTP->HTTPS redirect, HTTP/3, and SSE streaming.

### Authentication (Optional Basic Auth)

[Section titled “Authentication (Optional Basic Auth)”](https://archon.diy/deployment/docker/#authentication-optional-basic-auth)

Caddy can enforce HTTP Basic Auth on all routes except webhooks (`/webhooks/*`) and the health check (`/api/health`). This is optional — skip it if you use IP-based firewall rules or other network-level access control.

**To enable:**

1. Generate a bcrypt password hash:

Terminal window

```
docker run caddy caddy hash-password --plaintext 'YOUR_PASSWORD'
```

2. Set `CADDY_BASIC_AUTH` in `.env` (use `$$` to escape `$` in bcrypt hashes):

```
CADDY_BASIC_AUTH=basicauth @protected { admin $$2a$$14$$abc123... }
```

3. Restart: `docker compose --profile cloud restart caddy`

Your browser will prompt for username/password when accessing the Archon URL. Webhook endpoints bypass auth since they use HMAC signature verification.

To disable, leave `CADDY_BASIC_AUTH` empty or unset — the Caddyfile expands it to nothing.

> **Important:** Always use the `docker run caddy caddy hash-password` command to generate hashes — never put plaintext passwords in `.env`.

### Form-Based Authentication (HTML Login Page)

[Section titled “Form-Based Authentication (HTML Login Page)”](https://archon.diy/deployment/docker/#form-based-authentication-html-login-page)

An alternative to basic auth that serves a styled HTML login form instead of the browser’s credential popup. Uses a lightweight `auth-service` sidecar and Caddy’s `forward_auth` directive.

**When to use form auth vs basic auth:**

- **Form auth**: Styled dark-mode login page, 24h session cookie, logout support. Requires an extra container.
- **Basic auth**: Zero extra containers, simpler setup. Browser shows a native credential dialog.

**Setup:**

1. Generate a bcrypt password hash:

Terminal window

```
docker compose --profile auth run --rm auth-service \

     node -e "require('bcryptjs').hash('YOUR_PASSWORD', 12).then(h => console.log(h))"
```

> First run builds the auth-service image. Save the output hash (starts with `$2b$12$...`).

2. Generate a random cookie signing secret:

Terminal window

```
docker run --rm node:22-alpine \

     node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

3. Set the following in `.env`:

```
AUTH_USERNAME=admin

AUTH_PASSWORD_HASH=$2b$12$REPLACE_WITH_YOUR_HASH

COOKIE_SECRET=REPLACE_WITH_64_HEX_CHARS
```

4. Update `Caddyfile` (copy from `Caddyfile.example` if not done yet):
   - **Uncomment** the “Option A” form auth block (the `handle /login`, `handle /logout`, and `handle { forward_auth ... }` blocks)
   - **Comment out** the “No auth” default `handle` block (the last `handle { ... }` block near the bottom of the site block)
5. Start with both `cloud` and `auth` profiles:

Terminal window

```
docker compose --profile with-db --profile cloud --profile auth up -d
```

6. Visit your domain — you should be redirected to `/login`.

**Logout:** Navigate to `/logout` to clear the session cookie and return to the login form.

**Session duration:** Defaults to 24 hours (`COOKIE_MAX_AGE=86400`). Override in `.env`:

```
COOKIE_MAX_AGE=3600  # 1 hour
```

> **Note:** Do not use form auth and basic auth simultaneously. Choose one method and leave the other disabled (either empty `CADDY_BASIC_AUTH` or remove the basic auth `@protected` block from your Caddyfile).

---

## Configuration

[Section titled “Configuration”](https://archon.diy/deployment/docker/#configuration)

### Port Defaults

[Section titled “Port Defaults”](https://archon.diy/deployment/docker/#port-defaults)

Caution

Docker defaults to port **3000** (`${PORT:-3000}` in docker-compose.yml), while local development defaults to **3090**. Set `PORT` in `.env` to change the Docker port.

The Docker healthcheck uses `/api/health` (not `/health`):

Terminal window

```
# Inside Docker

curl http://localhost:3000/api/health

# Local development (both work)

curl http://localhost:3090/health

curl http://localhost:3090/api/health
```

### AI Credentials (required)

[Section titled “AI Credentials (required)”](https://archon.diy/deployment/docker/#ai-credentials-required)

Docker containers cannot use `CLAUDE_USE_GLOBAL_AUTH=true` — there is no local `claude` CLI inside the container. You must set credentials explicitly in `.env`:

**Claude (choose one):**

```
# OAuth token — run `claude setup-token` on your local machine, copy the token

CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-xxxxx

# Or API key — from console.anthropic.com/settings/keys

CLAUDE_API_KEY=sk-ant-xxxxx
```

**Codex (alternative):**

```
CODEX_ID_TOKEN=eyJhbGc...

CODEX_ACCESS_TOKEN=eyJhbGc...

CODEX_REFRESH_TOKEN=rt_...

CODEX_ACCOUNT_ID=6a6a7ba6-...
```

### Platform Tokens (optional)

[Section titled “Platform Tokens (optional)”](https://archon.diy/deployment/docker/#platform-tokens-optional)

```
TELEGRAM_BOT_TOKEN=123456789:ABCdef...

SLACK_BOT_TOKEN=xoxb-...

SLACK_APP_TOKEN=xapp-...

DISCORD_BOT_TOKEN=...

GH_TOKEN=ghp_...

GITHUB_TOKEN=ghp_...

WEBHOOK_SECRET=...
```

### Server Settings (optional)

[Section titled “Server Settings (optional)”](https://archon.diy/deployment/docker/#server-settings-optional)

```
PORT=3000                          # Default: 3000

DOMAIN=archon.example.com          # Required for --profile cloud

LOG_LEVEL=info                     # fatal|error|warn|info|debug|trace

MAX_CONCURRENT_CONVERSATIONS=10
```

See `.env.example` for the full list with documentation.

### Data Directory

[Section titled “Data Directory”](https://archon.diy/deployment/docker/#data-directory)

The container stores all data at `/.archon/` (workspaces, worktrees, artifacts, logs, SQLite DB).

By default this is a Docker-managed volume. To store data at a specific location on the host, set `ARCHON_DATA` in `.env`:

```
# Store Archon data at a specific host path

ARCHON_DATA=/opt/archon-data
```

The directory is created automatically. Make sure the path is writable by UID 1001 (the container user):

Terminal window

```
mkdir -p /opt/archon-data

sudo chown -R 1001:1001 /opt/archon-data
```

If `ARCHON_DATA` is not set, Docker manages the volume automatically (`archon_data`) — data persists across restarts and rebuilds but lives inside Docker’s storage.

### GitHub CLI Authentication

[Section titled “GitHub CLI Authentication”](https://archon.diy/deployment/docker/#github-cli-authentication)

`GH_TOKEN` from `.env` is picked up automatically. Alternatively:

Terminal window

```
docker compose exec app gh auth login
```

---

## GitHub Webhooks

[Section titled “GitHub Webhooks”](https://archon.diy/deployment/docker/#github-webhooks)

After the server is reachable via HTTPS:

1. Go to `https://github.com/<owner>/<repo>/settings/hooks`
2. Add webhook:
   - **Payload URL**: `https://archon.example.com/webhooks/github`
   - **Content type**: `application/json`
   - **Secret**: Your `WEBHOOK_SECRET` from `.env`
   - **Events**: Issues, Issue comments, Pull requests

---

## Pre-built Image

[Section titled “Pre-built Image”](https://archon.diy/deployment/docker/#pre-built-image)

For users who don’t need to build from source:

Terminal window

```
mkdir archon && cd archon

curl -O https://raw.githubusercontent.com/coleam00/Archon/main/deploy/docker-compose.yml

curl -O https://raw.githubusercontent.com/coleam00/Archon/main/.env.example

cp .env.example .env

# Edit .env — set AI credentials, DOMAIN, etc.

docker compose up -d
```

Uses `ghcr.io/coleam00/archon:latest`. To add PostgreSQL, uncomment the `postgres` service in the compose file and set `DATABASE_URL` in `.env`.

To layer custom tools on top of the pre-built image, see [Customizing the Image](https://archon.diy/deployment/docker/#customizing-the-image).

---

## Building the Image

[Section titled “Building the Image”](https://archon.diy/deployment/docker/#building-the-image)

The Dockerfile uses three stages:

1. **deps** — Installs all dependencies (including devDependencies for the web build)
2. **web-build** — Builds the React web UI with Vite
3. **production** — Production image with only production dependencies + pre-built web assets

Terminal window

```
docker build -t archon .

docker run --env-file .env -p 3000:3000 archon
```

**What’s in the image:**

- **Runtime**: Bun 1.2 (runs TypeScript directly, no compile step)
- **System deps**: git, curl, gh (GitHub CLI), postgresql-client, Chromium
- **Browser tooling**: [agent-browser](https://github.com/vercel-labs/agent-browser) (Vercel Labs) — enables E2E testing workflows via CDP. Uses system Chromium (`AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium`)
- **App**: All 10 workspace packages (source), pre-built web UI
- **User**: Non-root `appuser` (UID 1001) — required by Claude Code SDK
- **Archon dirs**: `/.archon/workspaces`, `/.archon/worktrees`

The multi-stage build keeps the image lean — no devDependencies, test files, docs, or `.git/`.

### Customizing the Image

[Section titled “Customizing the Image”](https://archon.diy/deployment/docker/#customizing-the-image)

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

[Section titled “Maintenance”](https://archon.diy/deployment/docker/#maintenance)

### View Logs

[Section titled “View Logs”](https://archon.diy/deployment/docker/#view-logs)

Terminal window

```
docker compose logs -f              # All services

docker compose logs -f app          # App only

docker compose logs --tail=100 app  # Last 100 lines
```

### Update

[Section titled “Update”](https://archon.diy/deployment/docker/#update)

Terminal window

```
git pull

docker compose --profile with-db --profile cloud up -d --build
```

### Restart

[Section titled “Restart”](https://archon.diy/deployment/docker/#restart)

Terminal window

```
docker compose restart         # All

docker compose restart app     # App only
```

### Stop

[Section titled “Stop”](https://archon.diy/deployment/docker/#stop)

Terminal window

```
docker compose down            # Stop containers (data preserved)

docker compose down -v         # Stop + delete volumes (destructive!)
```

### Database Migrations (PostgreSQL)

[Section titled “Database Migrations (PostgreSQL)”](https://archon.diy/deployment/docker/#database-migrations-postgresql)

Migrations run automatically on first startup via `000_combined.sql`. When upgrading to a newer version that adds database tables, you need to apply incremental migrations manually:

Terminal window

```
# Example: apply the env vars migration (required when upgrading to v0.3.x)

docker compose exec postgres psql -U postgres -d remote_coding_agent -f /migrations/020_codebase_env_vars.sql
```

The `migrations/` directory is mounted read-only into the postgres container. Check for any new migration files after pulling updates.

### Clean Up Docker Resources

[Section titled “Clean Up Docker Resources”](https://archon.diy/deployment/docker/#clean-up-docker-resources)

Terminal window

```
docker system prune -a         # Remove unused images/containers

docker volume prune            # Remove unused volumes (caution!)

docker system df               # Check disk usage
```

---

## Troubleshooting

[Section titled “Troubleshooting”](https://archon.diy/deployment/docker/#troubleshooting)

### App won’t start: “no_ai_credentials”

[Section titled “App won’t start: “no_ai_credentials””](https://archon.diy/deployment/docker/#app-wont-start-no_ai_credentials)

No AI assistant configured. Docker does not support `CLAUDE_USE_GLOBAL_AUTH=true`. Set one of these in `.env`:

- `CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...` (run `claude setup-token` locally to get one)
- `CLAUDE_API_KEY=sk-ant-...` (from console.anthropic.com)
- Or Codex credentials (`CODEX_ID_TOKEN`, `CODEX_ACCESS_TOKEN`, etc.)

### Caddy fails to start: “not a directory”

[Section titled “Caddy fails to start: “not a directory””](https://archon.diy/deployment/docker/#caddy-fails-to-start-not-a-directory)

```
error mounting "Caddyfile": not a directory
```

The `Caddyfile` doesn’t exist — Docker created a directory in its place. Fix:

Terminal window

```
rm -rf Caddyfile

cp Caddyfile.example Caddyfile

docker compose --profile cloud up -d
```

### Caddy not getting SSL certificate

[Section titled “Caddy not getting SSL certificate”](https://archon.diy/deployment/docker/#caddy-not-getting-ssl-certificate)

Terminal window

```
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

[Section titled “Health check failing”](https://archon.diy/deployment/docker/#health-check-failing)

The Docker healthcheck uses `/api/health` (not `/health`):

Terminal window

```
curl http://localhost:3000/api/health
```

### PostgreSQL connection refused

[Section titled “PostgreSQL connection refused”](https://archon.diy/deployment/docker/#postgresql-connection-refused)

When using `--profile with-db`, ensure:

1. `DATABASE_URL` uses `postgres` as hostname (Docker service name), not `localhost`:

```
DATABASE_URL=postgresql://postgres:postgres@postgres:5432/remote_coding_agent
```

2. The postgres container is healthy: `docker compose ps postgres`
3. Migrations ran: check `docker compose logs postgres` for init script output

### Permission errors in `/.archon/`

[Section titled “Permission errors in /.archon/”](https://archon.diy/deployment/docker/#permission-errors-in-archon)

The container runs as `appuser` (UID 1001). If using bind mounts instead of Docker volumes:

Terminal window

```
sudo chown -R 1001:1001 /path/to/archon-data
```

### Port conflicts

[Section titled “Port conflicts”](https://archon.diy/deployment/docker/#port-conflicts)

Default Docker port is 3000 (local dev is 3090). Change in `.env`:

```
PORT=3001
```

### Container keeps restarting

[Section titled “Container keeps restarting”](https://archon.diy/deployment/docker/#container-keeps-restarting)

Terminal window

```
docker compose ps

docker compose logs --tail=50 app
```

Common causes: missing `.env` file, invalid credentials, database unreachable.

[Edit page](https://github.com/coleam00/Archon/edit/main/packages/docs-web/src/content/docs/deployment/docker.md)

[Previous \\
\\
Local Development](https://archon.diy/deployment/local/) [Next \\
\\
Cloud Deployment](https://archon.diy/deployment/cloud/)
