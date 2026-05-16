# Git Branch Protection Best Practices

## Overview

Branch protection prevents unauthorized or accidental changes to critical branches by enforcing workflow rules and automated checks. This guide applies to any Git provider (GitLab, GitHub, Bitbucket, Azure DevOps, etc.).

## Protection Rules for Main Branch

### Required Settings

**Push Access:**
- No direct pushes allowed
- Forces use of merge/pull requests

**Merge Access:**
- Requires approval from maintainers
- Allows merging via MR/PR after approval

**Force Push:**
- Disabled
- Prevents history rewriting

**Required Checks:**
- CI/CD pipeline must pass
- All discussions resolved
- Approvals met (if configured)

Provider-specific implementation varies (see Configuration section below).

## Developer Workflow

### Branch Naming Convention

```
dev-{username}
```

Examples:
- `dev-tom`
- `dev-sarah`
- `dev-john`

### Standard Flow

1. **Create/Switch to Dev Branch**
   ```bash
   git checkout -b dev-tom
   ```

2. **Make Changes**
   ```bash
   # Edit files
   git add -A
   ```

3. **Validate Before Commit**
   ```bash
   python3 scripts/pre-commit-validate.py --install-missing
   ```

4. **Commit and Push**
   ```bash
   git commit -m "feat: add new feature"
   git push -u origin dev-tom
   ```

5. **Create Merge/Pull Request**
   ```bash
   # GitLab
   git push -o merge_request.create \
     -o merge_request.target=main \
     -o merge_request.title="Add new feature"
   
   # GitHub (via gh CLI)
   gh pr create --base main --head dev-tom --title "Add new feature"
   
   # Or use the skill script (provider-agnostic)
   python3 scripts/commit-and-mr.py
   ```

6. **Wait for CI/CD**
   - Security scans run automatically
   - Pipeline must pass before merge

7. **Merge to Main**
   - Via Git provider UI after approval
   - Or auto-merge if configured

## Security Gates

### Pre-Commit (Local)

Runs before commit:
- gitleaks (secrets)
- semgrep (SAST)
- trivy (vulnerabilities)
- cfn-lint (CloudFormation)
- cfn-guard (policies)
- checkov (IaC)
- KICS (IaC)

### CI/CD Pipeline (Remote)

Runs on merge request:
- All pre-commit checks
- Additional integration tests
- Compliance validation
- Artifact scanning

## Compliance Mapping

**NIST 800-218 PO.5** - Implement and Maintain Secure Environments
- Branch protection enforces secure development
- Automated security gates prevent vulnerable code
- Audit trail of all changes

**NIST 800-171 3.4.8** - Protect audit information
- Git history immutable (no force push)
- All changes tracked via MR
- CI/CD logs preserved

**FedRAMP AC-2** - Account Management
- Developer access controlled via Git provider
- Branch permissions enforced
- MR/PR approval workflow

## Troubleshooting

### "Protected branch push failed"

**Cause:** Trying to push directly to main

**Solution:** Push to dev branch instead
```bash
git checkout -b dev-tom
git push -u origin dev-tom
```

### "Pipeline failed - secrets detected"

**Cause:** Gitleaks found secrets in commit

**Solution:** Remove secrets and recommit
```bash
# Remove secret from file
git add -A
git commit --amend
git push --force-with-lease
```

### "Merge conflicts with main"

**Cause:** Main branch updated since branch created

**Solution:** Sync with main
```bash
python3 scripts/sync-with-main.py
```

## Configuration

### Git Provider Setup

**GitLab:**
- Settings → Repository → Protected Branches
- Branch: `main`, Push: No one, Merge: Developers+

**GitHub:**
- Settings → Branches → Branch protection rules
- Branch: `main`, Require pull request, Require status checks

**Bitbucket:**
- Repository settings → Branch permissions
- Branch: `main`, Prevent changes without PR

**Azure DevOps:**
- Repos → Branches → Branch policies
- Branch: `main`, Require PR, Require build validation

### CI/CD Variables

Required in your Git provider's CI/CD settings:
- `GIT_TOKEN` or `GITLAB_TOKEN` or `GITHUB_TOKEN` - For API access
- `AWS_REGION` - For AWS scans (if applicable)
- `SECURITY_SCAN_ENABLED` - Set to `true`
