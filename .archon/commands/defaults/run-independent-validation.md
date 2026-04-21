---
description: Run an independent validation pass before publication
argument-hint: (no arguments - reads the same artifacts as the reviewer)
---

# Independent Validation Pass

## Mission

Provide a second opinion before PR publication. In V1 this is an independent validator
role; in V2 it may be backed by Copilot. Treat this as a blocking gate.

## Inputs

- `$ARTIFACTS_DIR/selected-issue.json`
- `$ARTIFACTS_DIR/implementation-summary.json`
- `$ARTIFACTS_DIR/validation-report.json`
- `$ARTIFACTS_DIR/claude-review.json`

## Required artifact

Write `$ARTIFACTS_DIR/validator-report.json` with:

```json
{
  "verdict": "pass",
  "reasoning": "",
  "concerns": []
}
```

If the verdict is `block`, explain why the issue should not be published yet and stop
the workflow.

## Output

End with the validator verdict and the artifact path only.
