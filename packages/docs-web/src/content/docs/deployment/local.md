---
title: Local Development
description: Run Archon locally with SQLite or PostgreSQL for development and personal use.
category: deployment
area: infra
audience: [operator]
status: current
sidebar:
  order: 1
---

This guide covers how to run the Archon server locally, with Docker, and in production. For VPS deployment with automatic HTTPS, see the [Cloud Deployment Guide](/deployment/cloud/).

**Quick links:** [Local Development](#local-development) | [Docker with Remote DB](#docker-with-remote-postgresql) | [Docker with Local PostgreSQL](#docker-with-local-postgresql) | [Production](#production-deployment)

---

## Local Development

Local development with SQLite is the recommended default. No database setup is needed.

### Prerequisites

- [Bun](https://bun.sh) 1.0+
- At least one AI assistant configured (Claude Code or Codex)
- A GitHub token for repository cloning (`GH_TOKEN` / `GITHUB_TOKEN`)

### Setup

```bash
# 1. Clone and install
git clone https://github.com/coleam00/Archon
cd Archon
bun install

# 2. Configure environment
cp .env.example .env
nano .env  # Add your AI assistant tokens (Claude or Codex)

# 3. Start server + Web UI (SQLite auto-detected, no database setup needed)
bun run dev

# 4. Open Web UI
# http://localhost:3091
```

In development mode, two servers run simultaneously:

| Service    | URL                    | Purpose                          |
|------------|------------------------|----------------------------------|
| Web UI     | http://localhost:3091  | React frontend (Vite dev server) |
| API Server | http://localhost:3090  | Backend API + SSE streaming      |

### Optional: Use PostgreSQL Instead of SQLite

If you prefer PostgreSQL for local development:

```bash
docker compose --profile with-db up -d postgres
# Set DATABASE_URL=postgresql://postgres:postgres@localhost:5432/remote_coding_agent in .env
```

> **Note:** The database schema is created automatically on first container startup via the mounted migration file. No manual `psql` step is needed for fresh installs.

### Production Build (Local)

```bash
bun run build    # Build the frontend
bun run start    # Server serves both API and Web UI on port 3090
```

### Verify It Works

```bash
curl http://localhost:3090/health
# Expected: {"status":"ok"}
```

---

## Docker with Remote PostgreSQL

Use this option when your database is hosted externally (Supabase, Neon, AWS RDS, etc.). This starts only the app container.

### Prerequisites

- Docker & Docker Compose
- A remote PostgreSQL database with `DATABASE_URL` set in `.env`
- AI assistant tokens configured in `.env`

### Setup

The app container runs without any profile when using an external database. There is no `external-db` profile — the base `app` service always starts.

```bash
# 1. Get the deployment files
mkdir archon && cd archon
curl -fsSL https://raw.githubusercontent.com/coleam00/Archon/main/deploy/docker-compose.yml -o docker-compose.yml
curl -fsSL https://raw.githubusercontent.com/coleam00/Archon/main/deploy/.env.example -o .env

# 2. Configure (edit .env with your tokens and DATABASE_URL)
nano .env

# 3. Start app container (no profile needed for external DB)
docker compose up -d

# 4. View logs
docker compose logs -f app

# 5. Verify
curl http://localhost:3000/api/health
```

:::note
Docker defaults to port **3000** (set via `PORT` in `.env`). Local development defaults to port **3090**. The health endpoint in Docker is `/api/health`, while in local dev mode `/health` also works.
:::

### Database Migration (First Time)

For fresh installations, run the combined migration:

```bash
psql $DATABASE_URL < migrations/000_combined.sql
```

### Stop

```bash
docker compose down
```

---

## Docker with Local PostgreSQL

Use this option to run both the app and PostgreSQL in Docker containers. The database schema is created automatically on first startup.

### Setup

```bash
# 1. Configure .env
# Set: DATABASE_URL=postgresql://postgres:postgres@postgres:5432/remote_coding_agent

# 2. Start both containers
docker compose --profile with-db up -d --build

# 3. Wait for startup (watch logs)
docker compose logs -f app

# 4. Verify
curl http://localhost:3000/api/health
```

> **Note:** Database tables are created automatically via the init script on first startup. No manual migration step is needed.

### Updating an Existing Installation

When new migrations are added, apply them manually:

```bash
# Connect to the running postgres container
docker compose exec postgres psql -U postgres -d remote_coding_agent

# For a fresh install, run the combined migration (idempotent, creates all 7 tables):
\i /migrations/000_combined.sql

# Or apply individual migrations you haven't applied yet.
# Check the migrations/ directory for the full list (currently 001 through 019).
\q
```

### Stop

```bash
docker compose --profile with-db down
```

---

## Production Deployment

For deploying to a VPS (DigitalOcean, Linode, AWS EC2, etc.) with automatic HTTPS via Caddy, see the [Cloud Deployment Guide](/deployment/cloud/).

---

## Database Options Summary

| Option | Setup | Best For |
|--------|-------|----------|
| **SQLite** (default) | Zero config, just omit `DATABASE_URL` | Single-user, CLI usage, local development |
| **Remote PostgreSQL** | Set `DATABASE_URL` to hosted DB | Cloud deployments, shared access |
| **Local PostgreSQL** | Docker `--profile with-db` | Self-hosted, Docker-based setups |

SQLite stores data at `~/.archon/archon.db` (or `/.archon/archon.db` in Docker). It is auto-initialized on first run.

---

## Port Configuration

| Context | Default Port | Notes |
|---------|-------------|-------|
| Local dev (`bun run dev`) | 3090 | Default server port |
| Docker | 3000 | Set via `PORT` in `.env` |
| Worktrees | 3190-4089 | Auto-allocated, hash-based on path |
| Override | Any | Set `PORT=4000 bun dev` |

:::tip
The port difference between local dev (3090) and Docker (3000) is intentional. Override with the `PORT` environment variable in either context.
:::

---

## Health Endpoints

| Context | Endpoint | Notes |
|---------|----------|-------|
| Docker / production | `/api/health` | Used by Docker healthcheck |
| Local dev | `/health` | Convenience alias (also supports `/api/health`) |

```bash
# Docker
curl http://localhost:3000/api/health

# Local dev
curl http://localhost:3090/health

# Additional checks (both contexts)
curl http://localhost:3090/health/db           # Database connectivity
curl http://localhost:3090/health/concurrency  # Concurrency status
```

---

## Troubleshooting

### Container Won't Start

```bash
# Check logs
docker compose logs app          # default (SQLite or external DB)
docker compose logs app          # --profile with-db

# Verify environment
docker compose config

# Rebuild without cache
docker compose build --no-cache
docker compose up -d
```

### Port Conflicts

```bash
# Check if port is in use
lsof -i :3090        # macOS/Linux
netstat -ano | findstr :3090  # Windows
```
