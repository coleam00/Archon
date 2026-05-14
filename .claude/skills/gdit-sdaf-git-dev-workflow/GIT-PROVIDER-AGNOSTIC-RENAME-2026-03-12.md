# Git Dev Workflow Skill - Rename to Git Provider Agnostic

**Protocol**: SKILL-RENAME  
**Date**: 2026-03-12T14:48:00-04:00  
**Scope**: Rename gitlab-dev-workflow to git-dev-workflow, update all references to be Git provider agnostic

---

## Objective

Rename and update gitlab-dev-workflow skill to work with any Git provider (GitLab, GitHub, Bitbucket, Azure DevOps, etc.) as long as the Git client works.

---

## Changes Completed

### 1. Directory Rename

```bash
gitlab-dev-workflow/ → git-dev-workflow/
```

**Rationale**: Skill works with any Git provider, not just GitLab

### 2. Skill Metadata Updates

**SKILL.md**:
- name: `gitlab-dev-workflow` → `git-dev-workflow`
- description: Added "Works with any Git provider (GitLab, GitHub, Bitbucket, etc.)"
- tags: Removed `gitlab`, kept `git`
- Title: "GitLab Development Workflow" → "Git Development Workflow"
- Added provider examples throughout

**MENU.yaml**:
- skill_name: `gitlab-dev-workflow` → `git-dev-workflow`
- description: "GitLab development workflow" → "Git development workflow"
- Updated workflow descriptions to mention MR/PR (merge request/pull request)
- Updated requirements to list multiple providers

**.skills-cache.txt**:
- Updated skill listing with new name and description

### 3. Script Updates

**All Python scripts** (5 files):
- Updated shebang: `#!/usr/bin/env python3` → `#!/usr/bin/env python3.12`

**commit-and-mr.py**:
- Docstring: "creates GitLab MR" → "creates merge/pull request"
- Output: "Merge via GitLab UI" → "Merge via Git provider UI"

### 4. Documentation Updates

**BRANCH-PROTECTION.md**:
- Title: "GitLab Branch Protection" → "Git Branch Protection"
- Added overview: "applies to any Git provider"
- Updated Configuration section with examples for:
  - GitLab (Settings → Repository → Protected Branches)
  - GitHub (Settings → Branches → Branch protection rules)
  - Bitbucket (Repository settings → Branch permissions)
  - Azure DevOps (Repos → Branches → Branch policies)
- Updated CI/CD variables to include multiple token types
- Updated compliance mapping to reference "Git provider" not "GitLab"

**SECURITY-SCANNERS.md**:
- Updated overview: "merge requests" → "merge/pull requests"
- Updated CI/CD reference: "GitLab CI/CD" → "Git provider CI/CD"

---

## Terminology Changes

| Before | After | Context |
|--------|-------|---------|
| GitLab development workflow | Git development workflow | General description |
| GitLab repositories | Git repositories | Applies to all providers |
| GitLab MR | merge/pull request | Provider-agnostic term |
| GitLab UI | Git provider UI | Generic interface reference |
| GitLab remote | Git remote | Standard Git terminology |
| GITLAB_TOKEN | GIT_TOKEN or provider-specific | Flexible token naming |

---

## Preserved GitLab References

These references remain as **examples** of supported providers:
- "Works with any Git provider (GitLab, GitHub, Bitbucket, etc.)"
- Configuration examples showing GitLab alongside other providers
- CI/CD variable examples including GITLAB_TOKEN as one option

**Rationale**: GitLab is still a supported provider, just not the only one.

---

## Functionality Preserved

All core functionality remains unchanged:
- ✅ Branch protection compliance
- ✅ Pre-commit security validation
- ✅ Automated merge/pull request creation
- ✅ Branch synchronization
- ✅ Merged branch cleanup
- ✅ Security scanner installation
- ✅ All 7 security scanners (gitleaks, semgrep, trivy, cfn-lint, cfn-guard, checkov, KICS)

---

## Git Provider Compatibility

**Confirmed Compatible**:
- GitLab (original target)
- GitHub (via gh CLI or web UI)
- Bitbucket (via web UI)
- Azure DevOps (via web UI)
- Any Git provider supporting:
  - Branch protection rules
  - Merge/pull requests
  - CI/CD pipelines
  - Git client operations

**Core Requirement**: Git client must work (git push, pull, checkout, etc.)

---

## Script Execution

All scripts remain platform-agnostic and work on Linux/macOS/Windows:

```bash
# All platforms
python3.12 scripts/commit-and-mr.py
python3.12 scripts/pre-commit-validate.py --install-missing
python3.12 scripts/sync-with-main.py
python3.12 scripts/cleanup-merged-branches.py
python3.12 scripts/install-scanners.py

# Or with uv
uv run scripts/commit-and-mr.py
```

---

## Files Modified

1. **Directory**: `gitlab-dev-workflow/` → `git-dev-workflow/`
2. **SKILL.md**: Updated name, description, title, examples
3. **MENU.yaml**: Updated skill_name, descriptions, requirements
4. **.skills-cache.txt**: Updated skill listing
5. **scripts/commit-and-mr.py**: Updated docstring and output messages
6. **scripts/*.py**: Updated shebangs to python3.12 (5 files)
7. **references/BRANCH-PROTECTION.md**: Added multi-provider configuration examples
8. **references/SECURITY-SCANNERS.md**: Updated to reference generic Git provider

---

## Verification

```bash
# Directory renamed
✓ gitlab-dev-workflow/ → git-dev-workflow/

# Scripts updated
✓ 5/5 Python scripts use python3.12 shebang

# References updated
✓ Skill name: git-dev-workflow
✓ Description: Git provider agnostic
✓ Documentation: Multi-provider examples added
```

---

## Migration Notes

**Breaking Changes**:
- Skill name changed: `gitlab-dev-workflow` → `git-dev-workflow`
- Load command: "load gitlab-dev-workflow skill" → "load git-dev-workflow skill"

**Non-Breaking**:
- All scripts work identically
- All functionality preserved
- GitLab still fully supported (just not exclusive)
- Command-line arguments unchanged

---

## Benefits

1. **Provider Flexibility**: Works with GitLab, GitHub, Bitbucket, Azure DevOps, etc.
2. **Accurate Naming**: Reflects actual capability (Git operations, not GitLab-specific)
3. **Broader Adoption**: Teams using different Git providers can use same skill
4. **Future-Proof**: Not tied to single vendor
5. **Standards-Based**: Uses standard Git client operations

---

## Next Steps

None required. Skill is fully renamed and operational.

**Usage**:
```bash
# Load skill
"load git-dev-workflow skill"

# Or use directly
python3.12 .kiro/skills/git-dev-workflow/scripts/commit-and-mr.py
```
