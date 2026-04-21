---
description: Build a read-only preview for the selected public issue fix before approval
argument-hint: (no arguments - reads investigation artifacts)
---

# Build Fix Preview

## Mission

Turn the deterministic investigation into an approval-ready preview. This step is
still read-only. Do not create a fork, branch, commit, or PR.

## Inputs

- `$ARTIFACTS_DIR/selected-issue.json`
- `$ARTIFACTS_DIR/investigation.md`

## Required work

Produce a clear preview for a human approver that explains:

1. Why this issue was selected
2. Which files are likely to change
3. Which validation commands will run
4. What draft PR title/body will likely be used
5. What risks may still block publication

## Required artifacts

Write `$ARTIFACTS_DIR/fix-preview.json` with:

```json
{
  "selected_issue": {},
  "why_this_issue": "",
  "expected_files_to_change": [],
  "planned_validation_commands": [],
  "expected_pr_title": "",
  "expected_pr_summary": "",
  "main_risks": [],
  "write_actions_pending_approval": true
}
```

Write `$ARTIFACTS_DIR/fix-preview.md` as a human-readable version of the same plan.

## Output

End with a short preview summary and the two artifact paths only.
