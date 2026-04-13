---
title: Configuration Reference
description: Full reference for Archon's layered configuration system including YAML config, environment variables, and streaming modes.
category: reference
area: config
audience: [user, operator]
status: current
sidebar:
  order: 6
---

Archon supports a layered configuration system with sensible defaults, optional YAML config files, and environment variable overrides. For a quick introduction, see [Getting Started: Configuration](/getting-started/).

## Directory Structure

### User-Level (~/.archon/)

```
~/.archon/
├── workspaces/owner/repo/  # Project-centric layout
│   ├── source/             # Clone or symlink -> local path
│   ├── worktrees/          # Git worktrees for this project
│   ├── artifacts/          # Workflow artifacts
│   └── logs/               # Workflow execution logs
├── archon.db               # SQLite database (when DATABASE_URL not set)
└── config.yaml             # Global configuration (optional)
```

### Repository-Level (.archon/)

```
.archon/
├── commands/       # Custom commands
│   └── plan.md
├── workflows/      # Workflow definitions (YAML files)
└── config.yaml     # Repo-specific configuration (optional)
```

## Configuration Priority

Settings are loaded in this order (later overrides earlier):

1. **Defaults** - Sensible built-in defaults
2. **Global Config** - `~/.archon/config.yaml`
3. **Repo Config** - `.archon/config.yaml` in repository
4. **Environment Variables** - Always highest priority

## Global Configuration

Create `~/.archon/config.yaml` for user-wide preferences:

```yaml
# Default AI assistant
defaultAssistant: claude # must match a registered provider (e.g. claude, codex)

# Assistant defaults
assistants:
  claude:
    model: sonnet
    settingSources:   # Which CLAUDE.md files the SDK loads (default: ['project'])
      - project       # Project-level CLAUDE.md (always recommended)
      - user          # Also load ~/.claude/CLAUDE.md (global preferences)
  codex:
    model: gpt-5.3-codex
    modelReasoningEffort: medium
    webSearchMode: disabled
    additionalDirectories:
      - /absolute/path/to/other/repo

# Streaming preferences per platform
streaming:
  telegram: stream # 'stream' or 'batch'
  discord: batch
  slack: batch
  github: batch

# Custom paths (usually not needed)
paths:
  workspaces: ~/.archon/workspaces
  worktrees: ~/.archon/worktrees

# Concurrency limits
concurrency:
  maxConversations: 10

```

## Repository Configuration

Create `.archon/config.yaml` in any repository for project-specific settings:

```yaml
# AI assistant for this project (used as default provider for workflows)
assistant: claude

# Assistant defaults (override global)
assistants:
  claude:
    model: sonnet
    settingSources:  # Override global settingSources for this repo
      - project
  codex:
    model: gpt-5.3-codex
    webSearchMode: live

# Commands configuration
commands:
  folder: .archon/commands
  autoLoad: true

# Worktree settings
worktree:
  baseBranch: main  # Optional: auto-detected from git when not set
  copyFiles:  # Optional: Additional files to copy to worktrees
    - .env.example -> .env  # Rename during copy
    - .vscode               # Copy entire directory

# Documentation directory
docs:
  path: docs  # Optional: default is docs/

# Defaults configuration
defaults:
  loadDefaultCommands: true   # Load app's bundled default commands at runtime
  loadDefaultWorkflows: true  # Load app's bundled default workflows at runtime

# Per-project environment variables for workflow execution (Claude SDK only)
# Injected into the Claude subprocess env. Use the Web UI Settings panel for secrets.
# env:
#   MY_API_KEY: value
#   CUSTOM_ENDPOINT: https://...

```

### Claude settingSources

Controls which `CLAUDE.md` files the Claude Agent SDK loads during sessions:

| Value | Description |
|-------|-------------|
| `project` | Load the project's `CLAUDE.md` (default, always included) |
| `user` | Also load `~/.claude/CLAUDE.md` (user's global preferences) |

**Default**: `['project']` -- only project-level instructions are loaded.

Set in global or repo config:
```yaml
assistants:
  claude:
    settingSources:
      - project
      - user
```

This is useful when you maintain coding style or identity preferences in `~/.claude/CLAUDE.md` and want Archon sessions to respect them.

**Default behavior:** The `.archon/` directory is always copied to worktrees automatically (contains artifacts, plans, workflows). Use `copyFiles` only for additional files like `.env` or `.vscode`.

**Defaults behavior:** The app's bundled default commands and workflows are loaded at runtime and merged with repo-specific ones. Repo commands/workflows override app defaults by name. Set `defaults.loadDefaultCommands: false` or `defaults.loadDefaultWorkflows: false` to disable runtime loading.

**Base branch behavior:** Before creating a worktree, the canonical workspace is synced to the latest code. Resolution order:
1. If `worktree.baseBranch` is set: Uses the configured branch. **Fails with an error** if the branch doesn't exist on remote (no silent fallback).
2. If omitted: Auto-detects the default branch via `git remote show origin`. Works without any config for standard repos.
3. If auto-detection fails and a workflow references `$BASE_BRANCH`: Fails with an error explaining the resolution chain.

**Docs path behavior:** The `docs.path` setting controls where the `$DOCS_DIR` variable points. When not configured, `$DOCS_DIR` defaults to `docs/`. Unlike `$BASE_BRANCH`, this variable always has a safe default and never throws an error. Configure it when your documentation lives outside the standard `docs/` directory (e.g., `packages/docs-web/src/content/docs`).

## Environment Variables

Environment variables override all other configuration. They are organized by category below.

### Core

| Variable | Description | Default |
| --- | --- | --- |
| `ARCHON_HOME` | Base directory for all Archon-managed files | `~/.archon` |
| `PORT` | HTTP server listen port | `3090` (auto-allocated in worktrees) |
| `LOG_LEVEL` | Logging verbosity (`fatal`, `error`, `warn`, `info`, `debug`, `trace`) | `info` |
| `BOT_DISPLAY_NAME` | Bot name shown in batch-mode "starting" messages | `Archon` |
| `DEFAULT_AI_ASSISTANT` | Default AI assistant (must match a registered provider) | `claude` |
| `MAX_CONCURRENT_CONVERSATIONS` | Maximum concurrent AI conversations | `10` |
| `SESSION_RETENTION_DAYS` | Delete inactive sessions older than N days | `30` |
| `ARCHON_SUPPRESS_NESTED_CLAUDE_WARNING` | When set to `1`, suppresses the stderr warning emitted when `archon` is run inside a Claude Code session | -- |

### AI Providers -- Claude

| Variable | Description | Default |
| --- | --- | --- |
| `CLAUDE_USE_GLOBAL_AUTH` | Use global auth from `claude /login` (`true`/`false`) | Auto-detect |
| `CLAUDE_CODE_OAUTH_TOKEN` | Explicit OAuth token (alternative to global auth) | -- |
| `CLAUDE_API_KEY` | Explicit API key (alternative to global auth) | -- |
| `TITLE_GENERATION_MODEL` | Lightweight model for generating conversation titles | SDK default |
| `ARCHON_CLAUDE_FIRST_EVENT_TIMEOUT_MS` | Timeout (ms) before Claude subprocess is considered hung (throws with diagnostic log) | `60000` |

When `CLAUDE_USE_GLOBAL_AUTH` is unset, Archon auto-detects: it uses explicit tokens if present, otherwise falls back to global auth.

### AI Providers -- Codex

| Variable | Description | Default |
| --- | --- | --- |
| `CODEX_ID_TOKEN` | Codex ID token (from `~/.codex/auth.json`) | -- |
| `CODEX_ACCESS_TOKEN` | Codex access token | -- |
| `CODEX_REFRESH_TOKEN` | Codex refresh token | -- |
| `CODEX_ACCOUNT_ID` | Codex account ID | -- |

### Platform Adapters -- Slack

| Variable | Description | Default |
| --- | --- | --- |
| `SLACK_BOT_TOKEN` | Slack bot token (`xoxb-...`) | -- |
| `SLACK_APP_TOKEN` | Slack app-level token for Socket Mode (`xapp-...`) | -- |
| `SLACK_ALLOWED_USER_IDS` | Comma-separated Slack user IDs for whitelist | Open access |
| `SLACK_STREAMING_MODE` | Streaming mode (`stream` or `batch`) | `batch` |

### Platform Adapters -- Telegram

| Variable | Description | Default |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token from @BotFather | -- |
| `TELEGRAM_ALLOWED_USER_IDS` | Comma-separated Telegram user IDs for whitelist | Open access |
| `TELEGRAM_STREAMING_MODE` | Streaming mode (`stream` or `batch`) | `stream` |

### Platform Adapters -- Discord

| Variable | Description | Default |
| --- | --- | --- |
| `DISCORD_BOT_TOKEN` | Discord bot token from Developer Portal | -- |
| `DISCORD_ALLOWED_USER_IDS` | Comma-separated Discord user IDs for whitelist | Open access |
| `DISCORD_STREAMING_MODE` | Streaming mode (`stream` or `batch`) | `batch` |

### Platform Adapters -- GitHub

| Variable | Description | Default |
| --- | --- | --- |
| `GITHUB_TOKEN` | GitHub personal access token (also used by `gh` CLI) | -- |
| `GH_TOKEN` | Alias for `GITHUB_TOKEN` (used by GitHub CLI) | -- |
| `WEBHOOK_SECRET` | HMAC SHA-256 secret for GitHub webhook signature verification | -- |
| `GITHUB_ALLOWED_USERS` | Comma-separated GitHub usernames for whitelist (case-insensitive) | Open access |
| `GITHUB_BOT_MENTION` | @mention name the bot responds to in issues/PRs | Falls back to `BOT_DISPLAY_NAME` |

### Platform Adapters -- Gitea

| Variable | Description | Default |
| --- | --- | --- |
| `GITEA_URL` | Self-hosted Gitea instance URL (e.g. `https://gitea.example.com`) | -- |
| `GITEA_TOKEN` | Gitea personal access token or bot account token | -- |
| `GITEA_WEBHOOK_SECRET` | HMAC SHA-256 secret for Gitea webhook signature verification | -- |
| `GITEA_ALLOWED_USERS` | Comma-separated Gitea usernames for whitelist (case-insensitive) | Open access |
| `GITEA_BOT_MENTION` | @mention name the bot responds to in issues/PRs | Falls back to `BOT_DISPLAY_NAME` |

### Database

| Variable | Description | Default |
| --- | --- | --- |
| `DATABASE_URL` | PostgreSQL connection string (omit to use SQLite) | SQLite at `~/.archon/archon.db` |

### Web UI

| Variable | Description | Default |
| --- | --- | --- |
| `WEB_UI_ORIGIN` | CORS origin for API routes (restrict when exposing publicly) | `*` (allow all) |
| `WEB_UI_DEV` | When set, skip serving static frontend (Vite dev server used instead) | -- |

### Worktree Management

| Variable | Description | Default |
| --- | --- | --- |
| `STALE_THRESHOLD_DAYS` | Days before an inactive worktree is considered stale | `14` |
| `MAX_WORKTREES_PER_CODEBASE` | Max worktrees per codebase before auto-cleanup | `25` |
| `CLEANUP_INTERVAL_HOURS` | How often the background cleanup service runs | `6` |

### Docker / Deployment

| Variable | Description | Default |
| --- | --- | --- |
| `ARCHON_DATA` | Host path for Archon data (workspaces, worktrees, artifacts) | Docker-managed volume |
| `DOMAIN` | Public domain for Caddy reverse proxy (TLS auto-provisioned) | -- |
| `CADDY_BASIC_AUTH` | Caddy basicauth directive to protect Web UI and API | Disabled |
| `AUTH_USERNAME` | Username for form-based auth (Caddy forward_auth) | -- |
| `AUTH_PASSWORD_HASH` | Bcrypt hash for form-based auth password (escape `$` as `$$` in Compose) | -- |
| `COOKIE_SECRET` | 64-hex-char secret for auth session cookies | -- |
| `AUTH_SERVICE_PORT` | Port for the auth service container | `9000` |
| `COOKIE_MAX_AGE` | Auth cookie lifetime in seconds | `86400` |

### `.env` File Locations

Infrastructure configuration (database URL, platform tokens) is stored in `.env` files:

| Component | Location | Purpose |
|-----------|----------|---------|
| **CLI** | `~/.archon/.env` | Global infrastructure config; CWD .env keys stripped first, then loaded with `override: true` (Archon config wins over shell-inherited vars) |
| **Server (dev)** | `<archon-repo>/.env` + `~/.archon/.env` | Repo `.env` for platform tokens; `~/.archon/.env` loaded with `override: true` |
| **Server (binary)** | `~/.archon/.env` | Single source of truth (repo `.env` path is not available in compiled binaries) |

**How it works**: At startup, the CLI and server strip all keys that Bun auto-loaded from the current working directory (`.env`, `.env.local`, `.env.development`, `.env.production`) and any nested Claude Code session markers (`CLAUDECODE`, `CLAUDE_CODE_*` except auth vars) before loading `~/.archon/.env`. This ensures target repo keys and nested-session guards are fully removed from `process.env` before any application code runs.

**Best practice**: Use `~/.archon/.env` as the single source of truth:

```bash
# Create global config
mkdir -p ~/.archon
cp .env.example ~/.archon/.env
# Edit with your values
```

## Docker Configuration

In Docker containers, paths are automatically set:

```
/.archon/
├── workspaces/owner/repo/
│   ├── source/
│   ├── worktrees/
│   ├── artifacts/
│   └── logs/
└── archon.db
```

Environment variables still work and override defaults.

## Command Folder Detection

When cloning or switching repositories, Archon looks for commands in this priority order:

1. `.archon/commands/` - Always searched first
2. Configured folder from `commands.folder` in `.archon/config.yaml` (if specified)

Example `.archon/config.yaml`:
```yaml
commands:
  folder: .claude/commands/archon  # Additional folder to search
  autoLoad: true
```

## Examples

### Minimal Setup (Using Defaults)

No configuration needed. Archon works out of the box with:

- `~/.archon/` for all managed files
- Claude as default AI assistant
- Platform-appropriate streaming modes

### Custom AI Preference

```yaml
# ~/.archon/config.yaml
defaultAssistant: codex
```

### Project-Specific Settings

```yaml
# .archon/config.yaml in your repo
assistant: claude  # Workflows inherit this provider unless they specify their own
commands:
  autoLoad: true
```

### Docker with Custom Volume

```bash
docker run -v /my/data:/.archon ghcr.io/coleam00/archon
```

## Streaming Modes

Each platform adapter supports two streaming modes, configured via environment variable or `~/.archon/config.yaml`.

### Stream Mode

Messages are sent in real-time as the AI generates responses.

```ini
TELEGRAM_STREAMING_MODE=stream
SLACK_STREAMING_MODE=stream
DISCORD_STREAMING_MODE=stream
```

**Pros:**
- Real-time feedback and progress indication
- More interactive and engaging
- See AI reasoning as it works

**Cons:**
- More API calls to platform
- May hit rate limits with very long responses
- Creates many messages/comments

**Best for:** Interactive chat platforms (Telegram)

### Batch Mode

Only the final summary message is sent after AI completes processing.

```ini
TELEGRAM_STREAMING_MODE=batch
SLACK_STREAMING_MODE=batch
DISCORD_STREAMING_MODE=batch
```

**Pros:**
- Single coherent message/comment
- Fewer API calls
- No spam or clutter

**Cons:**
- No progress indication during processing
- Longer wait for first response
- Can't see intermediate steps

**Best for:** Issue trackers and async platforms (GitHub)

### Platform Defaults

| Platform | Default Mode |
|----------|-------------|
| Telegram | `stream` |
| Discord  | `batch` |
| Slack    | `batch` |
| GitHub   | `batch` |
| Web UI   | SSE streaming (always real-time, not configurable) |

---

## Concurrency Settings

Control how many conversations the system processes simultaneously:

```ini
MAX_CONCURRENT_CONVERSATIONS=10  # Default: 10
```

**How it works:**
- Conversations are processed with a lock manager
- If the max concurrent limit is reached, new messages are queued
- Prevents resource exhaustion and API rate limits
- Each conversation maintains its own independent context

**Tuning guidance:**

| Resources | Recommended Setting |
|-----------|-------------------|
| Low resources | 3-5 |
| Standard | 10 (default) |
| High resources | 20-30 (monitor API limits) |

---

## Health Check Endpoints

The application exposes health check endpoints for monitoring:

**Basic Health Check:**
```bash
curl http://localhost:3090/health
```
Returns: `{"status":"ok"}`

**Database Connectivity:**
```bash
curl http://localhost:3090/health/db
```
Returns: `{"status":"ok","database":"connected"}`

**Concurrency Status:**
```bash
curl http://localhost:3090/health/concurrency
```
Returns: `{"status":"ok","active":0,"queued":0,"maxConcurrent":10}`

**Use cases:**
- Docker healthcheck configuration
- Load balancer health checks
- Monitoring and alerting systems (Prometheus, Datadog, etc.)
- CI/CD deployment verification

---

## Troubleshooting

### Config Parse Errors

If your config file has invalid YAML syntax, you'll see error messages like:

```
[Config] Failed to parse global config at ~/.archon/config.yaml: <error details>
[Config] Using default configuration. Please fix the YAML syntax in your config file.
```

Common YAML syntax issues:
- Incorrect indentation (use spaces, not tabs)
- Missing colons after keys
- Unquoted values with special characters

The application will continue running with default settings until the config file is fixed.
