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

**Note:** Workflow and isolation commands require running from within a git repository. Running from subdirectories automatically resolves to the repo root. The `version`, `help`, `chat`, `setup`, `serve`, and `doctor` commands work anywhere.

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

### `auth github`

Connect the current CLI user's GitHub identity via the GitHub device flow, so workflow commits, PR comments, and pushes attribute to you instead of the bot.

```bash
archon auth github
```

Only meaningful on **multi-user installs** running GitHub App mode (`GITHUB_APP_ID` + `GITHUB_APP_CLIENT_ID`) with `TOKEN_ENCRYPTION_KEY` set — solo `GITHUB_TOKEN` installs don't need it and the command exits with an explanatory error. Your CLI identity is resolved from `ARCHON_USER_ID` (explicit override) or `$USER` / `$USERNAME`, mapped to a stable Archon user via the `cli` platform identity.

The command prints a `verification_uri` and a one-time `user_code`; visit the URL, enter the code, and authorize. On success the access/refresh tokens are stored encrypted (AES-256-GCM) in Archon's database. Exit code 0 on success; 1 if per-user GitHub is disabled, the identity can't be resolved, the code expires, or authorization is denied.

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
| `--detach` | Run in a detached background child and return immediately. The child does all the work; find it later with `workflow runs`/`workflow get`. Child stdout/stderr is captured to `~/.archon/logs/detached-run-<id>.log`. Combine with `--json` for a machine-readable ack. |

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

Show **active** workflow runs (running and paused) across all worktrees. For full history (all statuses) scoped to the current project, use `workflow runs`.

```bash
archon workflow status
archon workflow status --json
archon workflow status --verbose   # add a per-node summary for each run
```

### `workflow runs`

List recent runs of **every** status (completed, failed, cancelled, running, paused) for the current project. The project is resolved from `cwd` the same way `workflow run` does. Complements `workflow status` (which is active-only).

```bash
archon workflow runs
archon workflow runs --json
archon workflow runs --status failed   # filter to one status
archon workflow runs --limit 50        # cap rows (default 20)
archon workflow runs --all             # list across all projects (ignore cwd scope)
```

If `cwd` is not a registered project, the command falls back to a global list and says so — `--json` carries this as a `scopeFallback: true` field so a consuming agent never mistakes a global result for a project-scoped one.

### `workflow get`

Show detail for a single run by ID, regardless of status (unlike `status`, which is active-only). Use it to answer "did that run pass?" for a completed/failed run. Exits non-zero when the run is not found.

```bash
archon workflow get <run-id>
archon workflow get <run-id> --json
archon workflow get <run-id> --verbose   # add the per-node event summary
```

### `workflow resume`

Resume a failed workflow run. Re-executes the workflow, automatically skipping nodes that completed in the prior run.

```bash
archon workflow resume <run-id>
archon workflow resume <run-id> --json   # validate + ack only; does NOT re-execute inline
```

In `--json` mode the command is a non-blocking control-plane ack: it validates the run is resumable and reports its state but does **not** re-execute inline (execution streams output to stdout, which would corrupt the JSON). To actually drive a resumable run to completion, use the blocking form or `workflow run <name> --resume --detach`.

### `workflow abandon`

Discard a workflow run (marks it as `cancelled`). Use this to unblock a worktree when you don't want to resume — the path lock is released immediately so a new workflow can start.

```bash
archon workflow abandon <run-id>
archon workflow abandon <run-id> --json
```

### `workflow approve`

Approve a paused workflow run at an interactive approval gate. Optionally provide a comment that is available to the workflow via `$LOOP_USER_INPUT`.

```bash
archon workflow approve <run-id>
archon workflow approve <run-id> "Looks good, proceed"
archon workflow approve <run-id> --comment "Looks good, proceed"
archon workflow approve <run-id> --json   # record approval + ack; does NOT auto-resume inline
```

In human mode `approve`/`reject` auto-resume the run inline. In `--json` mode they record the decision and return an ack **without** resuming (the run is left resumable for a backgrounded `resume`/`run --resume`).

### `workflow reject`

Reject a paused workflow run at an approval gate. Optionally provide a reason that is available to the workflow via `$REJECTION_REASON`.

```bash
archon workflow reject <run-id>
archon workflow reject <run-id> --reason "Needs more tests"
archon workflow reject <run-id> --json
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

Install the bundled Archon skills into both `.claude/skills/` (Claude Code) and `.agents/skills/` (Codex) directories of a project. Always overwrites existing files to ensure the latest version shipped with the current Archon binary is installed.

```bash
# Install into the current directory
archon skill install

# Install into a specific project
archon skill install /path/to/project
```

Two skills are installed: **`archon`**, which teaches the assistant how to work with Archon workflows, commands, and project conventions; and **`manage-run`**, a focused skill for inspecting and controlling workflow runs via the `archon` CLI. Each skill is written to both `.claude/skills/<skill>/` (Claude Code) and `.agents/skills/<skill>/` (Codex's canonical project-level skill path). Both are also installed automatically during `archon setup`.

### `version`

Show version, build type, and database info.

```bash
archon version
```

## Global Options

| Option | Effect |
|--------|--------|
| `--cwd <path>` | Override working directory (default: current directory) |
| `--quiet`, `-q` | Reduce log verbosity to warnings and errors only |
| `--verbose`, `-v` | Show debug-level output |
| `--json` | Output machine-readable JSON (workflow `list`, `status`, `runs`, `get`, and the write commands `approve`/`reject`/`abandon`/`resume`). Implies log suppression so stdout is exactly the JSON payload. |
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
