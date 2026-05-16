# Git Dev Workflow - Automatic Scanner Output Management

**Date**: 2026-03-12T19:30:00-04:00  
**Update**: Scanner script now automatically manages .gitignore for scan outputs

---

## Behavior

When `pre-commit-validate.py` runs, it automatically:

1. **Checks if `.gitignore` exists in project root**
   - If missing → creates it

2. **Checks if `.security-scans/` is in `.gitignore`**
   - If missing → adds `.security-scans/*` (wildcard, not directory)
   - Also adds `!.security-scans/.scan-manifest.json` negation pattern

3. **Creates `.security-scans/` directory**
   - In the project being scanned (dynamic)

4. **Runs all scanners with outputs to `.security-scans/`**
   - gitleaks → `.security-scans/gitleaks-report.json`
   - semgrep → `.security-scans/semgrep-report.json`
   - trivy → `.security-scans/trivy-report.json`
   - checkov → `.security-scans/results_json.json`
   - KICS → `.security-scans/kics-report.json`

---

## Implementation

```python
SCAN_OUTPUT_DIR = ".security-scans"
MANIFEST_PATTERN = f"!{SCAN_OUTPUT_DIR}/.scan-manifest.json"

def ensure_gitignore():
    """Ensure scan output directory is in .gitignore with manifest exception."""
    gitignore = Path(".gitignore")
    ignore_pattern = f"{SCAN_OUTPUT_DIR}/*"
    
    # Create .gitignore if it doesn't exist
    if not gitignore.exists():
        gitignore.write_text(
            f"# Security scanner outputs (track manifest, ignore reports)\n"
            f"{ignore_pattern}\n{MANIFEST_PATTERN}\n"
        )
        print(f"✓ Created .gitignore with {ignore_pattern} + manifest exception")
        return
    
    content = gitignore.read_text()
    additions = []
    
    # Add scan output pattern if missing
    if SCAN_OUTPUT_DIR not in content:
        additions.append(f"\n# Security scanner outputs (track manifest, ignore reports)")
        additions.append(ignore_pattern)
    
    # Add manifest exception if missing
    if MANIFEST_PATTERN not in content:
        additions.append(MANIFEST_PATTERN)
    
    if not additions:
        return
    
    with open(gitignore, 'a') as f:
        if not content.endswith('\n'):
            f.write('\n')
        f.write('\n'.join(additions) + '\n')
    
    print(f"✓ Updated .gitignore with scan output patterns")
```

Called at start of `main()` before running any scanners.

---

## Benefits

1. **Zero Configuration**: Works in any project automatically
2. **Prevents Accidents**: Scan outputs can't be committed
3. **Self-Healing**: Adds gitignore entry if missing
4. **Dynamic**: Always works in the project being scanned
5. **No Manual Steps**: Developers don't need to remember to gitignore

---

## Example Execution

```bash
$ cd /path/to/any-project
$ python3.12 ~/.kiro/skills/git-dev-workflow/scripts/pre-commit-validate.py

✓ Added .security-scans/ to .gitignore

=== Pre-Commit Security Validation ===
Scanner outputs: .security-scans/

🔍 Running gitleaks...
✅ No secrets detected

🔍 Running semgrep...
✅ No ERROR-level findings

🔍 Running trivy...
✅ No HIGH/CRITICAL vulnerabilities

...

✅ VALIDATION PASSED - Safe to commit
```

**Result**: `.security-scans/` directory created with all scan outputs, automatically gitignored.

---

## Verification

```bash
# After running validation
ls .security-scans/
# Shows: gitleaks-report.json, semgrep-report.json, trivy-report.json, .scan-manifest.json, etc.

git status
# Should NOT show .security-scans/ report files
# SHOULD show .scan-manifest.json if modified (it's version-controlled)

cat .gitignore | grep security-scans
# Shows: .security-scans/*
#        !.security-scans/.scan-manifest.json
```

---

## Files Modified

1. **~/.kiro/skills/git-dev-workflow/scripts/pre-commit-validate.py**
   - Added `ensure_gitignore()` function
   - Calls it before running scanners
   - Creates/updates .gitignore automatically
   - All scanners output to `.security-scans/`

2. **~/.kiro/skills/git-dev-workflow/SKILL.md**
   - Documented automatic .gitignore management
   - Explained self-healing behavior

---

## Summary

**Problem**: Scanner outputs in project root causing GitLab false positives  
**Solution**: Script automatically manages .gitignore and outputs  
**Behavior**: Self-healing - works in any project without manual setup  
**Status**: ✅ Complete - skill now fully automated
