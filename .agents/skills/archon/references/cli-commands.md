# Archon CLI Command Reference For Codex

Use this when the user wants the real Archon CLI surface rather than a skill
summary.

All commands except `version` and `chat` are normally run from within a git
repository.

## Workflow Commands

### `archon workflow list`

```bash
archon workflow list
archon workflow list --json
```

Use this first when choosing a Codex-safe workflow.

### `archon workflow run <name> [message]`

Examples:

```bash
archon workflow run archon-assist-codex --branch assist/codex-readme "Explain the current workflow surface"
archon workflow run archon-piv-loop-codex --branch piv/codex-auth "Implement auth from the approved plan"
archon workflow run my-workflow --branch feat/dark-mode "Add dark mode"
archon workflow run quick-fix --no-worktree "Fix the typo in README"
archon workflow run my-workflow --resume
```

Key flags:

| Flag | Description |
| --- | --- |
| `--branch <name>` | create or reuse a worktree branch |
| `--from <name>` | choose the base branch for a new worktree |
| `--no-worktree` | run in the live checkout |
| `--resume` | resume the last failed run |
| `--cwd <path>` | override working directory |

Important:

- default behavior creates an isolated worktree automatically
- `--branch` and `--no-worktree` conflict
- `--resume` and `--branch` conflict

### `archon workflow status`

```bash
archon workflow status
archon workflow status --verbose
archon workflow status --json
```

Use `--json` as the source of truth for current workflow state.

### `archon workflow approve`

```bash
archon workflow approve <run-id> "<comment>"
```

Use for paused workflows that need human feedback. The CLI approve path records
the response only. Continue with:

```bash
archon workflow resume <run-id>
```

Treat that `workflow resume` process as the live runner until the workflow
pauses again or reaches a terminal state.

### `archon workflow reject`

```bash
archon workflow reject <run-id> "<reason>"
```

When the rejection keeps the workflow resumable (for example an `on_reject`
retry path), continue with:

```bash
archon workflow resume <run-id>
```

Use for paused workflows that need rejection or rework feedback.

### `archon workflow resume`

```bash
archon workflow resume <run-id>
```

Use when the run failed and should be resumed from its failure point.

## Validation Commands

### `archon validate workflows [name]`

```bash
archon validate workflows
archon validate workflows my-workflow
archon validate workflows my-workflow --json
```

This checks workflow syntax, dependency structure, resource resolution, and
provider-compatibility warnings.

### `archon validate commands [name]`

```bash
archon validate commands
archon validate commands my-command
```

Use after creating or editing command files.

## Isolation Commands

### `archon isolation list`

```bash
archon isolation list
```

Shows active worktree environments.

### `archon isolation cleanup`

```bash
archon isolation cleanup
archon isolation cleanup 14
archon isolation cleanup --merged
```

## Other Commands

### `archon complete <branch>`

```bash
archon complete feature-auth
archon complete feature-auth --force
```

Completes a branch lifecycle by removing the worktree and branch state.

### `archon version`

```bash
archon version
```

### `archon chat <message>`

```bash
archon chat "What workflows are available?"
```

Important:

- `archon chat` is single-shot orchestration
- it is not a persistent multi-turn workflow conversation
- interactive workflow control should stay on `archon workflow run/status/approve/reject`

## Useful Environment Variables

| Variable | Purpose |
| --- | --- |
| `ARCHON_HOME` | override Archon home directory |
| `LOG_LEVEL` | control Archon process log verbosity |
| `DATABASE_URL` | use PostgreSQL instead of SQLite |
