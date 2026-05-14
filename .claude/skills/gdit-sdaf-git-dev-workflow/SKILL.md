---
name: git-dev-workflow
description: Standardized Git development workflow with branch protection compliance, automated security validation, and merge/pull request management. Works with any Git provider (GitLab, GitHub, Bitbucket, etc.). Use when committing code, creating merge/pull requests, syncing branches, or validating changes before push.
license: MIT
compatibility: Cross-platform (Linux/macOS/Windows). Requires Git, Python 3.12+, and uv or python3. Security scanners auto-install if missing.
metadata:
  author: GDIT Platform Team
  version: "1.0.1"
  category: development
  tags: git, workflow, branch-protection, merge-request, pull-request, security, validation
  python_version: ">=3.12"
allowed-tools: Bash(git:*) Bash(python3:*) Bash(uv:*) Read Write
---

# Git Development Workflow

Standardized development workflow for Git repositories with main branch protection. Enforces security validation before commits, manages developer branches, and automates merge/pull request creation with compliance checks. Works with any Git provider (GitLab, GitHub, Bitbucket, Azure DevOps, etc.).

## When to Use This Skill

Use this skill when you need to:
- Commit changes to your developer branch
- Create merge requests (GitLab) or pull requests (GitHub/Bitbucket)
- Validate code changes before committing (security scans)
- Sync your dev branch with latest main
- Check merge/pull request status and approvals
- Clean up merged branches
- Ensure branch protection compliance

Works with any Git provider that supports branch protection and merge/pull requests.

### Branch Protection Model

**Main Branch:**
- Protected - no direct pushes
- Requires merge requests
- CI/CD pipeline must pass
- Security scans must pass

**Developer Branches:**
- Pattern: `dev-{username}`
- Full write access
- Merge to main via MR only

## Core Workflows

### 1. Commit and Create Merge/Pull Request

Standard workflow for pushing changes. ALWAYS use the script — never run raw `git add`/`git commit`/`git push` commands directly. The script uses `git add -A` to correctly capture all changes including deletions and renames.

```bash
# Interactive mode (recommended)
uv run scripts/commit-and-mr.py

# Or with python3
python3 ~/.kiro/skills/git-dev-workflow/scripts/commit-and-mr.py

# Non-interactive mode
uv run scripts/commit-and-mr.py \
  --message "feat: add new feature" \
  --title "Add new feature" \
  --description "Implements feature X"
```

This will:
1. Run pre-commit security validation
2. Create/switch to dev-{username} branch
3. Stage and commit changes
4. Push to remote
5. Create merge/pull request to main (provider-specific)

### 2. Pre-Commit Validation

Run all security scanners before committing:

```bash
# Recommended (with uv)
uv run scripts/pre-commit-validate.py --install-missing

# Or with python3
python3 ~/.kiro/skills/git-dev-workflow/scripts/pre-commit-validate.py --install-missing
```

**Automatic .gitignore management**: The script automatically:
1. Checks if `.security-scans/` is in project's `.gitignore`
2. Creates `.gitignore` if it doesn't exist
3. Adds `.security-scans/*` to `.gitignore` if missing
4. Adds `!.security-scans/.scan-manifest.json` negation so the scan manifest is version-controlled
5. Outputs all scan results to `.security-scans/` directory

This ensures scan report outputs are never accidentally committed, while the `.scan-manifest.json` (which records which files were scanned by which tools) is tracked in git history for audit traceability.

Runs these scanners with comprehensive rulesets:
- **gitleaks** - Secret detection
- **semgrep** - SAST (security-audit, OWASP Top 10, CWE Top 25, secrets, code-quality)
- **trivy** - Vulnerability scanning (CRITICAL/HIGH/MEDIUM)
- **cfn-lint** - CloudFormation linting
- **cfn-guard** - CloudFormation policy validation
- **checkov** - IaC security scanning (CloudFormation, Terraform, K8s, Docker)
- **KICS** - Infrastructure as Code scanning (optional)

Blocks commit if:
- Secrets detected
- HIGH/CRITICAL vulnerabilities found
- ERROR-level SAST findings
- CloudFormation validation failures

### 3. Daily Sync (Start of Day)

Recommended first action every day — pulls remote dev branch updates and syncs latest main:

```bash
uv run scripts/sync-with-main.py [rebase|merge]
# Or: python3 ~/.kiro/skills/git-dev-workflow/scripts/sync-with-main.py
```

This will:
1. Fetch all remote branches (not just main)
2. Pull remote updates to your dev branch (catches cross-machine or teammate changes)
3. Rebase or merge latest main into dev branch
4. Check for conflicts
5. Push updated dev branch

### 4. Cleanup Merged Branches

Remove local and remote branches that have been merged:

```bash
uv run scripts/cleanup-merged-branches.py [--no-dry-run] [--delete-remote]
# Or: python3 ~/.kiro/skills/git-dev-workflow/scripts/cleanup-merged-branches.py
```

This will:
1. List merged branches
2. Confirm deletion
3. Delete local branches
4. Delete remote branches (optional)

### 5. Install Security Scanners

Install all required scanners:

```bash
uv run scripts/install-scanners.py [scanner-name ...]
# Or: python3 ~/.kiro/skills/git-dev-workflow/scripts/install-scanners.py
```

Auto-installs missing tools needed for validation.

### 6. Manage Credentials

Store, test, and manage git authentication credentials:

```bash
# Guided setup (detects remote, prompts for token, validates)
python3 ~/.kiro/skills/git-dev-workflow/scripts/manage-credentials.py setup

# CRUD operations
python3 ~/.kiro/skills/git-dev-workflow/scripts/manage-credentials.py list
python3 ~/.kiro/skills/git-dev-workflow/scripts/manage-credentials.py set https://gitlab.example.com --username deploy-bot --token glpat-...
python3 ~/.kiro/skills/git-dev-workflow/scripts/manage-credentials.py test https://gitlab.example.com
python3 ~/.kiro/skills/git-dev-workflow/scripts/manage-credentials.py delete https://gitlab.example.com

# Migrate from local file to AWS Secrets Manager
python3 ~/.kiro/skills/git-dev-workflow/scripts/manage-credentials.py migrate --from local --to secrets-manager
```

Supports local file (`~/.gdit-sdaf-secrets/git-credentials.json`) and AWS Secrets Manager backends. Configure in `.kiro/config/project.yaml`:

```yaml
git-remote:
  credentials:
    backend: secrets-manager    # local | secrets-manager
    secret-name: gdit-sdaf/git-credentials
    region: us-east-1
    profile: SPP1
```

Tokens are never embedded in URLs or exposed in output. SSH remotes use the OS SSH agent. CodeCommit uses IAM via the `codecommit::` protocol.

## Interactive Menu

See `MENU.yaml` for structured workflows with guided parameters.

## Security Validation

All commits are validated against:
- NIST 800-218 PO.5 (Secure Environments)
- NIST 800-171 3.4.8 (Protect audit information)
- FedRAMP AC-2 (Account Management)

Validation includes:
- Secret scanning (gitleaks)
- Static analysis (semgrep with OWASP, CWE, security-audit, code-quality)
- Dependency vulnerabilities (trivy)
- IaC security (checkov, KICS optional, cfn-guard)
- CloudFormation validation (cfn-lint)

## Configuration Files

All scanner configurations are in `assets/`:
- `.gitleaks.toml` - Secret detection patterns and allowlist
- `.semgrep.yml` - Comprehensive ruleset documentation
- `trivy.yaml` - Vulnerability scanning settings
- `.cfnlintrc` - CloudFormation linting rules
- `cfn-guard-rules.guard` - CloudFormation policy rules
- `.checkov.yml` - IaC security framework settings
- `kics.config` - IaC scanning configuration (optional)

## References

See `references/` for:
- Branch protection best practices
- Security scanner configuration
- Troubleshooting guide

## Prerequisites

This skill requires GDIT-SDAF to be set up. Run once per machine:

```
archon workflow run gdit-sdaf-setup
```

After setup, scripts are available at `~/.kiro/skills/git-dev-workflow/scripts/`.
