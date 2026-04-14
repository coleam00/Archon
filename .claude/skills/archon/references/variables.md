# Variable Substitution Reference For Codex

Variables are placeholders in command files and workflow prompts. Archon
replaces them at execution time.

## Variable Table

| Variable | Scope | Description |
| --- | --- | --- |
| `$ARGUMENTS` | all modes | The original user message passed to the workflow |
| `$USER_MESSAGE` | all modes | Alias for `$ARGUMENTS` |
| `$WORKFLOW_ID` | all modes | Unique workflow run ID |
| `$ARTIFACTS_DIR` | all modes | Pre-created artifact directory for the current run |
| `$BASE_BRANCH` | all modes | Base branch name, auto-detected or configured via `worktree.baseBranch` |
| `$DOCS_DIR` | all modes | Repo docs directory, from `docs.path` or default `docs/` |
| `$CONTEXT` | all modes | GitHub issue or PR context when the platform provides it |
| `$EXTERNAL_CONTEXT` | all modes | Alias for `$CONTEXT` |
| `$ISSUE_CONTEXT` | all modes | Alias for `$CONTEXT` |
| `$LOOP_USER_INPUT` | interactive loop resumes | User feedback injected on the first resumed iteration, empty otherwise |
| `$REJECTION_REASON` | approval `on_reject` prompts | Reviewer feedback captured when an approval node rejects and re-prompts |
| `$nodeId.output` | DAG only | Full output from a completed upstream node |
| `$nodeId.output.field` | DAG only | JSON field access on structured output from an upstream node |

## Where Variables Are Substituted

- command files in `.archon/commands/*.md`
- inline `prompt:` fields
- `loop.prompt:` fields
- approval `on_reject.prompt` fields
- `bash:` scripts in DAG nodes

In `bash:` nodes, `$nodeId.output` values are automatically shell-quoted before
injection.

## Substitution Order

1. standard workflow variables such as `$WORKFLOW_ID`, `$ARGUMENTS`,
   `$ARTIFACTS_DIR`, `$BASE_BRANCH`, `$DOCS_DIR`, and `$CONTEXT`
2. node output references such as `$nodeId.output` and `$nodeId.output.field`

## Structured Output Notes

`$nodeId.output.field` only works when the upstream node produced structured
output through `output_format:`.

For Codex, `output_format:` is a real supported workflow surface. It maps to the
Codex client's structured-output path rather than being a Claude-only feature.

## Context Auto-Append

If a prompt template does not mention `$CONTEXT`, `$EXTERNAL_CONTEXT`, or
`$ISSUE_CONTEXT` anywhere but Archon has external context available, Archon may
append that context automatically after a separator.

## Literal Dollar Signs

Use `\\$` to produce a literal `$` without substitution.

## Unknown References

Unknown node references resolve to an empty string with a warning in the logs.
Do not depend on missing-node references as control flow.

## Interactive Workflow Notes

- `$LOOP_USER_INPUT` is only populated when an interactive loop resumes after an
  approval round-trip
- `$REJECTION_REASON` is only populated for an approval node's `on_reject`
  branch
- outside those contexts, both variables resolve to an empty string
