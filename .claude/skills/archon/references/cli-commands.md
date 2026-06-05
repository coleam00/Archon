# Archon CLI Command Reference

All commands must be run from within a git repository (subdirectories work — resolves to repo root). Exceptions: `version`, `setup`, `chat`.

## Workflow Commands

### `archon workflow list`

List all discovered workflows (bundled + repo-defined).

```bash
archon workflow list              # Human-readable table
archon workflow list --json       # Machine-readable JSON output
```

JSON output includes: `{ workflows: [{ name, description, provider?, model? }], errors: [{ filename, error }] }`

### `archon workflow run <name> [message] [flags]`

Execute a workflow.

```bash
archon workflow run archon-assist "What does the auth module do?"
archon workflow run archon-fix-github-issue --branch fix/issue-42 "Fix issue #42"
archon workflow run my-workflow --branch feat/dark-mode --from develop "Add dark mode"
archon workflow run quick-fix --no-worktree "Fix the typo in README"
archon workflow run archon-fix-github-issue --resume
archon workflow run archon-assist "Investigate the flaky test" --detach
```

| Flag | Description |
|------|-------------|
| `--branch <name>` / `-b` | Branch name for worktree. Reuses existing worktree if healthy |
| `--from <name>` / `--from-branch <name>` | Start-point branch for new worktree (default: repo default branch) |
| `--no-worktree` | Skip isolation — run in the live checkout |
| `--resume` | Resume the last failed run of this workflow at this cwd (skips completed nodes) |
| `--detach` | Run in a detached background child and return immediately (find the run via `workflow runs`). Pair with `--json` for a structured ack. Child output goes to `~/.archon/logs/`. In the web console the run appears in the Workflow dock (listed by project) but may not update **live** until a refetch — it runs out-of-process and doesn't stream to the console's live event feed. |
| `--cwd <path>` | Working directory override |

**Flag conflicts** (errors):
- `--branch` + `--no-worktree`
- `--from` + `--no-worktree`
- `--resume` + `--branch`

**Default behavior** (no flags): Auto-creates a worktree with branch name `{workflow-name}-{timestamp}`.

**Auto-resume without `--resume`**: If a prior invocation of the same workflow at the same cwd failed, the next invocation automatically skips completed nodes. `--resume` is only needed when you want to force resume a specific failed run or to reuse the worktree from that run.

### `archon workflow status`

Show **active** workflow runs (running + paused) with run ID, state, and last activity. Add `--verbose` for a per-node summary.

```bash
archon workflow status
archon workflow status --json       # Machine-readable output
```

### `archon workflow runs [--all] [--status <s>] [--limit <n>]`

List **recent** runs of **all** statuses, scoped to the current project (cwd → codebase). Complements `status`, which is active-only — use this to answer "did the review pass?" for a completed/failed run.

```bash
archon workflow runs                 # recent runs (all statuses) for this project
archon workflow runs --json          # machine-readable (full dashboard result + counts)
archon workflow runs --status failed --limit 50
archon workflow runs --all           # across all projects (ignore cwd scope)
```

| Flag | Description |
|------|-------------|
| `--all` | List across all projects (drop the cwd→codebase scope) |
| `--status <s>` | Filter to one status: `pending`, `running`, `completed`, `failed`, `cancelled`, `paused` |
| `--limit <n>` | Max rows (default 20) |
| `--json` | Emit the full `{ runs, total, counts, scopeFallback }` dashboard result |

An unregistered cwd (or a codebase lookup failure) falls back to a global list with a `(not a registered project — showing all runs)` note (never a silent wrong scope). In `--json`, `scopeFallback: true` flags that the result is global rather than the requested project scope.

### `archon workflow get <run-id> [--verbose]`

Show detail for **one run, any status** (status, working path, error). `--verbose` adds a per-node summary from the event log (and, in `--json`, an `events` array). `--json` emits the raw run object on success; on failure (not found, DB error) it emits one `{ "ok": false, "runId": "…", "error": "…" }` line and never throws (`error` is `"not_found"` for a missing run).

```bash
archon workflow get abc123
archon workflow get abc123 --json
archon workflow get abc123 --verbose --json
```

### `archon workflow approve <run-id> [comment] [--json]`

Approve a paused approval-node workflow. Auto-resumes the workflow.

```bash
archon workflow approve abc123
archon workflow approve abc123 --comment "Plan looks good"
archon workflow approve abc123 "Plan looks good"   # positional form
archon workflow approve abc123 "Plan looks good" --json   # records the decision; does NOT auto-resume
```

> **`--json` on `approve`/`reject`/`resume` records/validates the decision and returns a clean JSON line WITHOUT the inline auto-resume** (execution streams output that would corrupt the JSON). The run becomes resumable — drive it to completion with a backgrounded `archon workflow resume <id>` (no `--json`), or drop `--json` to approve-and-resume in one blocking call.

For interactive loop nodes, the comment becomes `$LOOP_USER_INPUT` on the next iteration. For approval nodes with `capture_response: true`, the comment becomes `$<gate-id>.output` for downstream nodes.

### `archon workflow reject <run-id> [reason] [--json]`

Reject a paused approval gate. Without `on_reject` on the node, cancels the workflow. With `on_reject`, runs the rework prompt with `$REJECTION_REASON` substituted and re-pauses. (`--json` records the decision without the inline rework — see the note under `approve`.)

```bash
archon workflow reject abc123
archon workflow reject abc123 --reason "Plan misses test coverage"
archon workflow reject abc123 "Plan misses test coverage"
```

### `archon workflow abandon <run-id> [--json]`

Mark a non-terminal workflow run as cancelled. Use when a `running` row is stuck after a server crash or when you want to discard a paused run without rejecting. This does NOT kill an in-flight subprocess — it only transitions the DB row.

```bash
archon workflow abandon abc123
archon workflow abandon abc123 --json   # { "ok": true, "runId": "abc123", "action": "abandon", "status": "cancelled", ... }
```

> **There is no `archon workflow cancel` CLI subcommand.** To actively cancel a running workflow (terminate its subprocess), use the chat slash command `/workflow cancel <run-id>` on the platform that started it (Web UI, Slack, Telegram, etc.), or the Cancel button on the Web UI dashboard. The CLI only offers `abandon`, which is the right tool for orphan cleanup but does not interrupt a live subprocess.

### `archon workflow resume <run-id> [message] [--json]`

Explicitly re-run a failed run. Most workflows auto-resume without this — use it when you want to force a specific run ID. (`--json` validates that the run is resumable and returns `executed: false` WITHOUT running — see the note under `approve`; to actually execute, use the blocking form as a background task.)

```bash
archon workflow resume abc123
archon workflow resume abc123 "continue with the plan"
```

### `archon workflow cleanup [days]`

**Deletes** old terminal workflow runs (`completed`/`failed`/`cancelled`) from the database for disk hygiene. Does NOT transition `running` rows — use `abandon`/`cancel` for those.

```bash
archon workflow cleanup             # Default: 7 days
archon workflow cleanup 30          # Custom: 30 days
```

### `archon workflow event emit --run-id <uuid> --type <event-type> [--data <json>]`

Emit a workflow event to a running workflow. Used inside loop prompts to signal state (e.g. "checkpoint written") for observability. Rarely invoked from the shell directly.

```bash
archon workflow event emit --run-id abc123 --type checkpoint --data '{"step":"plan"}'
```

### `archon continue <branch> [flags] [message]`

Continue work on a branch with prior context. Defaults to `archon-assist`; use `--workflow` to pick a different workflow. Useful for iterative sessions on the same worktree without typing the full `workflow run` incantation.

```bash
archon continue feat/auth "Add password reset"
archon continue feat/auth --workflow archon-feature-development "Continue from step 3"
archon continue feat/auth --no-context "Start fresh without loading prior artifacts"
```

Flags: `--workflow <name>`, `--no-context`.

## Isolation Commands

### `archon isolation list`

Show active worktree environments for all codebases.

```bash
archon isolation list
```

Outputs: branch name, path, workflow type, platform, last activity age. Ghost entries (deleted worktrees) are auto-reconciled.

### `archon isolation cleanup [days]`

Remove stale worktree environments.

```bash
archon isolation cleanup                             # Default: 7 days
archon isolation cleanup 14                          # Custom: 14 days
archon isolation cleanup --merged                    # Also remove worktrees whose branches merged into main (deletes remote branches too)
archon isolation cleanup --merged --include-closed   # Also remove worktrees whose PRs were closed without merging
```

**Flags:**

| Flag | Description |
|------|-------------|
| `[days]` | Positional — age threshold in days. Environments untouched for longer than this are removed. Default: 7 |
| `--merged` | Union of three signals — ancestry (`git branch --merged`), patch equivalence (`git cherry`), and PR state (`gh`) — safely catches squash-merges |
| `--include-closed` | With `--merged`, also remove worktrees whose PRs were closed (abandoned, not merged) |

## Validate Commands

### `archon validate workflows [name]`

Validate workflow YAML definitions and their referenced resources.

```bash
archon validate workflows                 # Validate all workflows in the repo
archon validate workflows my-workflow     # Validate a single workflow
archon validate workflows my-workflow --json  # Machine-readable JSON output
```

Checks: YAML syntax, DAG structure (cycles, dependency refs), command file existence, MCP config files, skill directories, provider compatibility. Returns actionable error messages with "did you mean?" suggestions for typos.

Exit code: 0 = all valid, 1 = errors found.

### `archon validate commands [name]`

Validate command files (.md) in `.archon/commands/`.

```bash
archon validate commands                  # Validate all commands
archon validate commands my-command       # Validate a single command
```

Checks: file exists, non-empty, valid name.

## Other Commands

### `archon complete <branch> [flags]`

Complete a branch lifecycle — removes worktree + local/remote branches.

```bash
archon complete feature-auth
archon complete feature-auth --force    # Skip uncommitted-changes check
archon complete branch1 branch2 branch3 # Multiple branches
```

## Other Commands

### `archon version`

```bash
archon version
# Archon CLI v0.x.x
#   Platform: darwin-arm64
#   Build: source (bun)
#   Database: sqlite
```

### `archon setup [--spawn]`

Interactive setup wizard for database, AI providers, and platform connections.

```bash
archon setup            # Run in current terminal
archon setup --spawn    # Open wizard in a new terminal window
```

### `archon chat <message>`

Single-shot message to the orchestrator (does not require a git repo).

```bash
archon chat "What platforms are configured?"
archon chat "/status"
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
