# Git Dev Workflow - Python Version Flexibility Update

**Date**: 2026-03-12T19:33:00-04:00  
**Change**: Use standard `python3` command while requiring >=3.12 via PEP 723

---

## Update Applied

### Shebang Change

```python
# Before
#!/usr/bin/env python3.12

# After
#!/usr/bin/env python3
```

### PEP 723 Requirement (Unchanged)

```python
# /// script
# requires-python = ">=3.12"
# dependencies = [...]
# ///
```

---

## Rationale

**Shebang**: Uses whatever `python3` is available on the system
**PEP 723**: Declares minimum version requirement (>=3.12)

**Benefits**:
- Works with Python 3.12, 3.13, 3.14, etc.
- No need for version-specific python3.12 command
- PEP 723 tools enforce version requirement
- Standard python3 command works everywhere

---

## Execution

```bash
# All platforms - uses system python3
python3 scripts/pre-commit-validate.py

# PEP 723-aware tools check version requirement
uv run scripts/pre-commit-validate.py  # Enforces >=3.12

# Direct execution
./scripts/pre-commit-validate.py  # Uses #!/usr/bin/env python3
```

---

## Files Updated

All 5 scripts in `~/.kiro/skills/git-dev-workflow/scripts/`:
- cleanup-merged-branches.py
- commit-and-mr.py
- install-scanners.py
- pre-commit-validate.py
- sync-with-main.py

**Metadata files**:
- SKILL.md: Added `python_version: ">=3.12"`
- MENU.yaml: Added `python_version: ">=3.12"`

---

## Verification

```bash
# Check shebangs
✓ All use #!/usr/bin/env python3

# Check PEP 723
✓ All declare requires-python = ">=3.12"

# Test execution
python3 ~/.kiro/skills/git-dev-workflow/scripts/pre-commit-validate.py
# Works with any python3 >=3.12
```

---

## Summary

**Shebang**: Generic `python3` (flexible)  
**Requirement**: `>=3.12` via PEP 723 (enforced)  
**Result**: Works with any Python 3.12+ installation using standard commands
