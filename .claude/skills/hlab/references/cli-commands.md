# HarneesLab CLI Command Reference

All commands must be run from within a git repository (subdirectories work — resolves to repo root). Exceptions: `version`, `setup`, `chat`.

## Workflow Commands

### `hlab workflow list`

List all discovered workflows (bundled + repo-defined).

```bash
hlab workflow list              # Human-readable table
hlab workflow list --json       # Machine-readable JSON output
```

JSON output includes: `{ workflows: [{ name, description, provider?, model? }], errors: [{ filename, error }] }`

### `hlab workflow run <name> [message] [flags]`

Execute a workflow.

```bash
hlab workflow run archon-assist "What does the auth module do?"
hlab workflow run archon-fix-github-issue --branch fix/issue-42 "Fix issue #42"
hlab workflow run my-workflow --branch feat/dark-mode --from develop "Add dark mode"
hlab workflow run quick-fix --no-worktree "Fix the typo in README"
hlab workflow run archon-fix-github-issue --resume
```

| Flag | Description |
|------|-------------|
| `--branch <name>` / `-b` | Branch name for worktree. Reuses existing worktree if healthy |
| `--from <name>` / `--from-branch <name>` | Start-point branch for new worktree (default: repo default branch) |
| `--no-worktree` | Skip isolation — run in the live checkout |
| `--resume` | Resume the last failed run of this workflow (skips completed steps/nodes) |
| `--cwd <path>` | Working directory override |

**Flag conflicts** (errors):
- `--branch` + `--no-worktree`
- `--from` + `--no-worktree`
- `--resume` + `--branch`

**Default behavior** (no flags): Auto-creates a worktree with branch name `{workflow-name}-{timestamp}`.

## Isolation Commands

### `hlab isolation list`

Show active worktree environments for all codebases.

```bash
hlab isolation list
```

Outputs: branch name, path, workflow type, platform, last activity age. Ghost entries (deleted worktrees) are auto-reconciled.

### `hlab isolation cleanup [days]`

Remove stale worktree environments.

```bash
hlab isolation cleanup          # Default: 7 days
hlab isolation cleanup 14       # Custom: 14 days
hlab isolation cleanup --merged # Remove branches merged into main (+ remote branches)
```

## Validate Commands

### `hlab validate workflows [name]`

Validate workflow YAML definitions and their referenced resources.

```bash
hlab validate workflows                 # Validate all workflows in the repo
hlab validate workflows my-workflow     # Validate a single workflow
hlab validate workflows my-workflow --json  # Machine-readable JSON output
```

Checks: YAML syntax, DAG structure (cycles, dependency refs), command file existence, MCP config files, skill directories, provider compatibility. Returns actionable error messages with "did you mean?" suggestions for typos.

Exit code: 0 = all valid, 1 = errors found.

### `hlab validate commands [name]`

Validate command files (.md) in `.archon/commands/`.

```bash
hlab validate commands                  # Validate all commands
hlab validate commands my-command       # Validate a single command
```

Checks: file exists, non-empty, valid name.

## Other Commands

### `hlab complete <branch> [flags]`

Complete a branch lifecycle — removes worktree + local/remote branches.

```bash
hlab complete feature-auth
hlab complete feature-auth --force    # Skip uncommitted-changes check
hlab complete branch1 branch2 branch3 # Multiple branches
```

## Other Commands

### `hlab version`

```bash
hlab version
# HarneesLab CLI v0.x.x
#   Platform: darwin-arm64
#   Build: source (bun)
#   Database: sqlite
```

### `hlab setup [--spawn]`

Interactive setup wizard for database, AI providers, and platform connections.

```bash
hlab setup            # Run in current terminal
hlab setup --spawn    # Open wizard in a new terminal window
```

### `hlab chat <message>`

Single-shot message to the orchestrator (does not require a git repo).

```bash
hlab chat "What platforms are configured?"
hlab chat "/status"
```

## Global Flags

| Flag | Short | Description |
|------|-------|-------------|
| `--cwd <path>` | — | Working directory override |
| `--quiet` | `-q` | Set log level to `warn` (errors only) |
| `--verbose` | `-v` | Set log level to `debug` |
| `--json` | — | Machine-readable JSON output (workflow list) |
| `--help` | `-h` | Print usage and exit |

## Key Environment Variables

| Variable | Purpose |
|----------|---------|
| `CLAUDE_API_KEY` | Claude API key (explicit auth) |
| `CLAUDE_USE_GLOBAL_AUTH` | `true` to use `claude /login` credentials |
| `ARCHON_HOME` | Override base directory (default: `~/.archon`) |
| `LOG_LEVEL` | Pino log level: `fatal\|error\|warn\|info\|debug\|trace` |
| `DATABASE_URL` | PostgreSQL URL (omit for SQLite default) |
