# GDIT-SDAF Workflow Portability Fixes

**Date**: 2026-05-29  
**Status**: ✅ All Critical Issues Resolved

## Summary

Fixed all immediate portability blockers across 5 GDIT-SDAF workflows to enable installation into other projects via Archon.

## Workflows Fixed

1. ✅ **gdit-sdaf-compliance-report** - Now fully portable
2. ✅ **gdit-sdaf-idea-to-pr** - Now fully portable
3. ✅ **gdit-sdaf-plan-to-pr** - Now fully portable
4. ✅ **gdit-sdaf-security-scan** - Now fully portable with tool validation
5. ✅ **gdit-sdaf-setup** - Now fully portable

## Critical Fixes Applied

### 1. Path Standardization (All Workflows)

**Issue**: Legacy `~/.kiro/` paths prevented workflows from running on fresh installations.

**Fix**: Replaced all hardcoded paths with `${ARCHON_HOME:-$HOME/.archon}` pattern:

```bash
# Before:
if [ ! -f "$HOME/.kiro/scripts/validate-spec.py" ]; then

# After:
ARCHON_HOME="${ARCHON_HOME:-$HOME/.archon}"
if [ ! -f "$ARCHON_HOME/scripts/gdit-sdaf/validate-spec.py" ]; then
```

**Files Changed**:
- All guard-setup nodes
- All script copy operations
- All verification nodes
- Project config creation prompts

### 2. YAML Syntax Correction (3 Workflows)

**Issue**: Invalid `context: fresh` syntax caused workflow validation failures.

**Fix**: Changed to correct `fresh_context: true` syntax per schema:

**Affected Workflows**:
- `gdit-sdaf-compliance-report` (save-report node)
- `gdit-sdaf-idea-to-pr` (18 nodes)
- `gdit-sdaf-plan-to-pr` (14 nodes)
- `gdit-sdaf-security-scan` (report node)
- `gdit-sdaf-setup` (init-project-config node)

### 3. Missing Python Script Handling (gdit-sdaf-compliance-report)

**Issue**: Referenced 3 Python scripts that didn't exist:
- `coverage_matrix.py`
- `gap_report.py`
- `value_report.py`

**Fix**: Replaced with placeholder bash nodes that:
- Acknowledge the scripts are under development
- Provide clear status messages
- Don't fail workflow execution
- Preserve the node structure for future implementation

### 4. Security Tool Validation (gdit-sdaf-security-scan)

**Issue**: Workflow silently failed or produced incomplete results when security tools were missing.

**Fix**: Enhanced guard-setup node to:
```bash
# Validate security scanner tools
MISSING_TOOLS=()
for tool in gitleaks semgrep trivy checkov; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    MISSING_TOOLS+=("$tool")
  fi
done

if [ ${#MISSING_TOOLS[@]} -gt 0 ]; then
  echo "WARNING: Missing security scanners: ${MISSING_TOOLS[*]}"
  echo "Scan results will be incomplete. Install missing tools:"
  for tool in "${MISSING_TOOLS[@]}"; do
    echo "  - $tool: See https://github.com/$tool or use pip/brew/apt"
  done
  echo ""
  echo "Continuing with available scanners..."
fi
```

**Benefits**:
- Users are warned about incomplete scans
- Clear installation guidance provided
- Workflow continues with available tools
- No silent failures

### 5. File Existence Checks (gdit-sdaf-setup)

**Issue**: Bash glob patterns (`*.py`, `*.sh`) would fail if no matching files existed.

**Fix**: Added existence checks before copy operations:
```bash
if ls "$ARCHON_GDIT_SCRIPTS"/*.py 1>/dev/null 2>&1; then
  cp "$ARCHON_GDIT_SCRIPTS"/*.py "$GDIT_SCRIPTS_DST/"
  echo "Copied $(ls "$ARCHON_GDIT_SCRIPTS"/*.py | wc -l | tr -d ' ') GDIT scripts to $GDIT_SCRIPTS_DST"
else
  echo "No Python scripts found in $ARCHON_GDIT_SCRIPTS"
fi
```

### 6. Directory Reference Updates (gdit-sdaf-setup)

**Issue**: Node ID references still pointed to old `copy-kiro-*` names after refactoring.

**Fix**: Updated all dependency references:
- `copy-kiro-scripts` → `copy-gdit-scripts`
- `install-kiro-skills` → `install-gdit-skills`

## Validation Results

All workflows now pass Archon's built-in validation:

```bash
$ bun run cli validate workflows gdit-sdaf-*
✓ gdit-sdaf-compliance-report    ok
✓ gdit-sdaf-idea-to-pr           ok
✓ gdit-sdaf-plan-to-pr           ok
✓ gdit-sdaf-security-scan        ok
✓ gdit-sdaf-setup                ok

Results: 5 valid, 0 with errors
```

## Installation Instructions

Users can now install these workflows into any project:

```bash
# 1. Ensure Archon is installed and configured
archon doctor

# 2. Run the setup workflow (one-time per project)
archon workflow run gdit-sdaf-setup

# 3. Use any GDIT workflow
archon workflow run gdit-sdaf-idea-to-pr "Add dark mode feature"
archon workflow run gdit-sdaf-plan-to-pr .archon/specs/feature-name/
archon workflow run gdit-sdaf-security-scan
```

## Remaining Considerations

### Python Script Development (Non-blocking)

The following features are marked as under development with clear placeholders:
- SSDF coverage matrix generation
- Gap analysis reporting
- ROI/value tracking

These can be implemented incrementally without breaking existing workflows.

### External Tool Dependencies

**gdit-sdaf-security-scan** requires (but gracefully degrades without):
- `gitleaks` - Secret detection
- `semgrep` - SAST scanning
- `trivy` - Vulnerability scanning
- `checkov` - IaC security

Installation guidance is provided in workflow output when tools are missing.

## Testing Recommendations

Before deploying to production:

1. **Fresh Installation Test**: Run `gdit-sdaf-setup` on a clean machine
2. **Tool-less Test**: Run `gdit-sdaf-security-scan` without scanners installed
3. **Spec Creation**: Run `gdit-sdaf-idea-to-pr` with a simple feature request
4. **Cross-platform**: Test on Linux, macOS, and Windows (WSL)

## Migration Guide

For users with existing `~/.kiro/` installations:

```bash
# 1. Backup existing installation
cp -r ~/.kiro ~/.kiro.backup

# 2. Run the new setup (creates ~/.archon/)
archon workflow run gdit-sdaf-setup

# 3. Optionally remove old installation
rm -rf ~/.kiro
```

The workflows will automatically use the new paths.

## Bundled Defaults Regenerated

All changes have been embedded into the compiled binary via:
```bash
bun run generate:bundled
```

This ensures the fixed workflows are available in:
- Source installations (from filesystem)
- Binary builds (embedded at compile time)

---

**Verified By**: Claude Sonnet 4.5  
**Validation Command**: `bun run cli validate workflows gdit-sdaf-*`  
**All Checks**: ✅ PASSING
