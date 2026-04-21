# Variable Substitution Reference

Variables are placeholders in command files and workflow prompts that get replaced at execution time.

## Variable Table

| Variable | Scope | Description |
|----------|-------|-------------|
| `$ARGUMENTS` | All modes | The user's original message passed to the workflow |
| `$USER_MESSAGE` | All modes | Same as `$ARGUMENTS` — both resolve to the user's message |
| `$WORKFLOW_ID` | All modes | Unique workflow run ID (for tracking and logging) |
| `$ARTIFACTS_DIR` | All modes | Pre-created directory for this workflow run's artifacts. Write outputs here |
| `$BASE_BRANCH` | All modes | Base branch name. Auto-detected from git, or set via `worktree.baseBranch` in config. Throws if referenced but unresolvable |
| `$CONTEXT` | All modes | GitHub issue/PR context (if available from platform). Empty string if unavailable |
| `$EXTERNAL_CONTEXT` | All modes | Alias for `$CONTEXT` |
| `$ISSUE_CONTEXT` | All modes | Alias for `$CONTEXT` |
| `$nodeId.output` | DAG only | Full text output of a completed upstream node |
| `$nodeId.output.field` | DAG only | JSON field access on structured output from upstream node (string/number/boolean) |

## Variable Availability

All variables are available in all workflows. The only exception is `$nodeId.output` / `$nodeId.output.field`, which is DAG-only (requires an upstream node to reference).

## Where Variables Are Substituted

- **Command files** (`.archon/commands/*.md`) — all variables except `$nodeId.output`
- **Inline `prompt:` fields** — in DAG prompt nodes and loop node prompts
- **`bash:` scripts in DAG nodes** — `$nodeId.output` references are automatically shell-quoted (single-quoted with `'` escaped)

## Substitution Order

1. Standard workflow variables (`$WORKFLOW_ID`, `$ARGUMENTS`, `$ARTIFACTS_DIR`, `$BASE_BRANCH`, `$CONTEXT`)
2. Node output references (`$nodeId.output`, `$nodeId.output.field`) — DAG mode only

## Context Auto-Append

If `$CONTEXT` / `$EXTERNAL_CONTEXT` / `$ISSUE_CONTEXT` is NOT present anywhere in the prompt template but context exists (e.g., from a GitHub issue), it is automatically appended at the end after a `---` separator.

## Escaped Dollar Signs

Use `\$` to produce a literal `$` in command files (prevents variable substitution).

## Node Output Details (DAG Only)

`$nodeId.output` resolves to the full text output of the upstream node. If the node used `output_format:` (structured output), the output is the JSON-stringified result.

`$nodeId.output.field` parses the output as JSON and extracts the named field. Only works when the upstream node produced structured output via `output_format:`. Returns the string representation of the field value.

In `bash:` nodes, `$nodeId.output` values are automatically shell-escaped before injection to prevent command injection.

Unknown node references resolve to an empty string (with a warning logged).
