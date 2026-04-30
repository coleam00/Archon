---
description: Create a GSD ship report and pull request body for a verified phase
argument-hint: <phase number or milestone>
---

# Create GSD Ship Report

**Input**: $ARGUMENTS
**Artifacts directory**: $ARTIFACTS_DIR

## Mission

Prepare a verified phase for shipping by writing a ship report, pull request title, and pull request body.

## Required process

1. Read `$ARTIFACTS_DIR/ship-readiness.md`.
2. Read relevant `.planning/` project, roadmap, requirement, summary, and verification artifacts.
3. Inspect git status and recent commits.
4. Confirm the latest relevant verification report has `status: passed` or clearly explain any risk.
5. Write all required output files.

## Required output files

### `$ARTIFACTS_DIR/ship-report.md`

Include:

- Phase or milestone being shipped
- Summary of completed work
- Requirements covered
- Verification evidence
- Risks and follow-up items
- Recommended PR title and body

### `$ARTIFACTS_DIR/pr-title.txt`

Write a single-line PR title.

### `$ARTIFACTS_DIR/pr-body.md`

Include:

- Summary
- What changed
- Validation
- Verification report links/paths
- Follow-up items

## Final response

Return the ship report path, PR title, and whether the workflow is ready to create the PR after approval.
