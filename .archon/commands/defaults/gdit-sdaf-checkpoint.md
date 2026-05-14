---
description: Create a GDIT-compliant git checkpoint commit with Compliance and Evidence fields
argument-hint: <type> <message> (e.g. "feat add user authentication")
---

# GDIT Checkpoint

**Arguments**: $ARGUMENTS (format: `<type> <message>`)

Create an atomic git checkpoint with NIST 800-218 compliance metadata.

---

## Step 1: Parse Arguments

Extract from $ARGUMENTS:

- `TYPE`: first word (fix | feat | docs | refactor | test | chore)
- `MESSAGE`: remaining words

If $ARGUMENTS is empty: derive from `git diff --cached --stat` output.

---

## Step 2: Check Scan Freshness

```bash
python3 -c "
import json, datetime, sys
try:
    with open('.scan-manifest.json') as f:
        d = json.load(f)
    ts = datetime.datetime.fromisoformat(d['timestamp'])
    age = (datetime.datetime.now(datetime.timezone.utc) - ts).total_seconds()
    print(int(age))
except:
    print(99999)
"
```

If age > 1800 seconds (30 min): warn the user and recommend running `gdit-sdaf-validate` first.
_(Do NOT block — the blocking behavior is opt-in via the pre-commit hook.)_

---

## Step 3: Determine NIST Compliance Tags

Map the task type to the most specific NIST 800-218 sub-practice(s):

| Task type                        | NIST 800-218 sub-practice |
| -------------------------------- | ------------------------- |
| Security scanning                | PW.7.1, PW.4.1            |
| Input validation / secure coding | PW.1.1, PW.5.1            |
| IaC security controls            | PS.1.1, PW.1.1            |
| Dependency management            | PS.3.1                    |
| Testing                          | PW.8.1, PW.8.2            |
| SBOM / release integrity         | PS.3.2                    |
| Documentation / requirements     | PO.1.1                    |
| Vulnerability fix                | RV.1.1, RV.2.1            |
| Feature / general implementation | PW.1.1                    |

Read the current task context from `.kiro/specs/*/tasks.md` to determine the most specific tag.

---

## Step 4: Build Evidence String

Read `.scan-manifest.json` and/or recent test output to build:
`Evidence: gitleaks 0 secrets, semgrep N findings, trivy N vulns, tests N passed`

If no scan data: `Evidence: no scan data (run gdit-sdaf-validate before checkpoint)`

---

## Step 5: Stage Files

Stage only files relevant to the current task:

```bash
git diff --name-only HEAD
git status --short
```

Stage specific files (do NOT `git add -A` or `git add .`):

```bash
git add <file1> <file2> ...
```

---

## Step 6: Commit

```bash
git commit -m "$(cat <<'EOF'
{TYPE}: {MESSAGE}

{2-3 line bullet summary of what changed}

Compliance: NIST 800-218 {XX.N.N, XX.N.N}
Evidence: {evidence string}
EOF
)"
```

---

## Step 7: Confirm

Report:

- Commit hash and message
- Files staged
- Compliance tags applied
- Evidence recorded
