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
├── workflows/              # Home-scoped workflows (source: 'global')
├── commands/               # Home-scoped commands (source: 'global')
├── scripts/                # Home-scoped scripts (runtime: bun | uv)
├── archon.db               # SQLite database (when DATABASE_URL not set)
└── config.yaml             # Global configuration (optional)
```

Home-scoped `workflows/`, `commands/`, and `scripts/` apply to every project on the machine. Repo-local files at `<repoRoot>/.archon/{workflows,commands,scripts}/` override them by filename (or script name). Each directory supports one level of subfolders for grouping; deeper nesting is ignored. See [Global Workflows](/guides/global-workflows/) for details and dotfiles-sync examples.

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
    settingSources:   # Which sources the Claude SDK loads (default: ['project', 'user'])
      - project       # Project-level <cwd>/.claude/ (CLAUDE.md, skills, commands, agents)
      - user          # User-level ~/.claude/ (CLAUDE.md, skills, commands, agents)
    # Optional: absolute path to the Claude Code executable.
    # Required in compiled Archon binaries when CLAUDE_BIN_PATH is not set.
    # Accepts the native binary (~/.local/bin/claude from the curl installer),
    # the npm-installed cli.js, or the npm platform-package directory
    # (e.g. @anthropic-ai/claude-code-win32-x64 — auto-expanded to claude/claude.exe).
    # Source/dev mode auto-resolves.
    # claudeBinaryPath: /absolute/path/to/claude
  codex:
    model: gpt-5.5
    modelReasoningEffort: medium
    webSearchMode: disabled
    additionalDirectories:
      - /absolute/path/to/other/repo
    # codexBinaryPath: /absolute/path/to/codex  # Optional: Codex CLI path

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

# Model tiers — optional cross-provider presets used by bundled workflows,
# custom workflows, direct chat (`large`), and title generation (`small`).
tiers:
  large: { provider: claude, model: opus }
  medium: { provider: codex, model: gpt-5.5, effort: high }
  small: { provider: pi, model: minimax-m3 }

# Model aliases — optional custom refs for project workflows.
aliases:
  '@reasoning': { provider: claude, model: opus, thinking: { type: enabled, budgetTokens: 8000 } }

```

The `tiers:` block above is no longer hand-edit-only -- you can also set the `small`/`medium`/`large` presets from the console **AI Settings** -> **Model Tiers** panel, or from the CLI with [`archon ai tier set`](/reference/cli/#ai). Connecting your own provider API key or subscription is covered in [Per-user credentials and AI Settings](/getting-started/ai-assistants/#per-user-credentials-and-ai-settings).

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
    model: gpt-5.5
    webSearchMode: live

# Commands configuration
commands:
  folder: .archon/commands
  autoLoad: true

# Worktree settings
worktree:
  baseBranch: main  # Optional: auto-detected from git when not set
  copyFiles:  # Optional: Gitignored files/dirs to copy into new worktrees.
              # `.archon/` is always copied automatically — don't list it.
    - .env
    - .vscode               # Copy entire directory
    - plans/                # Local plans not committed to the team repo
  initSubmodules: true  # Optional: default true — auto-detects .gitmodules and runs
                        # `git submodule update --init --recursive`. Set false to opt out.
  path: .worktrees      # Optional: co-locate worktrees with the repo at
                        # <repoRoot>/.worktrees/<branch> instead of under
                        # ~/.archon/workspaces/<owner>/<repo>/worktrees/.
                        # Must be relative; no absolute, no `..` segments.

# Documentation directory
docs:
  path: docs  # Optional: default is docs/

# Defaults configuration
defaults:
  loadDefaultCommands: true   # Load app's bundled default commands at runtime
  loadDefaultWorkflows: true  # Load app's bundled default workflows at runtime

# Recommended workflows for this project (declared order = pin order in the UI)
# recommendedWorkflows:
#   - archon-fix-github-issue
#   - archon-idea-to-pr
#   - archon-plan

# Per-project environment variables for workflow execution (Claude SDK only)
# Injected into the Claude subprocess env. Use the Web UI Settings panel for secrets.
# env:
#   MY_API_KEY: value
#   CUSTOM_ENDPOINT: https://...

# Model tiers and aliases override global entries with the same name (repo > global).
# tiers:
#   small: { provider: codex, model: gpt-5.5, effort: minimal }
# aliases:
#   '@fast': { provider: claude, model: haiku }

```

Providers with built-in tier defaults (`claude`, `codex`, `pi`, `copilot`, `opencode`) work
without a `tiers:` block. Other providers must configure any tier they use, or resolving
`small`, `medium`, or `large` will fail with a clear configuration error.

### Claude settingSources

Controls which sources the Claude Agent SDK loads during sessions — `CLAUDE.md`, skills, commands, agents, and hooks:

| Value | Description |
|-------|-------------|
| `project` | Load project-level `<cwd>/.claude/` (CLAUDE.md, skills, commands, agents) |
| `user` | Load user-level `~/.claude/` (CLAUDE.md, skills, commands, agents) |

**Default**: `['project', 'user']` — both project-level and user-level sources are loaded.

To restrict a project to project-level resources only (e.g. CI, shared environments, or when `~/.claude/` contains personal commands you don't want surfacing in workflows):

```yaml
assistants:
  claude:
    settingSources:
      - project
```

Set in `~/.archon/config.yaml` (global) or `.archon/config.yaml` (repo-specific).

### Worktree file copying (`worktree.copyFiles`)

`git worktree add` only copies **tracked** files into a new worktree. Anything gitignored — secrets, local planning docs, agent reports, IDE settings, data fixtures — is absent by default. Archon's `worktree.copyFiles` closes that gap: after the worktree is created, each listed path is copied from the canonical repo into the worktree via raw filesystem copy (not git), so gitignored content comes along for the ride.

**Defaults — no config needed for the common case.** `.archon/` is always copied automatically. If you gitignore `.archon/` (or it's just not committed), your custom commands, workflows, and scripts still reach every worktree. You do not need to list `.archon/` in `copyFiles` — it's merged in for you.

**Common entries:**

```yaml
worktree:
  copyFiles:
    - .env                  # local secrets
    - .vscode/              # editor settings
    - .claude/              # per-repo Claude Code config (agents, skills, hooks)
    - plans/                # working docs that aren't committed
    - reports/              # agent-generated markdown reports
    - data/fixtures/        # local-only test data
```

**Semantics:**

- Each entry is a path (file or directory) relative to the repo root — source and destination are always identical. No rename syntax.
- Missing files are silently skipped (`ENOENT` at debug level), so you can list "optional" entries without bookkeeping.
- Directories are copied recursively.
- Per-entry failures are isolated — one bad entry won't abort the rest. Non-ENOENT failures (permissions, disk full) are surfaced as warnings on the environment.
- Path-traversal attempts (entries resolving outside the repo root, or absolute paths on a different drive) are rejected — the entry is logged and skipped.

**Interaction with `worktree.path`:** The copy step runs identically whether worktrees live under `~/.archon/workspaces/<owner>/<repo>/worktrees/` (default) or inside the repo at `<repoRoot>/<worktree.path>/` (repo-local). Both layouts get the same gitignored-file treatment.

**Defaults behavior:** The app's bundled default commands and workflows are loaded at runtime and merged with repo-specific ones. Repo commands/workflows override app defaults by name. Set `defaults.loadDefaultCommands: false` or `defaults.loadDefaultWorkflows: false` to disable runtime loading.

**Submodule behavior:** When a repo contains `.gitmodules`, submodules are initialized in new worktrees by default (git's `worktree add` does not do this). The check is a cheap filesystem probe — repos without submodules pay zero cost. Submodule init failure throws a classified error (credentials, network, timeout) rather than silently producing a worktree with empty submodule directories. Set `worktree.initSubmodules: false` to opt out.

**Base branch behavior:** Before creating a worktree, the canonical workspace is synced to the latest code. Resolution order:
1. If `worktree.baseBranch` is set: Uses the configured branch. **Fails with an error** if the branch doesn't exist on remote (no silent fallback).
2. If omitted: Auto-detects the default branch via `git remote show origin`. Works without any config for standard repos.
3. If auto-detection fails and a workflow references `$BASE_BRANCH`: Fails with an error explaining the resolution chain.

**Docs path behavior:** The `docs.path` setting controls where the `$DOCS_DIR` variable points. When not configured, `$DOCS_DIR` defaults to `docs/`. Unlike `$BASE_BRANCH`, this variable always has a safe default and never throws an error. Configure it when your documentation lives outside the standard `docs/` directory (e.g., `packages/docs-web/src/content/docs`).

### Recommended workflows (`recommendedWorkflows`)

Repo owners curate an **ordered list of recommended workflows** that lives inside the project's own `.archon/config.yaml`. The list is surfaced **pinned on top** of both UI surfaces under a fixed "Recommended for this project" header:

- The **Workflows page** grid renders the pinned cards above a divider, then the rest of the workflows below.
- The **sidebar run dropdown** renders two native `<optgroup>` blocks: `Recommended` (declared order) and `Other workflows`.

```yaml
recommendedWorkflows:
  - archon-fix-github-issue
  - archon-idea-to-pr
  - archon-plan
```

**Semantics:**

- **List order = pin order.** First entry appears first in both UIs.
- Each entry is a **workflow name** matched against the discovered set (bundled + global + project).
- A name that matches **no** discovered workflow is **silently ignored** (debug log). The list is advisory — a stale entry never breaks discovery.
- Search and category filters apply to **both** partitions. If filtering hides all recommended cards, the header is not rendered.
- Key **absent or empty** → flat list, no header, no divider. Zero-config safe.
- The list lives **per-project only** — it is not part of global config (`~/.archon/config.yaml`) and is not per-user.

**Worktree path behavior:** By default, every repo's worktrees live under `~/.archon/workspaces/<owner>/<repo>/worktrees/<branch>` — outside the repo, invisible to the IDE. Set `worktree.path` to opt in to a **repo-local** layout instead: worktrees are created at `<repoRoot>/<worktree.path>/<branch>` so they show up in the file tree and editor workspace. A common choice is `.worktrees`. Because worktrees now live inside the repository tree, you should add the directory to your `.gitignore` (Archon does not modify user-owned files). The configured path must be relative to the repo root; absolute paths and paths containing `..` segments fail loudly at worktree creation rather than silently falling back.

### Container isolation (folder projects)

**Folder projects** run in place by default. Opt into overlay-isolated Docker execution — writes land in an overlay upper layer, not the live root — with the `--container` CLI flag, the `container.enabled` config key, or a workflow's `container.enabled` policy. Valid on both global and repo `.archon/config.yaml` (repo overrides global per-field):

```yaml
container:
  image: archon-runner:latest # runner image tag (default: archon-runner:latest)
  network: bridge # 'bridge' (default) or 'none' (no egress)
  memoryMb: 4096 # hard memory cap in MiB (positive integer)
  pidsLimit: 512 # process cap / fork-bomb guard (positive integer)
  enabled: false # run folder projects in a container without --container (default false)
```

**Selection precedence:** `--container` flag > workflow `container.enabled` > config `container.enabled` > `false`. (A workflow `enabled: false` hard-disables relative to config, but the flag still wins.)

**Write-back mode** is a per-workflow policy (not a config key). After a container run finishes, its overlay diff is reviewed before touching the live root:

```yaml
# In a workflow YAML (.archon/workflows/*.yaml):
container:
  write_back: approve # 'approve' (default) pauses at a write-back gate; 'auto' applies without pausing
```

**Prerequisites:** Docker, and the runner image built once with `bun run build:runner-image` (tags `archon-runner:<version>` + `:latest`). Container mode is **folder-project-only** (a repo project errors). Pausing workflows (approval/interactive gates) **are** supported — a pause `docker stop`s the container (near-zero resources while awaiting a decision) and resume rediscovers and restarts it. `$ARTIFACTS_DIR` is not mounted into the container (see [variables](/reference/variables/)). For the full flow, pause economics, and security posture, see the [Container isolation guide](/guides/container-isolation/) and `packages/isolation/docker/SECURITY.md`.

## Environment Variables

Environment variables override all other configuration. They are organized by category below.

### Core

| Variable | Description | Default |
| --- | --- | --- |
| `ARCHON_HOME` | Base directory for all Archon-managed files. **Ignored in Docker** — the container always uses `/.archon`. | `~/.archon` |
| `PORT` | HTTP server listen port | `3090` (auto-allocated in worktrees) |
| `LOG_LEVEL` | Logging verbosity (`fatal`, `error`, `warn`, `info`, `debug`, `trace`) | `info` |
| `BOT_DISPLAY_NAME` | Bot name shown in batch-mode "starting" messages | `Archon` |
| `DEFAULT_AI_ASSISTANT` | Fallback AI assistant when no config file sets the assistant. Overridden by `defaultAssistant` in global config or `assistant` in repo config. Must match a registered provider id — currently `claude`, `codex`, `pi`, or `copilot`. | `claude` |
| `MAX_CONCURRENT_CONVERSATIONS` | Maximum concurrent AI conversations | `10` |
| `SESSION_RETENTION_DAYS` | Delete inactive sessions older than N days | `30` |
| `ARCHON_VERBOSE_BOOT` | When set to `1`, prints `[archon] loaded N keys from …` lines to stderr at boot. Also enabled by `LOG_LEVEL=debug` or `LOG_LEVEL=trace`. Silent by default to avoid interleaving with interactive command output. | -- |
| `ARCHON_BASH_PATH` | Override the bash executable path used by `bash` nodes and loop `until_bash`. Eagerly validated at resolution time — typos surface immediately instead of as opaque ENOENTs inside the first bash-node fire. | `bash` on Linux/macOS; on Windows, the first existing of the common Git-Bash locations: `%ProgramFiles%\Git\bin\bash.exe`, `%ProgramFiles%\Git\usr\bin\bash.exe`, `%ProgramFiles(x86)%\Git\bin\bash.exe`, `%LOCALAPPDATA%\Programs\Git\bin\bash.exe`, `%USERPROFILE%\scoop\apps\git\current\bin\bash.exe` |

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

### AI Providers -- Copilot (community)

| Variable | Description | Default |
| --- | --- | --- |
| `COPILOT_GITHUB_TOKEN` | Explicit GitHub PAT for the Copilot provider. Always wins over `useLoggedInUser` when set. | -- |
| `COPILOT_BIN_PATH` | Absolute path to the Copilot CLI binary. Required in compiled Archon binaries when `assistants.copilot.copilotCliPath` is not set; auto-detected in dev mode. | -- |

The Copilot provider also reads `assistants.copilot.{model, modelReasoningEffort, copilotCliPath, configDir, enableConfigDiscovery, useLoggedInUser, logLevel}` from `~/.archon/config.yaml` or `.archon/config.yaml`. See the [AI Assistants guide](/getting-started/ai-assistants/) for the full setup.

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

### Per-user GitHub identity (App mode, optional)

An opt-in layer on top of [GitHub App mode](/adapters/github-app-setup/) that lets each teammate connect their own GitHub identity so commits, PR comments, and pushes attribute to the human rather than the bot. The feature gate turns on when `GITHUB_APP_ID` **and** `TOKEN_ENCRYPTION_KEY` are both set; `GITHUB_APP_CLIENT_ID` is additionally required for the connect (device) flow — set all three. Solo `GITHUB_TOKEN` installs and App-for-bot-only installs are unaffected.

| Variable | Description | Default |
| --- | --- | --- |
| `GITHUB_APP_CLIENT_ID` | The App's **Client ID** (starts with `Iv1.`/`Iv23…`, distinct from the numeric `GITHUB_APP_ID`). Required for the device flow that connects per-user identities. | -- |
| `TOKEN_ENCRYPTION_KEY` | 64-char hex (32 bytes; `openssl rand -hex 32`) used to encrypt stored per-user tokens at rest (AES-256-GCM). **Per-user GitHub identity** requires this + `GITHUB_APP_ID`. **AI credential vault** auto-provisions its own key at `~/.archon/credential-key` — this env var overrides that file on managed/multi-user deploys. **Rotating it invalidates all stored user credentials** — everyone must reconnect. | -- |
| `ARCHON_ALLOW_ORG_GITHUB_TOKEN_FALLBACK` | When `false` (default), a workflow run by an **unconnected** user has `GH_TOKEN`/`GITHUB_TOKEN` scrubbed (so `gh`/`git` fail) rather than silently using the shared org/bot token. Set `true` to opt back into the shared token. | `false` |
| `ARCHON_WEB_AUTH_HEADER` | Name of the reverse-proxy-set header Archon trusts to identify the web user (reverse-proxy fallback; still honored alongside Better Auth web login below). Only safe when Archon is reachable **solely** through the proxy on a loopback bind — on a public bind the header is forgeable. Absent header → unattributed (never elevated). | `X-Archon-User` |

To connect once the vars are set: `archon auth github` (CLI), `/archon connect github` (Slack), or the Web UI **Settings → Connect GitHub** card.

### Web UI login (Better Auth, optional)

Real per-user email/password login for the Web UI, mounted at `/api/auth/*` by [Better Auth](https://better-auth.com). **Opt-in and Postgres-only**: enabled only when **both** `DATABASE_URL` (Postgres) and `BETTER_AUTH_SECRET` are set. SQLite/solo installs can never enable it and behave exactly as before (no login UI). It supersedes the single-user `auth-service` sidecar; the `ARCHON_WEB_AUTH_HEADER` trust above remains a fallback for reverse-proxy deploys.

A Better Auth session resolves to the **canonical** `remote_agent_users` row via the `web` platform identity, so chat/CLI/forge identities and the `role` column live on the one Archon user — Better Auth is only the login mechanism. Better Auth owns four tables prefixed `remote_agent_auth_*` (`user`/`session`/`account`/`verification`), applied automatically on startup. Every web request resolves a `{ userId, role }` auth context (session first, then the trusted header); `role` defaults to `admin` and visibility stays open. `GET /api/workflows/runs?mine=true` and `GET /api/conversations?mine=true` are non-enforcing "my" filters that prove the scoping seam — they are not a security boundary.

| Variable | Description | Default |
| --- | --- | --- |
| `BETTER_AUTH_SECRET` | Session signing secret, **≥32 chars** (`openssl rand -base64 32`). Its presence (with `DATABASE_URL`) is what enables web login. Boot fails fast if set but too short. | -- |
| `BETTER_AUTH_URL` | Public base URL. Omit for same-origin deploys (inferred from the request); set only behind a fixed-origin reverse proxy. | inferred |
| `BETTER_AUTH_TRUSTED_ORIGINS` | Comma-separated extra origins allowed for CSRF/cross-origin (beyond same-origin). | -- |
| `ARCHON_AUTH_ALLOWED_EMAILS` | Comma-separated invite allowlist for signup (case-insensitive). Set this to invite teammates. | -- |
| `ARCHON_AUTH_OPEN_SIGNUP` | `true` allows open public signup when no allowlist is set. Default (unset) + no allowlist = signup **disabled** (login only). | `false` |
| `ARCHON_WEB_AUTH_REQUIRED` | When web auth is enabled, gate every `/api/*` request server-side (401 without a session/identity), except `/api/auth/*` and `/api/health*`. `false` keeps login-UI-only. | on (when enabled) |

Signup uses email + password (no email verification by default). **Signup posture:** allowlist set → invite-gated (403 for non-listed emails); no allowlist + `ARCHON_AUTH_OPEN_SIGNUP=true` → open; otherwise **disabled** (login only, with a boot WARN) so enabling auth never silently opens public registration. Existing sessions remain valid until expiry even if an email is later removed from the allowlist. When `ARCHON_WEB_AUTH_REQUIRED` is on (default), Better Auth is the real access gate, so the Caddy `forward_auth` sidecar can be retired.

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
| `ARCHON_DATA` | Host path for Archon data (workspaces, worktrees, artifacts). Compose-only — read by `docker-compose.yml` to choose the bind-mount source for `/.archon`; not read by Archon source code. | Docker-managed volume |
| `ARCHON_USER_HOME` | Host path for `/home/appuser` (Claude/Codex/Pi config, `~/.gitconfig`, shell history). Compose-only — read by `docker-compose.yml` to choose the bind-mount source for `/home/appuser`; not read by Archon source code. Persisted by default to a Docker-managed volume so user state survives rebuilds. | Docker-managed volume |
| `DOMAIN` | Public domain for Caddy reverse proxy (TLS auto-provisioned) | -- |
| `CADDY_BASIC_AUTH` | Caddy basicauth directive to protect Web UI and API | Disabled |
| `AUTH_USERNAME` | Username for form-based auth (Caddy forward_auth) | -- |
| `AUTH_PASSWORD_HASH` | Bcrypt hash for form-based auth password (escape `$` as `$$` in Compose) | -- |
| `COOKIE_SECRET` | 64-hex-char secret for auth session cookies | -- |
| `AUTH_SERVICE_PORT` | Port for the auth service container | `9000` |
| `COOKIE_MAX_AGE` | Auth cookie lifetime in seconds | `86400` |

### Telemetry

Archon sends a few anonymous events — `archon_started` (once per process), `archon_active` (daily server heartbeat), `chat_turn_handled` (direct chat turn — platform, provider, model, duration, and usage totals; never message content), `workflow_invoked` (workflow start), `workflow_completed`/`workflow_failed` (run outcome), `workflow_approval_resolved` (binary approve/reject), and `codebase_registered` (pure count — no name/path/URL). Categorical only: workflow name (real for bundled workflows, `"custom"` for your own), platform, provider id (model id on `workflow_invoked`), node shape and feature flags, outcome/duration, aggregate usage totals (tokens/cost/loop iterations), a fixed-enum failure class (never error text), deployment shape (adapter/db/auth booleans), OS/arch/version, and a random install UUID. No code, prompts, paths, IP, geo, or error text. Any one of the variables below disables it. See `archon telemetry status` to inspect the live state.

| Variable | Description | Default |
| --- | --- | --- |
| `ARCHON_TELEMETRY_DISABLED` | Set to `1` to disable anonymous telemetry | -- |
| `DO_NOT_TRACK` | Set to `1` to disable telemetry (de facto standard honored by Astro, Bun, Prisma, etc.) | -- |
| `CI` | When set to `true` (case-insensitive), telemetry is auto-disabled so fork CI runs don't send events | -- |
| `POSTHOG_API_KEY` | Set to `off` / `0` / `false` / `disabled` / empty to disable; set to a `phc_*` key to use a custom PostHog project | Built-in key |
| `POSTHOG_HOST` | Custom PostHog instance URL (first failure on a custom host logs at `warn`) | `https://us.i.posthog.com` |

### `.env` File Locations

Archon keys env loading on **directory ownership, not filename**. `.archon/` (at `~/` or `<cwd>/`) is archon-owned. Anything else is yours.

| Path | Stripped at boot? | Archon loads? | `archon setup` writes? |
| --- | --- | --- | --- |
| `<cwd>/.env` | **yes** (safety guard) | never | never |
| `<cwd>/.archon/.env` | no | yes (repo scope, overrides user scope) | yes iff `--scope project` |
| `~/.archon/.env` | no | yes (user scope) | yes iff `--scope home` (default) |

**Load order at boot** (every entry point — CLI and server):

1. Strip keys Bun auto-loaded from `<cwd>/.env`, `.env.local`, `.env.development`, `.env.production` (prevents target-repo env from leaking into Archon).
2. Load `~/.archon/.env` with `override: true` (archon config wins over shell-inherited vars).
3. Load `<cwd>/.archon/.env` with `override: true` (repo scope wins over user scope).

**Operator log lines** (stderr, emitted only when there is something to report):

```
[archon] stripped 2 keys from /path/to/target-repo (.env, .env.local) to prevent target repo env from leaking into Archon processes
```

The `[archon] loaded N keys from …` lines are suppressed by default (they would otherwise interleave with `archon setup`/`archon doctor` checklist output). To enable them, set `ARCHON_VERBOSE_BOOT=1` or `LOG_LEVEL=debug` before running:

```
[archon] loaded 3 keys from ~/.archon/.env
[archon] loaded 2 keys from /path/to/target-repo/.archon/.env (repo scope, overrides user scope)
```

**Which file should I use?**

- **`~/.archon/.env`** — user-wide defaults (your personal `SLACK_WEBHOOK`, `DATABASE_URL`, etc.). Applies to every project.
- **`<cwd>/.archon/.env`** — per-project overrides. Different webhook per repo, different DB per environment, etc.
- **`<cwd>/.env`** — **your app's** env file. Archon does not read this file; it strips the keys at boot so they do not leak into Archon's process.

```bash
# User-wide
mkdir -p ~/.archon
cp .env.example ~/.archon/.env

# Per-project override (e.g. a different Slack webhook for this repo)
mkdir -p /path/to/repo/.archon
printf 'SLACK_WEBHOOK=https://hooks.slack.com/...\n' > /path/to/repo/.archon/.env
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
