---
description: Push the approved fix to the user's fork and open a draft PR
argument-hint: (no arguments - publish only after all gates pass)
---

# Publish Draft PR

## Mission

Publish the approved public issue fix to the authenticated user's fork as a draft PR.

## Inputs

- `$ARTIFACTS_DIR/selected-issue.json`
- `$ARTIFACTS_DIR/implementation-summary.json`
- `$ARTIFACTS_DIR/validation-report.json`
- `$ARTIFACTS_DIR/claude-review.json`
- `$ARTIFACTS_DIR/validator-report.json`
- `$ARTIFACTS_DIR/pr-preview.json`

## Required work

1. Confirm both review artifacts are passing.
2. Commit any staged implementation changes with an issue-specific message.
3. Push the prepared branch to the user's fork remote.
4. Open a draft PR against `traefik/traefik`.
5. Persist the PR metadata for downstream UI and workflow steps.

## Required artifacts

Update `$ARTIFACTS_DIR/pr-preview.json` so `publish_status` becomes `published` and the
final PR title/body/url are captured.

Also write:

- `$ARTIFACTS_DIR/.pr-number`
- `$ARTIFACTS_DIR/.pr-url`

## Output

End with the PR URL and the artifact paths only.
