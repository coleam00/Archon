---
description: Review the proposed fix and block publication if risks remain
argument-hint: (no arguments - reads diff and validation artifacts)
---

# Review Proposed Draft PR

## Mission

Act as the blocking reviewer before draft PR publication. Review the actual diff,
the selected issue, and the validation results. This step should block publication if
the change is unsafe, incomplete, or insufficiently validated.

## Inputs

- `$ARTIFACTS_DIR/selected-issue.json`
- `$ARTIFACTS_DIR/implementation-summary.json`
- `$ARTIFACTS_DIR/validation-report.json`
- current git diff

## Required artifact

Write `$ARTIFACTS_DIR/claude-review.json` with:

```json
{
  "verdict": "pass",
  "blocking_findings": [],
  "non_blocking_notes": [],
  "publish_recommendation": ""
}
```

If the verdict is `block`, explain the exact blocker and treat the run as failed so
publication does not continue.

## Output

End with the review verdict and the artifact path only.
