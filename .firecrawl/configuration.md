[Skip to content](https://archon.diy/reference/configuration/#_top)

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

- [Overview](https://archon.diy/reference/configuration/#_top)
- [Directory Structure](https://archon.diy/reference/configuration/#directory-structure)
  - [User-Level (~/.archon/)](https://archon.diy/reference/configuration/#user-level-archon)
  - [Repository-Level (.archon/)](https://archon.diy/reference/configuration/#repository-level-archon)
- [Configuration Priority](https://archon.diy/reference/configuration/#configuration-priority)
- [Global Configuration](https://archon.diy/reference/configuration/#global-configuration)
- [Repository Configuration](https://archon.diy/reference/configuration/#repository-configuration)
  - [Claude settingSources](https://archon.diy/reference/configuration/#claude-settingsources)
- [Environment Variables](https://archon.diy/reference/configuration/#environment-variables)
  - [Core](https://archon.diy/reference/configuration/#core)
  - [AI Providers — Claude](https://archon.diy/reference/configuration/#ai-providers--claude)
  - [AI Providers — Codex](https://archon.diy/reference/configuration/#ai-providers--codex)
  - [Platform Adapters — Slack](https://archon.diy/reference/configuration/#platform-adapters--slack)
  - [Platform Adapters — Telegram](https://archon.diy/reference/configuration/#platform-adapters--telegram)
  - [Platform Adapters — Discord](https://archon.diy/reference/configuration/#platform-adapters--discord)
  - [Platform Adapters — GitHub](https://archon.diy/reference/configuration/#platform-adapters--github)
  - [Platform Adapters — Gitea](https://archon.diy/reference/configuration/#platform-adapters--gitea)
  - [Database](https://archon.diy/reference/configuration/#database)
  - [Web UI](https://archon.diy/reference/configuration/#web-ui)
  - [Worktree Management](https://archon.diy/reference/configuration/#worktree-management)
  - [Docker / Deployment](https://archon.diy/reference/configuration/#docker--deployment)
  - [.env File Locations](https://archon.diy/reference/configuration/#env-file-locations)
- [Docker Configuration](https://archon.diy/reference/configuration/#docker-configuration)
- [Command Folder Detection](https://archon.diy/reference/configuration/#command-folder-detection)
- [Examples](https://archon.diy/reference/configuration/#examples)
  - [Minimal Setup (Using Defaults)](https://archon.diy/reference/configuration/#minimal-setup-using-defaults)
  - [Custom AI Preference](https://archon.diy/reference/configuration/#custom-ai-preference)
  - [Project-Specific Settings](https://archon.diy/reference/configuration/#project-specific-settings)
  - [Docker with Custom Volume](https://archon.diy/reference/configuration/#docker-with-custom-volume)
- [Streaming Modes](https://archon.diy/reference/configuration/#streaming-modes)
  - [Stream Mode](https://archon.diy/reference/configuration/#stream-mode)
  - [Batch Mode](https://archon.diy/reference/configuration/#batch-mode)
  - [Platform Defaults](https://archon.diy/reference/configuration/#platform-defaults)
- [Concurrency Settings](https://archon.diy/reference/configuration/#concurrency-settings)
- [Health Check Endpoints](https://archon.diy/reference/configuration/#health-check-endpoints)
- [Troubleshooting](https://archon.diy/reference/configuration/#troubleshooting)
  - [Config Parse Errors](https://archon.diy/reference/configuration/#config-parse-errors)

## On this page

- [Overview](https://archon.diy/reference/configuration/#_top)
- [Directory Structure](https://archon.diy/reference/configuration/#directory-structure)
  - [User-Level (~/.archon/)](https://archon.diy/reference/configuration/#user-level-archon)
  - [Repository-Level (.archon/)](https://archon.diy/reference/configuration/#repository-level-archon)
- [Configuration Priority](https://archon.diy/reference/configuration/#configuration-priority)
- [Global Configuration](https://archon.diy/reference/configuration/#global-configuration)
- [Repository Configuration](https://archon.diy/reference/configuration/#repository-configuration)
  - [Claude settingSources](https://archon.diy/reference/configuration/#claude-settingsources)
- [Environment Variables](https://archon.diy/reference/configuration/#environment-variables)
  - [Core](https://archon.diy/reference/configuration/#core)
  - [AI Providers — Claude](https://archon.diy/reference/configuration/#ai-providers--claude)
  - [AI Providers — Codex](https://archon.diy/reference/configuration/#ai-providers--codex)
  - [Platform Adapters — Slack](https://archon.diy/reference/configuration/#platform-adapters--slack)
  - [Platform Adapters — Telegram](https://archon.diy/reference/configuration/#platform-adapters--telegram)
  - [Platform Adapters — Discord](https://archon.diy/reference/configuration/#platform-adapters--discord)
  - [Platform Adapters — GitHub](https://archon.diy/reference/configuration/#platform-adapters--github)
  - [Platform Adapters — Gitea](https://archon.diy/reference/configuration/#platform-adapters--gitea)
  - [Database](https://archon.diy/reference/configuration/#database)
  - [Web UI](https://archon.diy/reference/configuration/#web-ui)
  - [Worktree Management](https://archon.diy/reference/configuration/#worktree-management)
  - [Docker / Deployment](https://archon.diy/reference/configuration/#docker--deployment)
  - [.env File Locations](https://archon.diy/reference/configuration/#env-file-locations)
- [Docker Configuration](https://archon.diy/reference/configuration/#docker-configuration)
- [Command Folder Detection](https://archon.diy/reference/configuration/#command-folder-detection)
- [Examples](https://archon.diy/reference/configuration/#examples)
  - [Minimal Setup (Using Defaults)](https://archon.diy/reference/configuration/#minimal-setup-using-defaults)
  - [Custom AI Preference](https://archon.diy/reference/configuration/#custom-ai-preference)
  - [Project-Specific Settings](https://archon.diy/reference/configuration/#project-specific-settings)
  - [Docker with Custom Volume](https://archon.diy/reference/configuration/#docker-with-custom-volume)
- [Streaming Modes](https://archon.diy/reference/configuration/#streaming-modes)
  - [Stream Mode](https://archon.diy/reference/configuration/#stream-mode)
  - [Batch Mode](https://archon.diy/reference/configuration/#batch-mode)
  - [Platform Defaults](https://archon.diy/reference/configuration/#platform-defaults)
- [Concurrency Settings](https://archon.diy/reference/configuration/#concurrency-settings)
- [Health Check Endpoints](https://archon.diy/reference/configuration/#health-check-endpoints)
- [Troubleshooting](https://archon.diy/reference/configuration/#troubleshooting)
  - [Config Parse Errors](https://archon.diy/reference/configuration/#config-parse-errors)

# Configuration Reference

Archon supports a layered configuration system with sensible defaults, optional YAML config files, and environment variable overrides. For a quick introduction, see [Getting Started: Configuration](https://archon.diy/getting-started/).

## Directory Structure

[Section titled “Directory Structure”](https://archon.diy/reference/configuration/#directory-structure)

### User-Level (~/.archon/)

[Section titled “User-Level (~/.archon/)”](https://archon.diy/reference/configuration/#user-level-archon)

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

[Section titled “Repository-Level (.archon/)”](https://archon.diy/reference/configuration/#repository-level-archon)

```
.archon/

├── commands/       # Custom commands

│   └── plan.md

├── workflows/      # Workflow definitions (YAML files)

└── config.yaml     # Repo-specific configuration (optional)
```

## Configuration Priority

[Section titled “Configuration Priority”](https://archon.diy/reference/configuration/#configuration-priority)

Settings are loaded in this order (later overrides earlier):

1. **Defaults** \- Sensible built-in defaults
2. **Global Config** \- `~/.archon/config.yaml`
3. **Repo Config** \- `.archon/config.yaml` in repository
4. **Environment Variables** \- Always highest priority

## Global Configuration

[Section titled “Global Configuration”](https://archon.diy/reference/configuration/#global-configuration)

Create `~/.archon/config.yaml` for user-wide preferences:

```
# Default AI assistant

defaultAssistant: claude # or 'codex'

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

# Env-leak gate bypass (last resort — weakens a security control)

# allow_target_repo_keys: false  # Set true to skip the env-leak-gate

                                 # globally for all codebases on this machine.

                                 # `env_leak_gate_disabled` is logged once per

                                 # process per source. See security.md.
```

## Repository Configuration

[Section titled “Repository Configuration”](https://archon.diy/reference/configuration/#repository-configuration)

Create `.archon/config.yaml` in any repository for project-specific settings:

```
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

# Per-repo override for the env-leak-gate bypass.

# Set to `false` to re-enable the gate for THIS repo even when the global

# config has `allow_target_repo_keys: true`. Set to `true` to grant the

# bypass for THIS repo only. Wins over the global flag in either direction.

# allow_target_repo_keys: false
```

### Claude settingSources

[Section titled “Claude settingSources”](https://archon.diy/reference/configuration/#claude-settingsources)

Controls which `CLAUDE.md` files the Claude Agent SDK loads during sessions:

| Value     | Description                                                 |
| --------- | ----------------------------------------------------------- |
| `project` | Load the project’s `CLAUDE.md` (default, always included)   |
| `user`    | Also load `~/.claude/CLAUDE.md` (user’s global preferences) |

**Default**: `['project']` — only project-level instructions are loaded.

Set in global or repo config:

```
assistants:

  claude:

    settingSources:

      - project

      - user
```

This is useful when you maintain coding style or identity preferences in `~/.claude/CLAUDE.md` and want Archon sessions to respect them.

**Default behavior:** The `.archon/` directory is always copied to worktrees automatically (contains artifacts, plans, workflows). Use `copyFiles` only for additional files like `.env` or `.vscode`.

**Defaults behavior:** The app’s bundled default commands and workflows are loaded at runtime and merged with repo-specific ones. Repo commands/workflows override app defaults by name. Set `defaults.loadDefaultCommands: false` or `defaults.loadDefaultWorkflows: false` to disable runtime loading.

**Base branch behavior:** Before creating a worktree, the canonical workspace is synced to the latest code. Resolution order:

1. If `worktree.baseBranch` is set: Uses the configured branch. **Fails with an error** if the branch doesn’t exist on remote (no silent fallback).
2. If omitted: Auto-detects the default branch via `git remote show origin`. Works without any config for standard repos.
3. If auto-detection fails and a workflow references `$BASE_BRANCH`: Fails with an error explaining the resolution chain.

**Docs path behavior:** The `docs.path` setting controls where the `$DOCS_DIR` variable points. When not configured, `$DOCS_DIR` defaults to `docs/`. Unlike `$BASE_BRANCH`, this variable always has a safe default and never throws an error. Configure it when your documentation lives outside the standard `docs/` directory (e.g., `packages/docs-web/src/content/docs`).

## Environment Variables

[Section titled “Environment Variables”](https://archon.diy/reference/configuration/#environment-variables)

Environment variables override all other configuration. They are organized by category below.

### Core

[Section titled “Core”](https://archon.diy/reference/configuration/#core)

| Variable                       | Description                                                            | Default                              |
| ------------------------------ | ---------------------------------------------------------------------- | ------------------------------------ |
| `ARCHON_HOME`                  | Base directory for all Archon-managed files                            | `~/.archon`                          |
| `PORT`                         | HTTP server listen port                                                | `3090` (auto-allocated in worktrees) |
| `LOG_LEVEL`                    | Logging verbosity (`fatal`, `error`, `warn`, `info`, `debug`, `trace`) | `info`                               |
| `BOT_DISPLAY_NAME`             | Bot name shown in batch-mode “starting” messages                       | `Archon`                             |
| `DEFAULT_AI_ASSISTANT`         | Default AI assistant (`claude` or `codex`)                             | `claude`                             |
| `MAX_CONCURRENT_CONVERSATIONS` | Maximum concurrent AI conversations                                    | `10`                                 |
| `SESSION_RETENTION_DAYS`       | Delete inactive sessions older than N days                             | `30`                                 |

### AI Providers — Claude

[Section titled “AI Providers — Claude”](https://archon.diy/reference/configuration/#ai-providers--claude)

| Variable                  | Description                                           | Default     |
| ------------------------- | ----------------------------------------------------- | ----------- |
| `CLAUDE_USE_GLOBAL_AUTH`  | Use global auth from `claude /login` (`true`/`false`) | Auto-detect |
| `CLAUDE_CODE_OAUTH_TOKEN` | Explicit OAuth token (alternative to global auth)     | —           |
| `CLAUDE_API_KEY`          | Explicit API key (alternative to global auth)         | —           |
| `TITLE_GENERATION_MODEL`  | Lightweight model for generating conversation titles  | SDK default |

When `CLAUDE_USE_GLOBAL_AUTH` is unset, Archon auto-detects: it uses explicit tokens if present, otherwise falls back to global auth.

### AI Providers — Codex

[Section titled “AI Providers — Codex”](https://archon.diy/reference/configuration/#ai-providers--codex)

| Variable              | Description                                | Default |
| --------------------- | ------------------------------------------ | ------- |
| `CODEX_ID_TOKEN`      | Codex ID token (from `~/.codex/auth.json`) | —       |
| `CODEX_ACCESS_TOKEN`  | Codex access token                         | —       |
| `CODEX_REFRESH_TOKEN` | Codex refresh token                        | —       |
| `CODEX_ACCOUNT_ID`    | Codex account ID                           | —       |

### Platform Adapters — Slack

[Section titled “Platform Adapters — Slack”](https://archon.diy/reference/configuration/#platform-adapters--slack)

| Variable                 | Description                                        | Default     |
| ------------------------ | -------------------------------------------------- | ----------- |
| `SLACK_BOT_TOKEN`        | Slack bot token (`xoxb-...`)                       | —           |
| `SLACK_APP_TOKEN`        | Slack app-level token for Socket Mode (`xapp-...`) | —           |
| `SLACK_ALLOWED_USER_IDS` | Comma-separated Slack user IDs for whitelist       | Open access |
| `SLACK_STREAMING_MODE`   | Streaming mode (`stream` or `batch`)               | `batch`     |

### Platform Adapters — Telegram

[Section titled “Platform Adapters — Telegram”](https://archon.diy/reference/configuration/#platform-adapters--telegram)

| Variable                    | Description                                     | Default     |
| --------------------------- | ----------------------------------------------- | ----------- |
| `TELEGRAM_BOT_TOKEN`        | Telegram bot token from @BotFather              | —           |
| `TELEGRAM_ALLOWED_USER_IDS` | Comma-separated Telegram user IDs for whitelist | Open access |
| `TELEGRAM_STREAMING_MODE`   | Streaming mode (`stream` or `batch`)            | `stream`    |

### Platform Adapters — Discord

[Section titled “Platform Adapters — Discord”](https://archon.diy/reference/configuration/#platform-adapters--discord)

| Variable                   | Description                                    | Default     |
| -------------------------- | ---------------------------------------------- | ----------- |
| `DISCORD_BOT_TOKEN`        | Discord bot token from Developer Portal        | —           |
| `DISCORD_ALLOWED_USER_IDS` | Comma-separated Discord user IDs for whitelist | Open access |
| `DISCORD_STREAMING_MODE`   | Streaming mode (`stream` or `batch`)           | `batch`     |

### Platform Adapters — GitHub

[Section titled “Platform Adapters — GitHub”](https://archon.diy/reference/configuration/#platform-adapters--github)

| Variable               | Description                                                       | Default                          |
| ---------------------- | ----------------------------------------------------------------- | -------------------------------- |
| `GITHUB_TOKEN`         | GitHub personal access token (also used by `gh` CLI)              | —                                |
| `GH_TOKEN`             | Alias for `GITHUB_TOKEN` (used by GitHub CLI)                     | —                                |
| `WEBHOOK_SECRET`       | HMAC SHA-256 secret for GitHub webhook signature verification     | —                                |
| `GITHUB_ALLOWED_USERS` | Comma-separated GitHub usernames for whitelist (case-insensitive) | Open access                      |
| `GITHUB_BOT_MENTION`   | @mention name the bot responds to in issues/PRs                   | Falls back to `BOT_DISPLAY_NAME` |

### Platform Adapters — Gitea

[Section titled “Platform Adapters — Gitea”](https://archon.diy/reference/configuration/#platform-adapters--gitea)

| Variable               | Description                                                       | Default                          |
| ---------------------- | ----------------------------------------------------------------- | -------------------------------- |
| `GITEA_URL`            | Self-hosted Gitea instance URL (e.g. `https://gitea.example.com`) | —                                |
| `GITEA_TOKEN`          | Gitea personal access token or bot account token                  | —                                |
| `GITEA_WEBHOOK_SECRET` | HMAC SHA-256 secret for Gitea webhook signature verification      | —                                |
| `GITEA_ALLOWED_USERS`  | Comma-separated Gitea usernames for whitelist (case-insensitive)  | Open access                      |
| `GITEA_BOT_MENTION`    | @mention name the bot responds to in issues/PRs                   | Falls back to `BOT_DISPLAY_NAME` |

### Database

[Section titled “Database”](https://archon.diy/reference/configuration/#database)

| Variable       | Description                                       | Default                         |
| -------------- | ------------------------------------------------- | ------------------------------- |
| `DATABASE_URL` | PostgreSQL connection string (omit to use SQLite) | SQLite at `~/.archon/archon.db` |

### Web UI

[Section titled “Web UI”](https://archon.diy/reference/configuration/#web-ui)

| Variable        | Description                                                           | Default         |
| --------------- | --------------------------------------------------------------------- | --------------- |
| `WEB_UI_ORIGIN` | CORS origin for API routes (restrict when exposing publicly)          | `*` (allow all) |
| `WEB_UI_DEV`    | When set, skip serving static frontend (Vite dev server used instead) | —               |

### Worktree Management

[Section titled “Worktree Management”](https://archon.diy/reference/configuration/#worktree-management)

| Variable                     | Description                                          | Default |
| ---------------------------- | ---------------------------------------------------- | ------- |
| `STALE_THRESHOLD_DAYS`       | Days before an inactive worktree is considered stale | `14`    |
| `MAX_WORKTREES_PER_CODEBASE` | Max worktrees per codebase before auto-cleanup       | `25`    |
| `CLEANUP_INTERVAL_HOURS`     | How often the background cleanup service runs        | `6`     |

### Docker / Deployment

[Section titled “Docker / Deployment”](https://archon.diy/reference/configuration/#docker--deployment)

| Variable             | Description                                                              | Default               |
| -------------------- | ------------------------------------------------------------------------ | --------------------- |
| `ARCHON_DATA`        | Host path for Archon data (workspaces, worktrees, artifacts)             | Docker-managed volume |
| `DOMAIN`             | Public domain for Caddy reverse proxy (TLS auto-provisioned)             | —                     |
| `CADDY_BASIC_AUTH`   | Caddy basicauth directive to protect Web UI and API                      | Disabled              |
| `AUTH_USERNAME`      | Username for form-based auth (Caddy forward_auth)                        | —                     |
| `AUTH_PASSWORD_HASH` | Bcrypt hash for form-based auth password (escape `$` as `$$` in Compose) | —                     |
| `COOKIE_SECRET`      | 64-hex-char secret for auth session cookies                              | —                     |
| `AUTH_SERVICE_PORT`  | Port for the auth service container                                      | `9000`                |
| `COOKIE_MAX_AGE`     | Auth cookie lifetime in seconds                                          | `86400`               |

### `.env` File Locations

[Section titled “.env File Locations”](https://archon.diy/reference/configuration/#env-file-locations)

Infrastructure configuration (database URL, platform tokens) is stored in `.env` files:

| Component  | Location             | Purpose                                           |
| ---------- | -------------------- | ------------------------------------------------- |
| **CLI**    | `~/.archon/.env`     | Global infrastructure config (only source loaded) |
| **Server** | `<archon-repo>/.env` | Platform tokens, database                         |

**Important**: The CLI loads `.env` **only** from `~/.archon/.env`. On startup, it explicitly deletes any `DATABASE_URL` that Bun may have auto-loaded from the current working directory’s `.env`, then loads `~/.archon/.env` with `override: true`. This prevents conflicts when running Archon from target projects that have their own database configurations.

**Best practice**: Use `~/.archon/.env` as the single source of truth. If running the server, symlink or copy to the archon repo:

Terminal window

```
# Create global config

mkdir -p ~/.archon

cp .env.example ~/.archon/.env

# Edit with your values

# For server, symlink to repo

ln -s ~/.archon/.env .env
```

## Docker Configuration

[Section titled “Docker Configuration”](https://archon.diy/reference/configuration/#docker-configuration)

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

[Section titled “Command Folder Detection”](https://archon.diy/reference/configuration/#command-folder-detection)

When cloning or switching repositories, Archon looks for commands in this priority order:

1. `.archon/commands/` \- Always searched first
2. Configured folder from `commands.folder` in `.archon/config.yaml` (if specified)

Example `.archon/config.yaml`:

```
commands:

  folder: .claude/commands/archon  # Additional folder to search

  autoLoad: true
```

## Examples

[Section titled “Examples”](https://archon.diy/reference/configuration/#examples)

### Minimal Setup (Using Defaults)

[Section titled “Minimal Setup (Using Defaults)”](https://archon.diy/reference/configuration/#minimal-setup-using-defaults)

No configuration needed. Archon works out of the box with:

- `~/.archon/` for all managed files
- Claude as default AI assistant
- Platform-appropriate streaming modes

### Custom AI Preference

[Section titled “Custom AI Preference”](https://archon.diy/reference/configuration/#custom-ai-preference)

~/.archon/config.yaml

```
defaultAssistant: codex
```

### Project-Specific Settings

[Section titled “Project-Specific Settings”](https://archon.diy/reference/configuration/#project-specific-settings)

```
# .archon/config.yaml in your repo

assistant: claude  # Workflows inherit this provider unless they specify their own

commands:

  autoLoad: true
```

### Docker with Custom Volume

[Section titled “Docker with Custom Volume”](https://archon.diy/reference/configuration/#docker-with-custom-volume)

Terminal window

```
docker run -v /my/data:/.archon ghcr.io/coleam00/archon
```

## Streaming Modes

[Section titled “Streaming Modes”](https://archon.diy/reference/configuration/#streaming-modes)

Each platform adapter supports two streaming modes, configured via environment variable or `~/.archon/config.yaml`.

### Stream Mode

[Section titled “Stream Mode”](https://archon.diy/reference/configuration/#stream-mode)

Messages are sent in real-time as the AI generates responses.

```
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

[Section titled “Batch Mode”](https://archon.diy/reference/configuration/#batch-mode)

Only the final summary message is sent after AI completes processing.

```
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
- Can’t see intermediate steps

**Best for:** Issue trackers and async platforms (GitHub)

### Platform Defaults

[Section titled “Platform Defaults”](https://archon.diy/reference/configuration/#platform-defaults)

| Platform | Default Mode                                       |
| -------- | -------------------------------------------------- |
| Telegram | `stream`                                           |
| Discord  | `batch`                                            |
| Slack    | `batch`                                            |
| GitHub   | `batch`                                            |
| Web UI   | SSE streaming (always real-time, not configurable) |

---

## Concurrency Settings

[Section titled “Concurrency Settings”](https://archon.diy/reference/configuration/#concurrency-settings)

Control how many conversations the system processes simultaneously:

```
MAX_CONCURRENT_CONVERSATIONS=10  # Default: 10
```

**How it works:**

- Conversations are processed with a lock manager
- If the max concurrent limit is reached, new messages are queued
- Prevents resource exhaustion and API rate limits
- Each conversation maintains its own independent context

**Tuning guidance:**

| Resources      | Recommended Setting        |
| -------------- | -------------------------- |
| Low resources  | 3-5                        |
| Standard       | 10 (default)               |
| High resources | 20-30 (monitor API limits) |

---

## Health Check Endpoints

[Section titled “Health Check Endpoints”](https://archon.diy/reference/configuration/#health-check-endpoints)

The application exposes health check endpoints for monitoring:

**Basic Health Check:**

Terminal window

```
curl http://localhost:3090/health
```

Returns: `{"status":"ok"}`

**Database Connectivity:**

Terminal window

```
curl http://localhost:3090/health/db
```

Returns: `{"status":"ok","database":"connected"}`

**Concurrency Status:**

Terminal window

```
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

[Section titled “Troubleshooting”](https://archon.diy/reference/configuration/#troubleshooting)

### Config Parse Errors

[Section titled “Config Parse Errors”](https://archon.diy/reference/configuration/#config-parse-errors)

If your config file has invalid YAML syntax, you’ll see error messages like:

```
[Config] Failed to parse global config at ~/.archon/config.yaml: <error details>

[Config] Using default configuration. Please fix the YAML syntax in your config file.
```

Common YAML syntax issues:

- Incorrect indentation (use spaces, not tabs)
- Missing colons after keys
- Unquoted values with special characters

The application will continue running with default settings until the config file is fixed.

[Edit page](https://github.com/coleam00/Archon/edit/main/packages/docs-web/src/content/docs/reference/configuration.md)

[Previous \\
\\
API Reference](https://archon.diy/reference/api/) [Next \\
\\
Troubleshooting](https://archon.diy/reference/troubleshooting/)
