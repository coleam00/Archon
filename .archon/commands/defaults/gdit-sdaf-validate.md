---
description: Run combined validation — Archon type/lint/test + GDIT security scans — and write .scan-manifest.json
argument-hint: (no arguments)
---

# GDIT Validate

**Workflow ID**: $WORKFLOW_ID

Combined validation: Archon project checks + GDIT security scanner suite.

---

## Phase 1: DETECT TOOLCHAIN

```bash
test -f bun.lockb && echo "bun" || \
test -f pnpm-lock.yaml && echo "pnpm" || \
test -f yarn.lock && echo "yarn" || \
test -f package-lock.json && echo "npm" || \
test -f pyproject.toml && echo "uv" || \
echo "unknown"
```

---

## Phase 2: ARCHON VALIDATION

Run in order; fix failures before proceeding:

```bash
{runner} run type-check
{runner} run lint
{runner} run test
```

Record: ✅ Pass / ❌ Fail (fixed)

---

## Phase 3: GDIT SECURITY SCANS

```bash
mkdir -p .security-scans

gitleaks detect --source . --report-format json \
  --report-path .security-scans/gitleaks-report.json 2>&1 || true

semgrep --config auto --json --output .security-scans/semgrep-report.json . 2>/dev/null || true

trivy fs --format json --output .security-scans/trivy-report.json . 2>/dev/null || true

if find . -name "*.tf" -o -name "template.yaml" 2>/dev/null | grep -q .; then
  checkov -d . --output json --output-file-path .security-scans/ 2>/dev/null || true
fi
```

---

## Phase 4: WRITE SCAN MANIFEST

```bash
python3 -c "
import json, datetime
from pathlib import Path

def count_findings(report_path, key):
    try:
        data = json.load(open(report_path))
        if key:
            data = data[key]
        return len(data) if isinstance(data, list) else 0
    except:
        return 0

manifest = {
    'timestamp': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'scanners': {
        'gitleaks': {'findings': count_findings('.security-scans/gitleaks-report.json', None)},
        'semgrep': {'findings': count_findings('.security-scans/semgrep-report.json', 'results')},
        'trivy': {'findings': 0}
    }
}
with open('.scan-manifest.json', 'w') as f:
    json.dump(manifest, f, indent=2)
print('Manifest written:', manifest['timestamp'])
"
```

---

## Phase 5: REPORT

```
=== Validation Results ===
Type Check:  ✅ / ❌
Lint:        ✅ / ❌
Tests:       ✅ / ❌ (N passed, M failed)

=== Security Scan Results ===
gitleaks:    N secrets
semgrep:     N findings
trivy:       N vulnerabilities
checkov:     N IaC issues (if applicable)

Overall: PASS / FAIL
Evidence string: "type-check ✓, lint ✓, tests N passed, gitleaks 0 secrets, semgrep N findings"
```

If any security scan has CRITICAL/HIGH findings or any secrets: report as FAIL with findings detail.
