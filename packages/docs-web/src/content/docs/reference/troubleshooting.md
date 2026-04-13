---
title: Troubleshooting
description: Common issues and solutions when running Archon locally or in Docker.
category: reference
audience: [user, operator]
status: current
sidebar:
  order: 7
---

Common issues and their solutions when running Archon.

## Bot Not Responding

**Check if the application is running:**

If running locally:
```bash
# Check the server process
curl http://localhost:3090/health
# Expected: {"status":"ok"}
```

If running via Docker:
```bash
docker compose ps
# Should show 'app' with state 'Up'
```

**Check application logs:**

Local:
```bash
# Server logs are printed to stdout when running `bun run dev`
```

Docker:
```bash
docker compose logs -f app
```

**Verify bot token:**
```bash
# In your .env file
cat .env | grep TELEGRAM_BOT_TOKEN
```

**Test with health check:**
```bash
curl http://localhost:3090/health
# Expected: {"status":"ok"}
```

## Database Connection Errors

**Check database health:**
```bash
curl http://localhost:3090/health/db
# Expected: {"status":"ok","database":"connected"}
```

**For SQLite (default):**

SQLite requires no setup. The database is created automatically at `~/.archon/archon.db`. If you see errors, check that the `~/.archon/` directory exists and is writable.

**For remote PostgreSQL:**
```bash
# Verify DATABASE_URL
echo $DATABASE_URL

# Test connection directly
psql $DATABASE_URL -c "SELECT 1"
```

**Verify tables exist (PostgreSQL):**
```bash
psql $DATABASE_URL -c "\dt"

# Should show: remote_agent_codebases, remote_agent_conversations, remote_agent_sessions,
# remote_agent_isolation_environments, remote_agent_workflow_runs, remote_agent_workflow_events,
# remote_agent_messages
```

## Clone Command Fails

**Verify GitHub token:**
```bash
cat .env | grep GH_TOKEN
# Should have both GH_TOKEN and GITHUB_TOKEN set
```

**Test token validity:**
```bash
# Test GitHub API access
curl -H "Authorization: token $GH_TOKEN" https://api.github.com/user
```

**Check workspace permissions:**

The workspace directory is `~/.archon/workspaces/` by default (or `/.archon/workspaces/` in Docker). Make sure it exists and is writable.

**Try manual clone:**
```bash
git clone https://github.com/user/repo ~/.archon/workspaces/test-repo
```

## GitHub Webhook Not Triggering

**Verify webhook delivery:**
1. Go to your webhook settings in GitHub
2. Click on the webhook
3. Check "Recent Deliveries" tab
4. Look for successful deliveries (green checkmark)

**Check webhook secret:**
```bash
cat .env | grep WEBHOOK_SECRET
# Must match exactly what you entered in GitHub
```

**Verify ngrok is running (local dev):**
```bash
# Check ngrok status
curl http://localhost:4040/api/tunnels
# Or visit http://localhost:4040 in browser
```

**Check application logs for webhook processing:**

Local:
```bash
# Look for GitHub-related log lines in server output
```

Docker:
```bash
docker compose logs -f app | grep GitHub
```

## Port Conflicts

**Check if port 3090 is already in use:**

macOS/Linux:
```bash
lsof -i :3090
```

Windows:
```bash
netstat -ano | findstr :3090
```

You can override the port with the `PORT` environment variable:
```bash
PORT=4000 bun run dev
```

When running in a git worktree, Archon automatically allocates a unique port (3190-4089 range) so you don't need to worry about conflicts with the main instance.

### Stale Processes (Windows)

**Symptom:** The Web UI shows a spinning indicator with no response, and the terminal shows no activity — even though you've started `bun run dev`.

**Cause:** A previous `bun` or `node` process is still holding the port. This is common on Windows when the terminal is closed without stopping the server.

**Diagnose:**

```powershell
netstat -ano | findstr :3090
```

Note the PID in the last column, then verify which process it is:

```powershell
tasklist | findstr 12345
```

(Replace `12345` with the actual PID.)

**Fix — kill by PID** (preferred):

```powershell
taskkill /F /PID 12345
```

If multiple stale processes are present:

```powershell
taskkill /F /IM bun.exe
taskkill /F /IM node.exe
```

:::caution
Do not kill `claude.exe` processes — those are active Claude Code sessions.
:::

See also: [Windows Setup](/deployment/windows/) for more Windows-specific guidance.

## E2E Testing / agent-browser

**`agent-browser: command not found`:**

`agent-browser` is an optional external dependency -- see the [E2E Testing Guide](/deployment/e2e-testing/) for installation.

```bash
npm install -g agent-browser
agent-browser install
```

**agent-browser daemon fails to start (Windows):**

agent-browser has a [known Windows bug](https://github.com/vercel-labs/agent-browser/issues/56). Use WSL as a workaround -- see [E2E Testing on WSL](/deployment/e2e-testing-wsl/).

**agent-browser daemon fails to start (macOS/Linux):**

Kill stale daemons and retry:
```bash
pkill -f daemon.js
agent-browser open http://localhost:3090
```

## Docker

These issues are specific to running Archon inside Docker containers.

### Container Won't Start

**Check logs for specific errors:**
```bash
docker compose logs app
```

**Verify environment variables:**
```bash
# Check if .env is properly formatted
docker compose config
```

**Rebuild without cache:**
```bash
docker compose build --no-cache
docker compose up -d
```

If using the `with-db` profile, add `--profile with-db` to the above commands.

### Docker Database Issues

**For local PostgreSQL (`with-db` profile):**
```bash
# Check if postgres container is running
docker compose --profile with-db ps postgres

# Check postgres logs
docker compose logs -f postgres

# Test direct connection
docker compose exec postgres psql -U postgres -c "SELECT 1"
```

**Verify tables exist (Docker PostgreSQL):**
```bash
docker compose exec postgres psql -U postgres -d remote_coding_agent -c "\dt"

# Should show: remote_agent_codebases, remote_agent_conversations, remote_agent_sessions,
# remote_agent_isolation_environments, remote_agent_workflow_runs, remote_agent_workflow_events,
# remote_agent_messages
```

### Docker Clone Issues

**Check workspace permissions inside the container:**
```bash
docker compose exec app ls -la /.archon/workspaces
```

**Try manual clone inside the container:**
```bash
docker compose exec app git clone https://github.com/user/repo /.archon/workspaces/test-repo
```

## Workflows Hang Silently When Run Inside Claude Code

**Symptom:** Workflows started from within a Claude Code session (e.g., via the Terminal tool) produce no output, or the CLI emits a warning about `CLAUDECODE=1` before the workflow hangs.

**Cause:** Nested Claude Code sessions can deadlock — the outer session waits for tool results that the inner session never delivers.

**Fix:** Run `archon serve` from a regular shell outside Claude Code and use the Web UI or HTTP API instead.

**Suppress the warning:** If you have a non-deadlocking setup and want to silence the warning:

```bash
ARCHON_SUPPRESS_NESTED_CLAUDE_WARNING=1 archon workflow run ...
```

**Adjust the timeout:** If your environment is slow and hitting the 60-second first-event timeout:

```bash
ARCHON_CLAUDE_FIRST_EVENT_TIMEOUT_MS=120000 archon workflow run ...
```
