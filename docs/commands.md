# Essential Commands

> Reference detail extracted from `CLAUDE.md`. The top-level `CLAUDE.md` keeps the
> high-frequency commands (`bun run dev`, `bun run test`, `bun run validate`) and links here
> for the full surface.

## Development

```bash
# Start server + Web UI together (hot reload for both)
bun run dev

# Or start individually
bun run dev:server  # Backend only (port 3090)
bun run dev:web     # Frontend only (port 5173)
```

Regenerating frontend API types (requires server to be running at port 3090):

```bash
bun run dev:server  # must be running first
bun --filter @archon/web generate:types
```

Optional: Use PostgreSQL instead of SQLite by setting `DATABASE_URL` in `.env`:

```bash
docker-compose --profile with-db up -d postgres
# Set DATABASE_URL=postgresql://postgres:postgres@localhost:5432/remote_coding_agent in .env
```

## Testing

```bash
bun run test                # Run all tests (per-package, isolated processes)
bun test --watch            # Watch mode (single package)
bun test packages/core/src/handlers/command-handler.test.ts  # Single file
```

**Test isolation (mock.module pollution):** Bun's `mock.module()` permanently replaces modules in the process-wide cache — `mock.restore()` does NOT undo it ([oven-sh/bun#7823](https://github.com/oven-sh/bun/issues/7823)). To prevent cross-file pollution, packages that have conflicting `mock.module()` calls split their tests into separate `bun test` invocations: `@archon/core` (20 batches), `@archon/workflows` (5), `@archon/adapters` (6), `@archon/isolation` (3). See each package's `package.json` for the exact splits.

**Do NOT run `bun test` from the repo root** — it discovers all test files across all packages and runs them in one process, causing ~135 mock pollution failures. Always use `bun run test` (which uses `bun --filter '*' test` for per-package isolation).

## Type Checking & Linting

```bash
bun run type-check
bun run lint
bun run lint:fix
bun run format
bun run format:check
```

## Pre-PR Validation

**Always run before creating a pull request:**

```bash
bun run validate
```

This runs `check:bundled`, `check:bundled-skill`, `check:bundled-schema`, type-check, lint, format check, and tests. All seven must pass for CI to succeed.

## ESLint Guidelines

**Zero-tolerance policy**: CI enforces `--max-warnings 0`. No warnings allowed.

**When to use inline disable comments** (`// eslint-disable-next-line`):
- **Almost never** - fix the issue instead
- Only acceptable when:
  1. External SDK types are incorrect (document which SDK and why)
  2. Intentional type assertion after validation (must include comment explaining the validation)

**Never acceptable:**
- Disabling `no-explicit-any` without justification
- Disabling rules to "make CI pass"
- Bulk disabling at file level (`/* eslint-disable */`)

## Database

**Auto-Detection (SQLite is the default — zero setup):**
- **Without `DATABASE_URL`**: Uses SQLite at `~/.archon/archon.db` (auto-initialized, recommended for most users)
- **With `DATABASE_URL` set**: Uses PostgreSQL (schema auto-applied on startup; no manual `psql` needed). The Postgres adapter runs the idempotent `migrations/000_combined.sql` inside an advisory-lock transaction on first connection, so upgrades that add tables or columns converge automatically.

## CLI (Command Line)

Run workflows directly from the command line without needing the server. Workflow and isolation commands require running from within a git repository (subdirectories work - resolves to repo root).

```bash
# List available workflows (requires git repo)
bun run cli workflow list

# Machine-readable JSON output
bun run cli workflow list --json

# Run a workflow
bun run cli workflow run assist "What does the orchestrator do?"

# Run in a specific directory
bun run cli workflow run plan --cwd /path/to/repo "Add dark mode"

# Default: auto-creates worktree with generated branch name (isolation by default)
bun run cli workflow run implement "Add auth"

# Explicit branch name for the worktree
bun run cli workflow run implement --branch feature-auth "Add auth"

# Opt out of isolation (run in live checkout)
bun run cli workflow run quick-fix --no-worktree "Fix typo"

# Run in a detached background child (returns immediately; find it via `workflow runs`)
bun run cli workflow run implement "Add auth" --detach

# Show active runs (running + paused)
bun run cli workflow status

# List recent runs of ALL statuses, scoped to this project's codebase (cwd)
bun run cli workflow runs
bun run cli workflow runs --json                 # machine-readable { runs, total, counts }
bun run cli workflow runs --status failed --limit 50
bun run cli workflow runs --all                  # across all projects

# Show detail for one run (any status); --verbose adds per-node summary
bun run cli workflow get <run-id>
bun run cli workflow get <run-id> --json

# Resume a failed workflow (re-runs, skipping completed nodes)
bun run cli workflow resume <run-id>

# Discard a non-terminal run
bun run cli workflow abandon <run-id>

# Most read/write subcommands accept --json for machine-readable output:
#   list, status, runs, get, approve, reject, abandon, resume.
# For approve/reject/resume, --json records/validates the decision and returns a
# clean JSON line WITHOUT the inline auto-resume (drive continuation separately).

# Delete old workflow run records (default: 7 days)
bun run cli workflow cleanup
bun run cli workflow cleanup 30  # Custom days

# Clear persisted per-node AI sessions for a workflow (persist_session memory)
# Without --scope, wipes every scope and requires --yes; --node narrows to one node
bun run cli workflow reset-sessions <workflow-name> [--scope <key>] [--node <id>] [--yes] [--json]

# Emit a workflow event (used inside workflow loop prompts)
bun run cli workflow event emit --run-id <uuid> --type <event-type> [--data <json>]

# List active worktrees/environments
bun run cli isolation list

# Clean up stale environments (default: 7 days)
bun run cli isolation cleanup
bun run cli isolation cleanup 14  # Custom days

# Clean up environments with branches merged into main (also deletes remote branches)
bun run cli isolation cleanup --merged

# Also remove environments with closed (abandoned) PRs
bun run cli isolation cleanup --merged --include-closed

# Validate workflow definitions and their referenced resources
bun run cli validate workflows              # All workflows
bun run cli validate workflows my-workflow  # Single workflow
bun run cli validate workflows my-workflow --json  # Machine-readable output

# Validate command files
bun run cli validate commands               # All commands
bun run cli validate commands my-command    # Single command

# Complete branch lifecycle (remove worktree + local/remote branches)
bun run cli complete <branch-name>
bun run cli complete <branch-name> --force  # Skip uncommitted-changes check

# Start the web UI server (compiled binary only, downloads web UI on first run)
bun run cli serve
bun run cli serve --port 4000
bun run cli serve --download-only  # Download without starting

# Install the bundled Archon skill into a project
bun run cli skill install
bun run cli skill install /path/to/project

# Verify your Archon setup (Claude binary, gh auth, DB, adapters)
bun run cli doctor

# Connect your GitHub identity via device flow (multi-user installs only:
# App mode + TOKEN_ENCRYPTION_KEY). Identity from ARCHON_USER_ID or $USER.
bun run cli auth github

# Inspect or rotate the anonymous telemetry install UUID
bun run cli telemetry status
bun run cli telemetry reset

# Show version
bun run cli version
```
