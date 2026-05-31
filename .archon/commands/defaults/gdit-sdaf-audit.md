---
description: Run GDIT steering compliance audit on a spec directory
allowed-tools: Read, Bash, Glob
argument-hint: <.kiro/specs/feature-name/> or (blank to audit all)
---

Run the steering compliance audit.

## Step 1: Run Audit

```bash
if [ -z "$ARGUMENTS" ]; then
  find . -path ".kiro/specs/*/tasks.md" 2>/dev/null | while read f; do
    spec_dir=$(dirname "$f")
    echo "=== Auditing: $spec_dir ==="
    python3 ~/.kiro/scripts/audit-steering-compliance.py "$spec_dir" 2>/dev/null || \
      echo "audit-steering-compliance.py not found — run gdit-sdaf-setup"
  done
else
  python3 ~/.kiro/scripts/audit-steering-compliance.py $ARGUMENTS
fi
```

## Step 2: Report

Report all PASS, FAIL, WARN, and SKIP results clearly.

If any FAIL exists: list each failure with the specific remediation step needed.

If 0 FAILs: confirm "Steering compliance audit passed."
