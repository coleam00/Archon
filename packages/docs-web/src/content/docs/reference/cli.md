---
title: CLI Reference
description: Complete reference for the Archon command-line interface and all available commands.
category: reference
area: cli
audience: [user]
status: current
sidebar:
  order: 3
---

Run AI-powered workflows from your terminal.

## Prerequisites

1. Clone the repository and install dependencies:
   ```bash
   git clone https://github.com/coleam00/Archon
   cd Archon
   bun install
   ```

2. Make CLI globally available (recommended):
   ```bash
   cd packages/cli
   bun link
   ```
   This creates an `archon` command available from anywhere.

3. Authenticate with Claude:
   ```bash
   claude /login
   ```

**Note:** Examples below use `archon` (after `bun link`). If you skip step 2, use `bun run cli` from the repo directory instead.

## Quick Start

```bash
# List available workflows (requires git repository)
archon workflow list --cwd /path/to/repo

# Run a workflow (auto-creates isolated worktree by default)
archon workflow run assist --cwd /path/to/repo "Explain the authentication flow"

# Explicit branch name for the worktree
archon workflow run plan --cwd /path/to/repo --branch feature-auth "Add OAuth support"

# Opt out of isolation (run in live checkout)
archon workflow run assist --cwd /path/to/repo --no-worktree "Quick question"
```

**Note:** `workflow run`/`status`/`resume` and the `isolation` commands require running from within a git repository (subdirectories resolve to the repo root). The `version`, `help`, `chat`, `setup`, `serve`, `doctor`, `providers`, `config`, `health`, `update-check`, `codebase`, `conversation`, and the read-only `workflow` subcommands (`get`, `runs`, `inspect`, `artifacts`) work anywhere.

## Reads vs. mutations (two-layer transport)

Management commands follow a two-layer model:

- **Reads** (`list`, `get`, `inspect`, `messages`, `show`, `runs`, `artifacts`, `providers list`) read the database / filesystem **directly** and work **without a running server**.
- **Mutations** (`register`, `delete`, `env set/delete`, `create`, `update`, `cancel`, `send`, `title`, `config assistant --model`) go through the REST API, so they **require a running server**. Start one with `archon serve` (or `bun run dev:server`). If the server is unreachable, the command fails with exit code 1 and a clear message.

The server URL defaults to `http://localhost:3090`; override with the `--server-url <url>` flag or the `ARCHON_SERVER_URL` environment variable.

## Commands

### `chat <message>`

Send a message to the orchestrator for a one-off AI interaction.

```bash
archon chat "What does the orchestrator do?"
```

### `setup`

Interactive setup wizard for credentials and configuration.

```bash
archon setup                      # writes ~/.archon/.env (home scope, default)
archon setup --scope project      # writes <cwd>/.archon/.env instead
archon setup --force              # overwrite instead of merging (backup still written)
archon setup --spawn              # open in a new terminal window
```

**Flags:**

| Flag | Effect |
|------|--------|
| `--scope home` | Write to `~/.archon/.env` (default). Applies to every project. |
| `--scope project` | Write to `<cwd>/.archon/.env`. Overrides user scope for this repo only. |
| `--force` | Overwrite the target file wholesale instead of merging. A timestamped backup is still written. |
| `--spawn` | Open setup wizard in a new terminal window. |

**Write safety**: `archon setup` never writes to `<cwd>/.env` — that file belongs to you. The wizard always targets one archon-owned file chosen by `--scope`, merges into existing content (so user-added keys survive), and writes a timestamped backup before every rewrite (e.g. `~/.archon/.env.archon-backup-2026-04-20T09-28-11-000Z`).

### `doctor`

Verify your Archon setup. Runs a checklist of common failure points: Claude binary spawn, gh CLI auth, Pi auth (when Pi is configured as default), database reachability, workspace writability, bundled defaults, telemetry state, and adapter token pings (Slack/Telegram, best-effort).

```bash
archon doctor
```

Exit code 0 if all checks pass or are skipped; 1 if any critical check fails. Adapter pings degrade to `skip` on network errors — a flaky connection does not flip the result red.

Also runs automatically at the end of `archon setup` (optional).

### `telemetry status`

Show the current anonymous telemetry state: whether it is enabled, the opt-out reason if not, the install UUID, the active PostHog host, and the key source.

```bash
archon telemetry status
```

Useful for verifying that an opt-out env var (`DO_NOT_TRACK=1`, `ARCHON_TELEMETRY_DISABLED=1`, `CI=true`, `POSTHOG_API_KEY=off`) is being picked up. Inspecting status never creates a `telemetry-id` file while opted out.

### `telemetry reset`

Rotate the persisted anonymous install UUID at `~/.archon/telemetry-id`. The previous ID is overwritten and not recoverable.

```bash
archon telemetry reset
```

Exit code 0 on success; 1 if the ID file cannot be written.

### `workflow list`

List workflows available in target directory.

```bash
archon workflow list --cwd /path/to/repo

# Machine-readable output for scripting
archon workflow list --cwd /path/to/repo --json
```

Discovers workflows from `.archon/workflows/` (recursive), `~/.archon/workflows/` (global, home-scoped), and bundled defaults. See [Global Workflows](/guides/global-workflows/).

**Flags:**

| Flag | Effect |
|------|--------|
| `--cwd <path>` | Target directory (required for most use cases) |
| `--json` | Output machine-readable JSON instead of formatted text |

With `--json`, outputs `{ "workflows": [...], "errors": [...] }`. Optional fields (`provider`, `model`, `modelReasoningEffort`, `webSearchMode`) are omitted when not set on a workflow.

### `workflow run <name> [message]`

Run a workflow with an optional user message.

```bash
# Basic usage
archon workflow run assist --cwd /path/to/repo "What does this function do?"

# With isolation
archon workflow run plan --cwd /path/to/repo --branch feature-x "Add caching"
```

Progress events (node start/complete/fail/skip, approval gates) are written to stderr during execution.

**Flags:**

| Flag | Effect |
|------|--------|
| `--cwd <path>` | Target directory (required for most use cases) |
| `--branch <name>` | Explicit branch name for the worktree |
| `--from <branch>`, `--from-branch <branch>` | Override base branch (start-point for worktree) |
| `--no-worktree` | Opt out of isolation -- run directly in live checkout |
| `--resume` | Resume from last failed run at the working path (skips completed nodes) |
| `--quiet`, `-q` | Suppress all progress output to stderr |
| `--verbose`, `-v` | Also show tool-level events (tool name and duration) |

**Default (no flags):**
- Creates worktree with auto-generated branch (`archon/task-<workflow>-<timestamp>`)
- Auto-registers codebase if in a git repo

**With `--branch`:**
- Creates/reuses worktree at `~/.archon/workspaces/<owner>/<repo>/worktrees/<branch>/`
- Reuses existing worktree if healthy

**With `--no-worktree`:**
- Runs in target directory directly (no isolation)
- Mutually exclusive with `--branch` and `--from`

**Name Matching:**

Workflow names are resolved using a 4-tier fallback hierarchy. This applies consistently across the CLI and all chat platforms (Slack, Telegram, Web, GitHub, Discord):
1. **Exact match** - `archon-assist` matches `archon-assist`
2. **Case-insensitive** - `Archon-Assist` matches `archon-assist`
3. **Suffix match** - `assist` matches `archon-assist` (looks for `-assist` suffix)
4. **Substring match** - `smart` matches `archon-smart-pr-review`

If multiple workflows match at the same tier, an error lists the candidates:
```
Ambiguous workflow 'review'. Did you mean:
  - archon-review
  - custom-review
```

### `workflow status`

Show all running workflow runs across all worktrees.

```bash
archon workflow status
archon workflow status --json
```

### `workflow resume`

Resume a failed workflow run. Re-executes the workflow, automatically skipping nodes that completed in the prior run.

```bash
archon workflow resume <run-id>
```

### `workflow abandon`

Discard a workflow run (marks it as `cancelled`). Use this to unblock a worktree when you don't want to resume — the path lock is released immediately so a new workflow can start.

```bash
archon workflow abandon <run-id>
```

### `workflow approve`

Approve a paused workflow run at an interactive approval gate. Optionally provide a comment that is available to the workflow via `$LOOP_USER_INPUT`.

```bash
archon workflow approve <run-id>
archon workflow approve <run-id> "Looks good, proceed"
archon workflow approve <run-id> --comment "Looks good, proceed"
```

### `workflow reject`

Reject a paused workflow run at an approval gate. Optionally provide a reason that is available to the workflow via `$REJECTION_REASON`.

```bash
archon workflow reject <run-id>
archon workflow reject <run-id> --reason "Needs more tests"
```

### `workflow cleanup`

Delete old terminal workflow run records from the database.

```bash
archon workflow cleanup        # Default: 7 days
archon workflow cleanup 30     # Custom threshold
```

### `workflow event emit`

Emit a workflow event directly to the database. Primarily used inside workflow loop prompts to record story-level lifecycle events.

```bash
archon workflow event emit --run-id <uuid> --type <event-type> [--data <json>]
```

**Flags:**

| Flag | Required | Description |
|------|----------|-------------|
| `--run-id` | Yes | UUID of the workflow run |
| `--type` | Yes | Event type (e.g., `ralph_story_started`, `node_completed`) |
| `--data` | No | JSON string attached to the event. Invalid JSON prints a warning and is ignored. |

Exit code: 0 on success, 1 when `--run-id`, `--type` is missing, or `--type` is not a valid event type. Event persistence is best-effort (non-throwing) -- check server logs if events appear missing.

### `workflow get <name>`

Print a workflow's definition. Reads from `.archon/workflows/`, `~/.archon/workflows/`, and bundled defaults — no server required.

```bash
archon workflow get archon-fix-github-issue          # raw YAML (prefixed with a `# source:` comment)
archon workflow get archon-fix-github-issue --json   # parsed JSON
```

Pipe to a file to edit, then re-submit with `workflow update`: `archon workflow get my-flow > my-flow.yaml`. (Bundled workflows with no on-disk file in a binary build fall back to JSON.)

### `workflow create <file>` / `workflow update <name> <file>`

Create or replace a workflow definition from a YAML file. The server validates the definition before writing. **Requires a running server.**

```bash
archon workflow create ./my-flow.yaml                # name derived from the filename
archon workflow create ./my-flow.yaml --name my-flow # explicit name override
archon workflow update my-flow ./my-flow.yaml
```

**Flags:** `--name <name>` (create only; defaults to the filename without extension), `--cwd <path>` (target project).

### `workflow delete <name>`

Delete a user-defined workflow (bundled defaults cannot be deleted). Prompts for confirmation unless `--force`. **Requires a running server.**

```bash
archon workflow delete my-flow
archon workflow delete my-flow --force
archon workflow delete my-flow --source project      # disambiguate project vs global
```

### `workflow cancel <run-id>`

Cancel an in-progress (running / pending / paused) workflow run via the server. **Requires a running server.** To discard a run and release a worktree lock without the server, use `workflow abandon`.

```bash
archon workflow cancel <run-id>
```

### `workflow runs`

List workflow runs (full history). Reads the database directly — no server required. `workflow status` remains the active-only view; `workflow runs` is the complete history with filters.

```bash
archon workflow runs
archon workflow runs --status failed --limit 50
archon workflow runs --workflow archon-fix-github-issue --json
```

**Flags:** `--status <running|completed|failed|cancelled|pending|paused>`, `--limit <n>` (default 20), `--workflow <name>`, `--json`.

### `workflow inspect <run-id>`

Show full run detail — metadata plus per-node step summaries derived from the event log. Reads the database directly.

```bash
archon workflow inspect <run-id>
archon workflow inspect <run-id> --json
```

### `workflow artifacts list <run-id>` / `workflow artifacts get <run-id> <path>`

List or print artifact files produced by a run. Reads the on-disk artifact directory directly. Path traversal (`..`) is rejected.

```bash
archon workflow artifacts list <run-id>
archon workflow artifacts list <run-id> --json
archon workflow artifacts get <run-id> report.md             # prints to stdout
archon workflow artifacts get <run-id> report.md --output ./report.md
```

### `isolation list`

Show all active worktree environments.

```bash
archon isolation list
```

Groups by codebase, shows branch, workflow type, platform, and days since activity.

### `isolation cleanup [days]`

Remove stale environments.

```bash
# Default: 7 days
archon isolation cleanup

# Custom threshold
archon isolation cleanup 14

# Remove environments with branches merged into main (also deletes remote branches)
archon isolation cleanup --merged

# Also remove environments whose PRs were closed without merging
archon isolation cleanup --merged --include-closed
```

Merge detection uses three signals in order: git branch ancestry (fast-forward / merge commit),
patch equivalence (squash-merge via `git cherry`), and GitHub PR state via the `gh` CLI.
The `gh` CLI is optional — if absent, only git signals are used.

By default, branches with a **CLOSED** PR are skipped. Pass `--include-closed` to clean
those up as well. Branches with an **OPEN** PR are always skipped.

### `validate workflows [name]`

Validate workflow YAML definitions and their referenced resources (command files, MCP configs, skill directories).

```bash
archon validate workflows                 # Validate all workflows
archon validate workflows my-workflow     # Validate a single workflow
archon validate workflows my-workflow --json  # Machine-readable JSON output
```

Checks: YAML syntax, DAG structure (cycles, dependency refs), command file existence, MCP config files, skill directories, provider compatibility. Returns actionable error messages with "did you mean?" suggestions for typos.

Exit code: 0 = all valid, 1 = errors found.

### `validate commands [name]`

Validate command files (.md) in `.archon/commands/`.

```bash
archon validate commands                  # Validate all commands
archon validate commands my-command       # Validate a single command
```

Checks: file exists, non-empty, valid name.

Exit code: 0 = all valid, 1 = errors found.

### `complete <branch> [branch2 ...]`

Remove a branch's worktree, local branch, and remote branch, and mark its isolation environment as destroyed.

```bash
archon complete feature-auth
archon complete feature-auth --force  # bypass uncommitted-changes check
```

**Flags:**

| Flag | Effect |
|------|--------|
| `--force` | Skip uncommitted-changes guard |

Use this after a PR is merged and you no longer need the worktree or branches. Accepts multiple branch names in one call.

### `serve`

Start the web UI server. On first run, downloads a pre-built web UI tarball from the matching GitHub release, verifies the SHA-256 checksum, and extracts it. Subsequent runs use the cached copy.

**Binary installs only** — in development, use `bun run dev` instead.

```bash
# Start web UI server (downloads on first run)
archon serve

# Override the default port
archon serve --port 4000

# Download the web UI without starting the server
archon serve --download-only
```

**Flags:**

| Flag | Effect |
|------|--------|
| `--port <port>` | Override server port (default: 3090, range: 1–65535) |
| `--download-only` | Download and cache the web UI, then exit without starting the server |

The cached web UI is stored at `~/.archon/web-dist/<version>/`. Each version is cached independently, so upgrading the binary automatically downloads the matching web UI.

### `skill install [path]`

Install the bundled Archon skill files into a project's `.claude/skills/archon/` directory. Always overwrites existing files to ensure the latest version shipped with the current Archon binary is installed.

```bash
# Install into the current directory
archon skill install

# Install into a specific project
archon skill install /path/to/project
```

The Archon skill teaches Claude Code how to work with Archon workflows, commands, and project conventions. It is also installed automatically during `archon setup`.

### `version`

Show version, build type, and database info.

```bash
archon version
```

### `codebase`

Manage registered codebases. Reads (`list`, `get`, `env list`, `environments`) hit the database directly; mutations (`register`, `delete`, `env set`, `env delete`) go through the server. `<id|name>` accepts the codebase UUID or its name (case-insensitive; an ambiguous name errors).

```bash
archon codebase list                                   # list all (--json for machine output)
archon codebase get <id|name>                          # show details
archon codebase register .                             # register a local path (server)
archon codebase register https://github.com/owner/repo # clone a remote (server)
archon codebase delete <id|name>                       # prompts; --force to skip (server)
archon codebase env list <id|name>                     # key names only — values never shown
archon codebase env set <id|name> KEY value            # upsert an env var (server)
archon codebase env delete <id|name> KEY               # remove an env var (server)
archon codebase environments <id|name>                 # isolation environments for the codebase
```

### `conversation`

Manage conversations. Reads (`list`, `get`, `messages`) hit the database directly; mutations (`send`, `create`, `title`, `delete`) go through the server. IDs accept the conversation UUID or the platform conversation id.

```bash
archon conversation list --limit 20 --json
archon conversation get <id>
archon conversation messages <id> --limit 50
archon conversation send <id> "What changed?"          # posts, then polls for the reply (server)
archon conversation create --title "Investigation"     # (server)
archon conversation title <id> "New title"             # (server)
archon conversation delete <id> --force                # soft-delete (server)
```

`conversation send` posts through the orchestrator and polls for the assistant's reply (up to 2 minutes). Real-time streaming into the terminal is not yet supported.

### `config`

Inspect and update configuration.

```bash
archon config show                                     # effective merged config (env values redacted)
archon config show --json --cwd /path/to/repo
archon config assistant claude                         # show the claude assistant block
archon config assistant claude --model opus            # update model (server)
archon config assistant claude --setting-sources project,user
archon config path                                     # print config file, DB, and home paths
```

`config show` and `config assistant` (read mode) read the merged config directly (no server). `config assistant` with a mutation flag (`--model` / `--setting-sources`) updates via the server, preserving merge semantics. Env var **values** are never printed.

### `providers list`

List registered AI providers and their capabilities. Reads the provider registry directly — no server required.

```bash
archon providers list
archon providers list --json
```

### `health`

Runtime health check against the running server. Distinct from `doctor` (which verifies the local environment). **Requires a running server**; exits non-zero if the server is unreachable or reports a non-ok status.

```bash
archon health
archon health --json
```

### `update-check`

Check for a newer Archon release (queries the GitHub Releases API directly — no server required).

```bash
archon update-check
archon update-check --json
```

## Global Options

| Option | Effect |
|--------|--------|
| `--cwd <path>` | Override working directory (default: current directory) |
| `--quiet`, `-q` | Reduce log verbosity to warnings and errors only |
| `--verbose`, `-v` | Show debug-level output |
| `--json` | Output machine-readable JSON. Also suppresses info logs so stdout stays clean for piping (e.g. `... --json \| jq`). |
| `--server-url <url>` | Archon server URL for mutation commands (default: `http://localhost:3090`; or set `ARCHON_SERVER_URL`) |
| `--limit <n>` | Max rows for list commands (`conversation list`, `workflow runs`) |
| `--status <status>` | Filter `workflow runs` by status |
| `--name <name>` | Workflow name override for `workflow create` |
| `--title <title>` | Conversation title for `conversation create` / `conversation title` |
| `--model <model>` | Model to set for `config assistant <provider>` |
| `--setting-sources <a,b>` | Claude `settingSources` for `config assistant` (comma-separated) |
| `--source <project\|global>` | Workflow source filter for `workflow delete` |
| `--output <file>` | Write artifact contents to a file for `workflow artifacts get` |
| `--force` | Skip confirmation for destructive commands (`delete`); overwrite for `workflow install` |
| `--help`, `-h` | Show help message |

## Working Directory

The CLI determines where to run based on:

1. `--cwd` flag (if provided)
2. Current directory (default)

Running from a subdirectory (e.g., `/repo/packages/cli`) automatically resolves to the git repository root (e.g., `/repo`).

When using `--branch`, workflows run inside the worktree directory.

> **Commands and workflows are loaded from the working directory at runtime.** The CLI reads directly from disk, so it picks up uncommitted changes immediately. This is different from the server (Telegram/Slack/GitHub), which reads from the workspace clone at `~/.archon/workspaces/` -- that clone only syncs from the remote before worktree creation, so changes must be pushed to take effect there.

## Environment

At startup, the CLI strips all Bun-auto-loaded CWD `.env` keys and nested Claude Code session markers from `process.env`, then loads two archon-owned env files with `override: true`. Keys in archon-owned files pass through to AI subprocesses — no allowlist filtering.

On startup, the CLI:
1. Strips `<cwd>/.env*` keys + `CLAUDECODE` markers from `process.env` (via `stripCwdEnv`). Emits `[archon] stripped N keys from <cwd> (...)` when N > 0.
2. Loads `~/.archon/.env` (user scope). Emits `[archon] loaded N keys …` when N > 0 **and** `ARCHON_VERBOSE_BOOT=1` or `LOG_LEVEL=debug/trace` is set.
3. Loads `<cwd>/.archon/.env` (project scope, overrides user scope). Same verbosity gate as step 2.
4. Auto-enables global Claude auth if no explicit tokens are set.

`<cwd>/.env` is never loaded — it belongs to the target project. See [Configuration Reference: `.env` File Locations](/reference/configuration/#env-file-locations) for the full three-path model.

## Database

- **Without `DATABASE_URL` (default):** Uses SQLite at `~/.archon/archon.db` -- zero setup, auto-initialized on first run
- **With `DATABASE_URL`:** Uses PostgreSQL (optional, for cloud/advanced deployments)

Both work transparently. Most users never need to configure a database.

## Examples

```bash
# One-off AI chat
archon chat "How does error handling work in this codebase?"

# Interactive setup wizard
archon setup

# Quick question (auto-isolated in archon/task-assist-<timestamp>)
archon workflow run assist --cwd ~/projects/my-app "How does error handling work here?"

# Quick question without isolation
archon workflow run assist --cwd ~/projects/my-app --no-worktree "How does error handling work here?"

# Plan a feature (auto-isolated)
archon workflow run plan --cwd ~/projects/my-app "Add rate limiting to the API"

# Implement with explicit branch name
archon workflow run implement --cwd ~/projects/my-app --branch feature-rate-limit "Add rate limiting"

# Branch from a specific source branch instead of auto-detected default
archon workflow run implement --cwd ~/projects/my-app --branch test-adapters --from feature/extract-adapters "Test adapter changes"

# Approve or reject a paused workflow
archon workflow approve <run-id> "Ship it"
archon workflow reject <run-id> --reason "Missing test coverage"

# Check worktrees after work session
archon isolation list

# Clean up old worktrees
archon isolation cleanup
```
