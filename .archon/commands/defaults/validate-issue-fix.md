---
description: Run targeted validation for the approved public issue fix
argument-hint: (no arguments - reads implementation and preview artifacts)
---

# Validate Issue Fix

## Mission

Run the validation plan from the preview and implementation artifacts. Prefer targeted
checks that prove the bugfix over broad, slow suites when both are acceptable.

## Inputs

- `$ARTIFACTS_DIR/fix-preview.json`
- `$ARTIFACTS_DIR/implementation-summary.json`

## Required artifact

Write `$ARTIFACTS_DIR/validation-report.json` with:

```json
{
  "commands": [
    {
      "command": "",
      "status": "passed",
      "duration_ms": 0,
      "summary": ""
    }
  ],
  "overall_status": "passed",
  "blocking_findings": []
}
```

Include every validation command you actually ran. If any required check fails, set
`overall_status` to `blocked`, list the blocking findings, and stop the workflow by
reporting the failure clearly.

## Output

End with a short validation verdict and the artifact path only.
