---
title: Variable Reference
description: Complete reference for all variable substitutions available in Archon commands and workflows.
category: reference
area: workflows
audience: [user]
sidebar:
  order: 5
---

Archon substitutes variables in command files, inline prompts, bash scripts, and `script:` node bodies before execution. There are three categories of variables: workflow variables (substituted by the workflow engine), positional arguments (substituted by the command handler), and node output references (DAG workflows only).

## Workflow Variables

These variables are substituted by the workflow executor in all node types (`command:`, `prompt:`, `bash:`, `script:`, `loop:`).

| Variable | Resolves to | Notes |
|----------|-------------|-------|
| `$ARGUMENTS` | The user's input message that triggered the workflow | Primary way to pass user input to commands |
| `$USER_MESSAGE` | Same as `$ARGUMENTS` | Alias |
| `$WORKFLOW_ID` | Unique ID for the current workflow run | Useful for artifact naming and log correlation |
| `$ARTIFACTS_DIR` | Pre-created external artifacts directory (`~/.archon/workspaces/<owner>/<repo>/artifacts/runs/<id>/`) | Always exists before node execution; stored outside the repo to avoid polluting the working tree |
| `$BASE_BRANCH` | Base branch for git operations | Auto-detected from the repository's default branch, or set via `worktree.baseBranch` in `.archon/config.yaml`. Throws an error if referenced in a prompt but cannot be resolved |
| `$DOCS_DIR` | Documentation directory path | Configured via `docs.path` in `.archon/config.yaml`. Defaults to `docs/` when not set. Never throws |
| `$CONTEXT` | GitHub issue or PR context, if available | Populated when the workflow is triggered from a GitHub issue/PR. Replaced with empty string when unavailable |
| `$EXTERNAL_CONTEXT` | Same as `$CONTEXT` | Alias |
| `$ISSUE_CONTEXT` | Same as `$CONTEXT` | Alias |
| `$LOOP_USER_INPUT` | User feedback from an interactive loop approval gate | Only populated on the first iteration of a resumed interactive loop. Empty string on all other iterations |
| `$REJECTION_REASON` | Reviewer feedback from an approval node rejection | Only available in `on_reject` prompts. Empty string elsewhere |
| `$LOOP_PREV_OUTPUT` | Cleaned output of the previous loop iteration (loop nodes only) | Empty string on the first iteration. Useful for `fresh_context: true` loops that need to reference the prior pass without carrying the full session history |

### Context Variable Behavior

The three context aliases (`$CONTEXT`, `$EXTERNAL_CONTEXT`, `$ISSUE_CONTEXT`) all resolve to the same value. When no issue context is available, they are replaced with an empty string to avoid sending the literal `$CONTEXT` text to the AI.

If issue context is present but no context variable appears in the prompt, the context is **appended** to the end of the prompt automatically. This prevents duplicate context when a command explicitly uses `$CONTEXT`.

### `$BASE_BRANCH` Fail-Fast

Unlike other variables, `$BASE_BRANCH` will cause the workflow to **fail immediately** if:
- The variable is referenced in a prompt, AND
- Auto-detection from git fails, AND
- `worktree.baseBranch` is not set in `.archon/config.yaml`

If the variable is not referenced, no error occurs even if the base branch cannot be determined.

## Positional Arguments

These variables are substituted by the command handler when commands are invoked directly (outside workflows). They are processed before workflow variables.

| Variable | Resolves to | Notes |
|----------|-------------|-------|
| `$1` | First positional argument | Split by whitespace from the user's input |
| `$2` | Second positional argument | |
| `$3` ... `$9` | Third through ninth positional arguments | |
| `$ARGUMENTS` | All arguments as a single string | Same variable, available in both contexts |
| `\$` | Literal `$` character | Escape a dollar sign to prevent substitution |

## Node Output References

In DAG workflows, nodes can reference the output of any completed upstream node. These are substituted after workflow variables.

| Pattern | Resolves to | Notes |
|---------|-------------|-------|
| `$nodeId.output` | Full output string of the referenced node | The node must be a declared dependency (in `depends_on`) |
| `$nodeId.output.field` | A specific JSON field from the node's output | Requires the upstream node to use `output_format` for structured JSON |

### Shell Quoting in `bash:` vs `script:`

`$nodeId.output` values are **auto shell-quoted** (single-quoted, with embedded `'` escaped) when substituted into `bash:` scripts, so the value is always safe to embed in a shell command. They are **not** shell-quoted when substituted into `script:` bodies — the raw value is embedded as-is. For script nodes, treat substituted values as untrusted input and parse them with language features (e.g. `JSON.parse`), not by interpolating into shell syntax.

### Example

```yaml
nodes:
  - id: classify
    command: classify-issue
    output_format:
      type: object
      properties:
        type: { type: string, enum: [BUG, FEATURE] }
      required: [type]

  - id: fix
    prompt: |
      The issue was classified as: $classify.output.type
      Full classification: $classify.output
      User's original request: $USER_MESSAGE
    depends_on: [classify]
```

## Substitution Order

Variables are substituted in a defined order:

1. **Workflow variables** -- `$WORKFLOW_ID`, `$USER_MESSAGE`, `$ARGUMENTS`, `$ARTIFACTS_DIR`, `$BASE_BRANCH`, `$DOCS_DIR`, `$LOOP_USER_INPUT`, `$REJECTION_REASON`, `$LOOP_PREV_OUTPUT`
2. **Context variables** -- `$CONTEXT`, `$EXTERNAL_CONTEXT`, `$ISSUE_CONTEXT`
3. **Node output references** -- `$nodeId.output`, `$nodeId.output.field`

Positional arguments (`$1` through `$9`) are substituted separately by the command handler and are only available when commands are invoked directly, not through workflow nodes.

## Variable Availability by Context

| Variable | Workflow nodes | Direct command invocation | `when:` conditions |
|----------|---------------|--------------------------|-------------------|
| `$ARGUMENTS` / `$USER_MESSAGE` | Yes | Yes (as `$ARGUMENTS`) | No |
| `$1` ... `$9` | No | Yes | No |
| `$WORKFLOW_ID` | Yes | No | No |
| `$ARTIFACTS_DIR` | Yes | No | No |
| `$BASE_BRANCH` | Yes | No | No |
| `$DOCS_DIR` | Yes | No | No |
| `$CONTEXT` / aliases | Yes | No | No |
| `$LOOP_USER_INPUT` | Yes (loop nodes) | No | No |
| `$REJECTION_REASON` | Yes (`on_reject` only) | No | No |
| `$LOOP_PREV_OUTPUT` | Yes (loop nodes) | No | No |
| `$nodeId.output` | Yes (DAG nodes) | No | Yes |
