---
title: Quick Reference
description: Every CLI command, variable, and YAML option in one scannable page.
category: book
part: advanced
audience: [user]
sidebar:
  order: 10
---

This chapter collects every CLI command, variable, and YAML option in one place. No explanations — just the facts. Use it when you know what you need and just need the syntax.

---

## CLI Commands

### `archon workflow`

| Command | Description |
|---------|-------------|
| `archon workflow list` | List all available workflows |
| `archon workflow list --json` | Machine-readable JSON output |
| `archon workflow run <name> "<prompt>"` | Run a workflow |
| `archon workflow run <name> --branch <name> "<prompt>"` | Run with an explicit branch |
| `archon workflow run <name> --no-worktree "<prompt>"` | Run in the live checkout (no isolation) |
| `archon workflow run <name> --cwd /path "<prompt>"` | Run against a specific directory |
| `archon workflow status` | Show status of active workflow runs |
| `archon workflow resume <run-id>` | Resume a failed workflow run |
| `archon workflow abandon <run-id>` | Abandon a non-terminal workflow run |
| `archon workflow cleanup [days]` | Delete old workflow run records (default: 7 days) |

### `archon isolation`

| Command | Description |
|---------|-------------|
| `archon isolation list` | List all active worktrees |
| `archon isolation cleanup` | Remove stale worktrees (older than 7 days) |
| `archon isolation cleanup <days>` | Remove stale worktrees older than N days |
| `archon isolation cleanup --merged` | Remove worktrees whose branches merged into main |
| `archon isolation cleanup --merged --include-closed` | Also remove worktrees with closed (abandoned) PRs |

### `archon complete`

| Command | Description |
|---------|-------------|
| `archon complete <branch>` | Remove worktree, local branch, and remote branch |
| `archon complete <branch> --force` | Skip uncommitted-changes check |

### `archon validate`

| Command | Description |
|---------|-------------|
| `archon validate workflows` | Validate all workflow definitions |
| `archon validate workflows <name>` | Validate a single workflow |
| `archon validate workflows <name> --json` | Machine-readable validation output |
| `archon validate commands` | Validate all command files |
| `archon validate commands <name>` | Validate a single command |

### `archon version`

```bash
archon version
```

---

## Variables

Variables are substituted at runtime in command bodies and workflow `prompt:` fields.

| Variable | Available In | Contains |
|----------|-------------|----------|
| `$ARGUMENTS` | Commands, prompts | All arguments passed to the command as a single string |
| `$1`, `$2`, `$3` | Commands, prompts | First, second, third positional arguments |
| `$ARTIFACTS_DIR` | Commands, prompts | Absolute path to the workflow run's artifact directory |
| `$WORKFLOW_ID` | Commands, prompts | The current workflow run ID |
| `$BASE_BRANCH` | Commands, prompts | Base git branch (auto-detected or set via `worktree.baseBranch`) |
| `$DOCS_DIR` | Commands, prompts | Documentation directory path (default: `docs/`) |
| `$<nodeId>.output` | DAG `when:` conditions, downstream `prompt:` fields | The text output from a completed node |

**Examples:**

```bash
# Pass a module name to a command
archon workflow run my-workflow "auth"
# $ARGUMENTS = "auth", $1 = "auth"

# Multi-argument
archon workflow run my-workflow "auth refresh-tokens"
# $ARGUMENTS = "auth refresh-tokens", $1 = "auth", $2 = "refresh-tokens"
```

```yaml
# Reference a node's output in a condition
- id: implement
  command: implement-changes
  when: "$classify.output.type == 'BUG'"
```

---

## Workflow YAML Schema

### Top-Level Options

| Field | Required | Type | Description |
|-------|----------|------|-------------|
| `name` | Yes | string | Identifies the workflow in `archon workflow list` |
| `description` | Yes | string | Shown in listings and used by the router |
| `nodes` | Yes | array | DAG nodes (see Node Options below) |
| `provider` | No | string | Registered provider identifier (e.g. `claude`, `codex`). Default: `claude` |
| `model` | No | string | Model for all nodes (`sonnet`, `opus`, `haiku`, or full model ID) |
| `modelReasoningEffort` | No | string | Codex only: `minimal` \| `low` \| `medium` \| `high` \| `xhigh` |
| `webSearchMode` | No | string | Codex only: `disabled` \| `cached` \| `live` |
| `additionalDirectories` | No | string[] | Extra directories available to the AI |

### Node Options (DAG)

All nodes share these base fields:

| Field | Required | Type | Description |
|-------|----------|------|-------------|
| `id` | Yes | string | Unique node identifier; used in `depends_on` and `$nodeId.output` |
| `command` | One of | string | Name of a command file in `.archon/commands/` |
| `prompt` | One of | string | Inline AI instructions |
| `bash` | One of | string | Shell script (runs without AI; stdout captured as `$nodeId.output`) |
| `loop` | One of | object | Loop configuration (see Loop Options below) |
| `depends_on` | No | string[] | Node IDs that must complete before this node runs |
| `when` | No | string | Condition expression; node is skipped if false |
| `trigger_rule` | No | string | Join semantics when multiple upstreams exist (see Trigger Rules) |
| `provider` | No | string | Per-node provider override (any registered provider) |
| `model` | No | string | Per-node model override |
| `context` | No | `fresh` \| `shared` | Session context — `fresh` starts a new conversation, `shared` inherits from prior node |
| `output_format` | No | JSON Schema | Enforce structured JSON output from this node |
| `allowed_tools` | No | string[] | Restrict available tools to this list (Claude only) |
| `denied_tools` | No | string[] | Remove specific tools from this node's context (Claude only) |
| `idle_timeout` | No | number | Per-node idle timeout in milliseconds (default: 5 minutes) |
| `retry` | No | object | Retry configuration for transient failures (see Retry Options) |
| `hooks` | No | object | SDK hook callbacks (Claude only; see Hook Schema) |
| `mcp` | No | string | Path to MCP server config JSON file (Claude only) |
| `skills` | No | string[] | Skill names to preload into this node's context (Claude only) |

> **bash node timeout**: The `timeout` field on bash nodes is in **milliseconds** (default: 120000). This differs from hook `timeout`, which is in seconds.

### Trigger Rules

| Value | Behavior |
|-------|----------|
| `all_success` | Run only if all upstream nodes succeeded (default) |
| `one_success` | Run if at least one upstream node succeeded |
| `none_failed_min_one_success` | Run if no upstream failed and at least one succeeded |
| `all_done` | Run after all upstream nodes complete, regardless of result |

### Loop Node Options

Defined under `loop:` inside a node:

| Field | Required | Type | Description |
|-------|----------|------|-------------|
| `prompt` | Yes | string | AI instructions executed each iteration |
| `until` | Yes | string | Completion signal string — loop ends when AI output contains this |
| `max_iterations` | Yes | number | Maximum iterations before the node fails |
| `fresh_context` | No | boolean | Start a new session each iteration (default: false) |
| `until_bash` | No | string | Shell script run after each iteration; exit 0 signals completion |

**Example:**

```yaml
- id: refine
  loop:
    prompt: "Review the current draft and improve it. Output COMPLETE when done."
    until: "COMPLETE"
    max_iterations: 5
```

### Retry Options

Defined under `retry:` inside a node:

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `max_attempts` | Yes | — | Retry attempts after the initial failure (max: 5) |
| `delay_ms` | No | 3000 | Initial delay in milliseconds; doubles each attempt (1000-60000) |
| `on_error` | No | `transient` | `transient` retries rate limits/network errors; `all` retries everything except fatal errors |

> **Fatal errors are never retried**: auth failures, permission errors, and exhausted credit balances fail immediately regardless of retry config.

---

## Hook Schema

Hooks are defined per-node under `hooks:`. See [Chapter 9](/book/hooks-and-quality/) for full examples.

```yaml
hooks:
  PreToolUse:
    - matcher: "Write|Edit"    # Regex against tool name. Omit to match all.
      timeout: 60              # Seconds. Default: 60.
      response:
        hookSpecificOutput:
          hookEventName: PreToolUse
          additionalContext: "Verify the file before writing"
          permissionDecision: deny    # allow | deny | ask
          permissionDecisionReason: "Not allowed in this node"
          updatedInput:               # Override tool arguments
            file_path: "/sandbox/out.ts"
  PostToolUse:
    - matcher: "Read"
      response:
        hookSpecificOutput:
          hookEventName: PostToolUse
          additionalContext: "This file is read-only. Do not modify it."
```

| Hook Event | When it fires |
|------------|--------------|
| `PreToolUse` | Before a tool executes |
| `PostToolUse` | After a tool completes successfully |
| `PostToolUseFailure` | After a tool fails |
| `SessionStart` / `SessionEnd` | On session lifecycle events |
| `Stop` | When the agent stops |

---

## Directory Structure

### `~/.archon/` (user-level)

```
~/.archon/
├── config.yaml                        # Global configuration (non-secrets)
├── archon.db                          # SQLite database (default; no DATABASE_URL needed)
└── workspaces/
    └── <owner>/
        └── <repo>/
            ├── source/                # Git clone or symlink to local path
            ├── worktrees/             # Per-task git worktrees
            ├── artifacts/             # Workflow artifacts (never committed)
            └── logs/                  # Workflow execution logs (JSONL)
```

### `.archon/` (repo-level)

```
.archon/
├── config.yaml                        # Repo-specific configuration
├── commands/                          # Custom command files (*.md)
│   └── my-command.md
└── workflows/                         # Custom workflow files (*.yaml)
    └── my-workflow.yaml
```

**Bundled defaults** — built-in commands and workflows ship with Archon and load automatically. Repo-level files with the same name override the bundled version. To disable defaults entirely:

```yaml
# .archon/config.yaml
defaults:
  loadDefaultCommands: false
  loadDefaultWorkflows: false
```

---

## Troubleshooting

### Common Errors

| Error | Likely Cause | Fix |
|-------|-------------|-----|
| `Workflow "X" not found` | YAML file not discovered | Check file is in `.archon/workflows/` and `archon workflow list` shows it |
| `Command "X" not found` | Command file missing | Check `.archon/commands/X.md` exists and `archon validate commands X` passes |
| `Routing unclear — falling back to archon-assist` | No workflow matched the input | Use an explicit workflow name: `archon workflow run my-workflow "..."` |
| `Worktree already exists for branch X` | Prior run left a worktree | Run `archon complete X` or `archon isolation cleanup` |
| `Not a git repository` | Running outside a repo | `cd` into a git repo first — workflow and isolation commands require one |
| `Model X is not valid for provider Y` | Provider/model mismatch | Each provider accepts specific models — check the provider's `isModelCompatible` rules. Claude accepts `sonnet`, `opus`, `haiku`, `claude-*`; Codex accepts other models. |
| `$BASE_BRANCH referenced but could not be detected` | No base branch set and auto-detection failed | Set `worktree.baseBranch` in `.archon/config.yaml` or ensure `main`/`master` exists |
| Workflow hangs with no output | Node idle timeout hit | Increase `idle_timeout` on the node (milliseconds) |

### Debug Techniques

**See what Archon found:**
```bash
archon workflow list          # Are your workflows loaded?
archon validate workflows     # Any YAML errors?
archon isolation list         # Any stale worktrees?
```

**Enable verbose logging:**
```bash
archon --verbose workflow run my-workflow "..."
```

**Check execution logs** — each run writes a JSONL log:
```
~/.archon/workspaces/<owner>/<repo>/logs/
```

**Run without isolation** to simplify debugging:
```bash
archon workflow run my-workflow --no-worktree "..."
```

**Test a command directly** before embedding it in a workflow:
```bash
archon workflow run archon-assist "/command-invoke my-command some-arg"
```

### Getting Help

- **Validate your YAML**: `archon validate workflows my-workflow`
- **Check the logs**: `~/.archon/workspaces/<owner>/<repo>/logs/`
- **Report issues**: [github.com/anthropics/claude-code/issues](https://github.com/anthropics/claude-code/issues)

---

You've covered the full guide — from mental model to hooks to this reference. When you need to look something up quickly, this is the page to come back to.
