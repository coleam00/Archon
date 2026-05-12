# Server Setup Guide

Shared setup for all non-CLI platforms (Telegram, Slack, Discord, GitHub). Run the CLI setup first.

**Important**: The server runs from the **archon repo root** — not the target repo. The `.env` file should already exist there (created in Step 4 of the setup wizard).

## 1. Verify `.env`

Make sure `.env` exists in the archon repo root with the platform tokens from the platform-specific guides:

```bash
ls -la <archon-repo>/.env
```

If it doesn't exist yet:
```bash
cd <archon-repo> && cp .env.example .env
```

Then add the platform tokens from the relevant platform guides.

## 2. Start the Development Server

```bash
cd <archon-repo> && bun run dev
```

This starts the Hono server with hot reload. Platform adapters auto-start based on which tokens are present in `.env`.

## 3. Verify Server Health

```bash
curl http://localhost:3090/health
```

Expected response: `{"status":"ok"}`

## 4. Database

- **SQLite (default)**: Auto-creates at `~/.archon/archon.db`. No setup needed.
- **PostgreSQL (optional)**: Set `DATABASE_URL` in `.env` and run migrations:

```bash
docker-compose --profile with-db up -d postgres
psql $DATABASE_URL < migrations/001_initial_schema.sql
```

## 5. Running in Background

For persistent operation, choose one:

**tmux/screen:**
```bash
tmux new -s archon
cd <archon-repo> && bun run dev
# Ctrl+B, D to detach
```

**Docker (production):**
```bash
cd <archon-repo> && docker-compose --profile with-db up -d --build
```

**systemd (Linux):**
Create a service file at `/etc/systemd/system/archon.service` pointing to `bun run start`.

## Important Notes

- Only use **one instance** at a time per set of platform tokens — running multiple instances causes token conflicts.
- The server must be running for Telegram, Slack, Discord, and GitHub platforms to work.
- CLI workflows work independently and do not require the server.
- **Configuration**: `~/.archon/config.yaml` is auto-created on first run with sensible defaults. Environment variables in `.env` override matching config values (e.g., `TELEGRAM_STREAMING_MODE` overrides `streaming.telegram`).
