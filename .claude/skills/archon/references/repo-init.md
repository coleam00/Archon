# Initializing Archon in a Repository

Set up the `.archon/` directory structure in any git repository to enable custom workflows and commands.

## Directory Structure

Create the following in your repository root:

```
.archon/
├── commands/         # Custom command files (.md)
├── workflows/        # Workflow definitions (.yaml)
├── scripts/          # Named scripts for script: nodes (.ts/.js for bun, .py for uv) — optional
├── mcp/              # MCP server config files (.json) — optional
├── state/            # Cross-run workflow state — gitignored, never committed
├── config.yaml       # Repo-specific configuration — optional
└── .env              # Repo-scoped Archon env (optional; do NOT commit)
```

```bash
mkdir -p .archon/commands .archon/workflows .archon/scripts
```

**What each directory is for:**

- `commands/` — Reusable prompt templates used by `command:` workflow nodes. Committed to git.
- `workflows/` — YAML workflow definitions. Committed to git.
- `scripts/` — Named TypeScript/JavaScript (bun) or Python (uv) scripts referenced by `script:` nodes. Extension determines runtime: `.ts`/`.js` → bun, `.py` → uv. Committed to git.
- `mcp/` — MCP server JSON configs. Usually checked in with `$ENV_VAR` references; avoid hardcoding secrets. Some teams gitignore this and rely entirely on env expansion.
- `state/` — Workflow-written cross-run state (e.g. the `repo-triage` dedup log). **Always gitignore** — these are runtime artifacts, not source.
- `config.yaml` — Repo-specific defaults (assistant, worktree settings, etc.). Committed to git.
- `.env` — Repo-scoped Archon env (loaded with `override: true` at boot). **Do NOT commit.** This is different from the target repo's top-level `.env` — that file belongs to the target project, and Archon strips its auto-loaded keys from subprocess env before spawning AI to prevent leakage. See **Three-Path Env Model** below.

## Minimal config.yaml

Create `.archon/config.yaml` only if you need to override defaults:

```yaml
# AI provider for this repo (default: inherited from global config)
assistant: claude                 # Repo-level key. In ~/.archon/config.yaml, use 'defaultAssistant' instead

# Worktree settings
worktree:
  baseBranch: main                # Branch to create worktrees from (default: auto-detected)
  copyFiles:                      # Git-ignored files to copy into new worktrees
    - .env
    - .env.local

# Control whether bundled defaults are loaded
defaults:
  loadDefaultCommands: true       # Include bundled default commands (default: true)
  loadDefaultWorkflows: true      # Include bundled default workflows (default: true)
```

## How Bundled Defaults Work

Archon ships with built-in commands and workflows (like `archon-assist`, `archon-fix-github-issue`). These are loaded at runtime automatically — no files need to be copied into your repo.

- **To see bundled workflows**: `archon workflow list`
- **To override a default**: Create a file with the same name in your repo's `.archon/workflows/` or `.archon/commands/`. Repo files take priority.
- **To disable defaults**: Set `defaults.loadDefaultWorkflows: false` or `defaults.loadDefaultCommands: false` in config.

## .gitignore Considerations

Add to your `.gitignore`:

```gitignore
# Archon runtime artifacts — NEVER commit
.archon/state/        # Cross-run workflow state, runtime-only
.archon/.env          # Repo-scoped Archon env (secrets)

# Optional — gitignore if your MCP configs hardcode secrets
.archon/mcp/
```

`.archon/commands/`, `.archon/workflows/`, and `.archon/scripts/` **should be committed** — they are part of your project's workflow definitions. `.archon/config.yaml` should be committed unless it contains secrets (use `.archon/.env` for those instead).

## Three-Path Env Model

Archon loads env from three distinct paths at boot, with different trust levels and precedence:

| Path | Scope | Trust | Loaded? |
|------|-------|-------|---------|
| `~/.archon/.env` | User (home) | Trusted — user owns it | Yes, with `override: true` |
| `<cwd>/.archon/.env` | Repo (per-project, Archon-owned) | Trusted — user owns it | Yes, with `override: true` (overrides home) |
| `<cwd>/.env` | Target repo | **Untrusted** — belongs to the project being worked on | **Stripped from `process.env`** before subprocess spawn to prevent secret leakage (see [Security Model](../../../packages/docs-web/src/content/docs/reference/security.md) on the docs site) |

Boot behavior emits observable log lines:

```
[archon] loaded N keys from ~/.archon/.env
[archon] loaded M keys from /path/to/repo/.archon/.env
[archon] stripped K keys from /path/to/repo (ANTHROPIC_API_KEY, OPENAI_API_KEY, ...)
```

**Where should you put what?**

- **API keys for Archon itself** (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `DATABASE_URL`, `SLACK_BOT_TOKEN`, etc.) → `~/.archon/.env` (shared across all repos) or `<cwd>/.archon/.env` (per-repo override).
- **Target-project env that a workflow needs** (`GH_TOKEN`, `DOTENV_PRIVATE_KEY`, etc.) → see [Per-Project Env Injection](#per-project-env-injection) below.
- **Target-project env that Archon should NOT touch** → leave it in `<cwd>/.env` where the project already expects it. Archon strips it from subprocess env but doesn't delete the file.

The `archon setup --scope home|project [--force]` wizard writes to the right file for you and produces a timestamped backup on every rewrite.

## Per-Project Env Injection

For env vars a workflow's `bash:` and `script:` subprocesses need (`GH_TOKEN` for `gh` calls, `DATABASE_URL` for a migration script, etc.), use one of the two **managed injection** surfaces — both inject into subprocess env at workflow execution time, after the target-repo `.env` strip:

**Option 1: `.archon/config.yaml` `env:` block** (checked into git; values can be `$REF_NAME` expansions from Archon env):

```yaml
env:
  GH_TOKEN: $GH_TOKEN             # expanded from ~/.archon/.env at runtime
  BUILD_TARGET: production        # literal value
```

**Option 2: Web UI Settings → Projects → Env Vars** — per-codebase, stored in the Archon DB, values never returned over the API (only keys are listed). Use this for values that should NOT appear in git.

Both surfaces inject into: Claude/Codex/Pi subprocess env, `bash:` node subprocess env, `script:` node subprocess env, and direct chat messages that run against the codebase. The worktree isolation layer propagates them as well.

> **About keys in the target repo's `<cwd>/.env`**: Archon unconditionally strips the keys auto-loaded from `<cwd>/.env` out of `process.env` at boot (see the Three-Path Env Model above) and the Bun subprocess is invoked with `--no-env-file`, so those values do NOT reach AI / bash / script subprocesses. If a workflow needs a value that currently lives in the target repo's `.env`, surface it through one of the two managed injection options above — don't expect the target `.env` to leak through.

## Global Configuration

The global config at `~/.archon/config.yaml` applies to all repositories. Use `guides/config.md` for interactive config editing, or create it manually:

```yaml
botName: Archon
defaultAssistant: claude

assistants:
  claude:
    model: sonnet
  codex:
    model: gpt-5.3-codex
    modelReasoningEffort: medium

concurrency:
  maxConversations: 10
```

## Verification

After setting up, verify with:

```bash
# Confirm Archon sees your repo
archon workflow list

# Should show bundled workflows + any custom ones you've added
```
