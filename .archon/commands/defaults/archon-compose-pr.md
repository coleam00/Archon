---
description: Prepare deterministic PR artifacts for the current branch
argument-hint: [base-branch] (default: auto-detected from workflow)
---

# Compose Pull Request

Prepare PR artifacts for the current branch. Do not run `gh pr create`, `gh pr edit`,
or `gh pr ready` yourself in this command. A downstream script applies the PR
deterministically after these artifacts exist.

**Base branch override**: $ARGUMENTS
**Default base branch**: $BASE_BRANCH

> If a base branch was provided as an argument, use it as the PR base. Otherwise use `$BASE_BRANCH`.

## Gather Context

1. Inspect git state:

```bash
git branch --show-current
git status --short
git log origin/$BASE_BRANCH..HEAD --oneline
git diff --stat origin/$BASE_BRANCH...HEAD
```

2. If present, read the latest implementation report:

```bash
ls -t $ARTIFACTS_DIR/../reports/*-report.md 2>/dev/null | head -1
```

3. Check for a PR template at:
- `.github/pull_request_template.md`
- `.github/PULL_REQUEST_TEMPLATE.md`
- `docs/PULL_REQUEST_TEMPLATE.md`

If a template exists, use its structure and fill every section with real content.
If no template exists, use a concise summary/changes/validation format.

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
- Must describe the branch changes accurately if the worktree is still dirty

### `pr-title.txt`

- One line only
- Imperative PR title
- Match the implementation that is actually on the branch

### `pr-body.md`

- Complete PR body
- Use the project template if one exists
- Otherwise include at least:
  - `## Summary`
  - `## Changes`
  - `## Validation`
- If the work closes an issue, include the closing reference

### `pr-request.json`

Write exactly this JSON unless you have a verified reason to change it:

```json
{
  "draft": false,
  "ready": false
}
```

### `pr-summary.md`

Write a human-readable summary template that the downstream PR script can finalize.
Use these placeholders literally where appropriate:

- `__PR_URL__`
- `__PR_NUMBER__`
- `__PR_STATE__`
- `__PR_BRANCH__`
- `__PR_BASE__`
- `__PR_TITLE__`

Recommended structure:

```markdown
## PR Created

**URL**: __PR_URL__
**Branch**: __PR_BRANCH__ -> __PR_BASE__
**State**: __PR_STATE__
**Title**: __PR_TITLE__

### Summary
{brief description}

### Validation
- {validation item}
```

## Constraints

- Do not create or edit the PR directly in this step
- Do not write placeholder-only content
- Do not omit any of the five files
- Prefer facts from the implementation report, commits, diff, and validation output over guessing
