---
description: Prepare finalize-PR artifacts from workflow outputs
argument-hint: (no arguments - reads workflow artifacts)
---

# Compose Finalize Pull Request

Prepare deterministic PR artifacts from the workflow outputs. Do not run `gh pr create`,
`gh pr edit`, or `gh pr ready` here. A downstream script applies the PR after these
artifacts are written.

**Workflow ID**: $WORKFLOW_ID

## Load Workflow Context

Read:

```bash
cat $ARTIFACTS_DIR/plan-context.md
cat $ARTIFACTS_DIR/implementation.md
cat $ARTIFACTS_DIR/validation.md
```

Extract:
- Plan title and summary
- Branch context
- Files changed
- Tests written
- Validation results
- Deviations from plan

Also check for a PR template at:
- `.github/pull_request_template.md`
- `.github/PULL_REQUEST_TEMPLATE.md`
- `docs/PULL_REQUEST_TEMPLATE.md`

If a template exists, keep its structure and fill every section with actual content.

## Required Outputs

Write these files exactly:

1. `$ARTIFACTS_DIR/commit-message.txt`
2. `$ARTIFACTS_DIR/pr-title.txt`
3. `$ARTIFACTS_DIR/pr-body.md`
4. `$ARTIFACTS_DIR/pr-request.json`
5. `$ARTIFACTS_DIR/pr-summary.md`

### `commit-message.txt`

- A complete git commit message
- Subject line first, optional body after a blank line
- Must match the implementation described in the workflow artifacts

### `pr-title.txt`

- One line only
- Derived from the plan title and implementation outcome

### `pr-body.md`

- Use the project template if present
- Otherwise include at least:
  - `## Summary`
  - `## Changes`
  - `## Tests`
  - `## Validation`
  - `## Implementation Notes`
- Include deviations or issues only if they actually occurred

### `pr-request.json`

Write exactly this JSON unless verified workflow context requires something else:

```json
{
  "draft": false,
  "ready": true
}
```

### `pr-summary.md`

Write the final human summary template for the downstream PR script. Use these
placeholders literally:

- `__PR_URL__`
- `__PR_NUMBER__`
- `__PR_STATE__`
- `__PR_BRANCH__`
- `__PR_BASE__`
- `__PR_TITLE__`
- `__COMMIT_SHA__`

Recommended structure:

```markdown
## PR Ready

**URL**: __PR_URL__
**Branch**: __PR_BRANCH__ -> __PR_BASE__
**State**: __PR_STATE__
**Title**: __PR_TITLE__
**Commit**: __COMMIT_SHA__

### Summary
{brief implementation summary}

### Validation
- {validated item}

### Notes
{deviations or follow-up notes if any}
```

## Constraints

- Do not mutate git or GitHub state in this step
- Do not leave template placeholders unresolved except the explicit `__PR_*__` placeholders above
- Make the artifacts reflect the actual workflow outputs, not assumptions
