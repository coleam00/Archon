# Git Dev Workflow - Scanner Output Fix

**Protocol**: SCANNER-OUTPUT-FIX  
**Date**: 2026-03-12T19:24:00-04:00  
**Issue**: Scanner outputs being created in project root, triggering GitLab false positives

---

## Problem

Security scanners (gitleaks, semgrep, trivy, checkov, KICS) were outputting JSON files to:
1. Project root directory
2. Current working directory
3. Uncontrolled locations

**Result**: Scan output files containing detected patterns were accidentally committed to git, triggering GitLab security findings.

---

## Solution Applied

### 1. Created Dedicated Output Directory

All scanners now output to `.security-scans/` directory:
- Created automatically by pre-commit-validate.py
- Gitignored to prevent accidental commits
- Centralized location for all scan outputs

### 2. Updated Scanner Commands

**Gitleaks**:
```bash
# Before: Output to stdout/stderr
gitleaks detect --source . --no-git --verbose

# After: Output to gitignored directory
gitleaks detect --source . --report-path .security-scans/gitleaks-report.json --report-format json
```

**Semgrep**:
```bash
# Before: Output to stdout
semgrep --json .

# After: Output to gitignored directory
semgrep --json --output .security-scans/semgrep-report.json .
```

**Trivy**:
```bash
# Before: Output to stdout
trivy fs --format json .

# After: Output to gitignored directory
trivy fs --format json --output .security-scans/trivy-report.json .
```

**Checkov**:
```bash
# Before: Creates results_json.json in current directory
checkov -d . --output json

# After: Output to gitignored directory
checkov -d . --output json --output-file-path .security-scans
```

**KICS**:
```bash
# Before: Creates results.json in current directory
kics scan -p .

# After: Output to gitignored directory
kics scan -p . --output-path .security-scans --output-name kics-report
```

### 3. Updated .gitignore

Added comprehensive exclusions:
```gitignore
# Security scanner outputs (should never be committed)
.security-scans/
gitleaks*.json
gitleaks-*.json
semgrep*.json
trivy*.json
checkov*.json
kics*.json
results_json.json
*-scan-results.json
*-security-findings.json
```

**Rationale**: Defense in depth - even if scanners create files outside `.security-scans/`, they're still ignored.

---

## Files Modified

1. **~/.kiro/skills/git-dev-workflow/scripts/pre-commit-validate.py**
   - Added `SCAN_OUTPUT_DIR = Path(".security-scans")`
   - Added `setup_output_dir()` function
   - Updated all scanner commands to use output directory
   - Updated result parsing to read from output files

2. **project/.gitignore**
   - Added `.security-scans/` directory
   - Added scanner output file patterns
   - Added `results_json.json` (checkov default)

3. **~/.kiro/skills/git-dev-workflow/SKILL.md**
   - Documented scanner output directory
   - Added note about gitignored outputs

---

## Benefits

1. **No Accidental Commits**: Scanner outputs can't be committed
2. **Clean Project Root**: All scan files in dedicated directory
3. **GitLab Compatibility**: No false positives from scan outputs
4. **Audit Trail**: Scan results preserved locally for review
5. **Easy Cleanup**: Delete entire `.security-scans/` directory

---

## Verification

```bash
# Run validation
python3.12 ~/.kiro/skills/git-dev-workflow/scripts/pre-commit-validate.py

# Check outputs
ls -la .security-scans/
# Should show:
# - gitleaks-report.json
# - semgrep-report.json
# - trivy-report.json
# - results_json.json (checkov)
# - kics-report.json (if KICS installed)

# Verify gitignored
git status
# Should NOT show .security-scans/ or any scanner JSON files
```

---

## Migration Notes

**Breaking Changes**: None - outputs now go to dedicated directory instead of stdout/root

**Behavior Changes**:
- Scanner outputs saved to `.security-scans/` for review
- Outputs automatically gitignored
- No more scan files in project root

---

## Cleanup Existing Files

If scan output files exist in your project:

```bash
# Remove from git tracking
git rm gitleaks*.json kics*.json semgrep*.json trivy*.json checkov*.json 2>/dev/null

# Remove from filesystem
rm -f gitleaks*.json kics*.json semgrep*.json trivy*.json checkov*.json results_json.json

# Commit cleanup
git add .gitignore
git commit -m "chore: remove scanner outputs and update gitignore"
```

---

## Summary

**Issue**: Scanner outputs in project root triggering GitLab false positives  
**Solution**: All outputs now go to `.security-scans/` (gitignored)  
**Status**: ✅ Fixed in pre-commit-validate.py  
**Prevention**: .gitignore updated with comprehensive exclusions

---

## Addendum: Scan Manifest (2026-04-21)

The `.gitignore` pattern for `.security-scans/` was updated to use a wildcard + negation approach:

```gitignore
# Security scanner outputs (track manifest, ignore reports)
.security-scans/*
!.security-scans/.scan-manifest.json
```

This change version-controls `.scan-manifest.json` — a file written by the steering compliance audit that records which files were targeted by which scanners. Git history preserves every prior version across checkpoints, enabling auditors to trace scan coverage per commit. Scanner report files (gitleaks-report.json, semgrep-report.json, etc.) remain ignored.
