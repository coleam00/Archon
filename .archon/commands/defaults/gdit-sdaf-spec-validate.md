---
description: Validate a GDIT spec directory with validate-spec.py
argument-hint: <.kiro/specs/feature-name/> or (blank to validate all)
---

# GDIT Spec: Validate

**Target**: $ARGUMENTS (blank = all specs)

Run spec validation and report results. Fix any FAIL results before presenting as complete.

## Step 1: Run Validation

```bash
if [ -z "$ARGUMENTS" ]; then
  python3 ~/.kiro/scripts/validate-spec.py --all
else
  python3 ~/.kiro/scripts/validate-spec.py $ARGUMENTS
fi
```

## Step 2: Report Results

Parse the output and present:

- PASS gates: list briefly
- WARN gates: list with suggested remediation
- FAIL gates: list with **exact remediation steps**

If any FAIL: fix them (edit the spec files directly), re-run, repeat until 0 FAILs.

## Step 3: Confirm

If all gates pass: "Spec validated. Ready for implementation."
If unfixable issues: explain to user why and what they need to provide.
