# Git Provider Agnostic Update - Quick Reference

## What Changed

### Skill Name
```
gitlab-dev-workflow → git-dev-workflow
```

### Directory Structure
```
.kiro/skills/gitlab-dev-workflow/ → .kiro/skills/git-dev-workflow/
```

### Load Command
```bash
# Before
"load gitlab-dev-workflow skill"

# After
"load git-dev-workflow skill"
```

## Supported Git Providers

The skill now explicitly supports:
- **GitLab** - Original target, fully supported
- **GitHub** - Pull requests via gh CLI or web UI
- **Bitbucket** - Pull requests via web UI
- **Azure DevOps** - Pull requests via web UI
- **Any Git provider** - As long as Git client works

## Key Features (Unchanged)

- ✅ Branch protection compliance
- ✅ Pre-commit security validation (7 scanners)
- ✅ Automated merge/pull request creation
- ✅ Branch synchronization with main
- ✅ Merged branch cleanup
- ✅ Cross-platform (Linux/macOS/Windows)
- ✅ Python 3.12+ with PEP 723

## Usage Examples

### Create Merge/Pull Request
```bash
# Interactive (works with any provider)
python3.12 scripts/commit-and-mr.py

# Non-interactive
python3.12 scripts/commit-and-mr.py \
  --message "feat: add feature" \
  --title "Add feature" \
  --description "Implements feature X"
```

### Pre-Commit Validation
```bash
python3.12 scripts/pre-commit-validate.py --install-missing
```

### Sync with Main
```bash
python3.12 scripts/sync-with-main.py rebase
```

### Cleanup Merged Branches
```bash
python3.12 scripts/cleanup-merged-branches.py --no-dry-run
```

## Provider-Specific MR/PR Creation

**GitLab** (via Git push options):
```bash
git push -o merge_request.create \
  -o merge_request.target=main \
  -o merge_request.title="Title"
```

**GitHub** (via gh CLI):
```bash
gh pr create --base main --head dev-tom --title "Title"
```

**Bitbucket/Azure DevOps**:
- Push branch, create PR via web UI

**Universal** (skill script):
```bash
python3.12 scripts/commit-and-mr.py  # Detects provider
```

## Migration for Existing Users

**No action required** - skill works identically, just with broader provider support.

**Optional**: Update any documentation or scripts that reference the old skill name.

## Verification

```
✓ Directory renamed
✓ 5/5 scripts updated to Python 3.12
✓ 5/5 scripts have PEP 723 metadata
✓ 0 shell scripts (platform-agnostic)
✓ 0 PowerShell scripts (platform-agnostic)
✓ Skill metadata updated
✓ Documentation updated with multi-provider examples
```
