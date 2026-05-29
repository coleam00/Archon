# GDIT-SDAF Onboarding Guide

Complete setup guide for using GDIT-SDAF workflows with Archon.

## Quick Start

From your project directory, run:

```bash
archon workflow run gdit-sdaf-onboard
```

This single command handles:

- ✓ Forge provider detection (GitHub vs GitLab)
- ✓ CLI authentication verification
- ✓ Python and security scanner setup
- ✓ GDIT scripts and skills installation
- ✓ Configuration file creation
- ✓ Verification report

**Time**: ~5-10 minutes for first-time setup, ~1 minute for verification re-runs.

## Prerequisites

### Required

1. **Git repository with remote**

   ```bash
   git remote -v
   # Should show origin with github.com or gitlab.com URL
   ```

2. **Python 3.12+**

   ```bash
   python3 --version
   # Should show Python 3.12.0 or later
   ```

3. **Archon CLI**
   ```bash
   archon version
   # Should show archon CLI version
   ```

### Recommended

**GitHub Users**:

```bash
# Install gh CLI
brew install gh  # macOS
# or: https://cli.github.com

# Authenticate
gh auth login
```

**GitLab Users**:

```bash
# Install glab CLI
brew install glab  # macOS
# or: https://gitlab.com/gitlab-org/cli

# Authenticate
glab auth login
```

## What Gets Installed

### 1. Forge Configuration

Auto-detects your git forge from the remote URL:

- URL contains `gitlab` → GitLab
- Otherwise → GitHub

Creates/updates `.archon/config.yaml`:

```yaml
forge:
  provider: github # or gitlab

worktree:
  baseBranch: dev

docs:
  path: docs/
```

This enables all GDIT workflows to use the correct forge CLI automatically via `$FORGE_PROVIDER` and `$FORGE_CLI` variables.

### 2. Security Scanners

Python-based security tools (installed via pip):

| Scanner  | Purpose                         |
| -------- | ------------------------------- |
| gitleaks | Secret detection                |
| semgrep  | SAST analysis                   |
| trivy    | Container/IaC scanning          |
| checkov  | Infrastructure as Code security |
| ruff     | Python linting                  |
| pyright  | Python type checking            |

### 3. GDIT Scripts

Core Python scripts copied to `~/.archon/scripts/gdit-sdaf/`:

- `validate-spec.py` - Specification validation
- `audit-steering-compliance.py` - Compliance auditing
- `sysml_validator.py` - SysML validation
- `knowledge-init.py` - Knowledge base initialization
- And 15+ more...

**Source**: `.archon/scripts/gdit-sdaf/` in the Archon repository

### 4. GDIT Skills

Workflow-specific skills installed to `~/.archon/skills/`:

| Skill                    | Purpose                      |
| ------------------------ | ---------------------------- |
| aws-security-remediation | AWS Security Hub remediation |
| gitlab-security-scanning | GitLab security integration  |
| ssdf-development         | SSDF-compliant development   |
| git-dev-workflow         | Git workflow automation      |
| skill-creator            | Create new skills            |
| And more...              |                              |

**Note**: Skills are installed WITHOUT the `gdit-sdaf-` prefix for cleaner skill names.

**Source**: `.claude/skills/gdit-sdaf-*/` in the Archon repository

### 5. Project Configuration

Creates `.archon/config/project.yaml` with GDIT-specific settings:

```yaml
workflow:
  spec-source: gdit-sdaf
  value-tracking: true
  commit-types: [fix, feat, docs, refactor, test, chore]
  audit:
    git-checkpoint: true
    spec-validation: true
    security-scans: true

security:
  enabled-scanners: [gitleaks, semgrep, trivy, checkov, ruff]
  semgrep:
    severity-levels: [ERROR, WARNING]
  trivy:
    severity-levels: [HIGH, CRITICAL]

sysml:
  enabled: true
  scope: both

well-architected:
  enabled: true

finops:
  enabled: true
```

## Installation Steps

### 1. Install Prerequisites

**Install Archon** (if not already installed):

```bash
npm install -g archon
# or for development:
cd Archon && bun install
```

**Verify Python**:

```bash
python3 --version
# If < 3.12, install from https://python.org
```

### 2. Clone and Setup

```bash
# Clone the Archon repository
git clone https://github.com/coleam00/Archon.git
cd Archon

# Run onboarding
archon workflow run gdit-sdaf-onboard
```

The workflow will:

1. Detect your forge provider automatically
2. Check CLI authentication status
3. Install security scanners
4. Copy GDIT scripts and skills
5. Create configuration files
6. Generate a verification report

### 3. Authenticate Forge CLI (if needed)

If the workflow reports missing authentication:

**GitHub**:

```bash
gh auth login
# Follow interactive prompts
```

**GitLab**:

```bash
glab auth login
# Follow interactive prompts
```

### 4. Verify Setup

```bash
archon doctor
```

All checks should pass except platform-specific ones (Slack, Telegram) if not configured.

## Using GDIT Workflows

### List Available Workflows

```bash
archon workflow list | grep gdit-sdaf
```

Common workflows:

- `gdit-sdaf-onboard` - This onboarding workflow
- `gdit-sdaf-setup` - Core GDIT setup (called by onboard)
- `gdit-sdaf-security-scan` - Run security scanners
- `gdit-sdaf-compliance-report` - Generate compliance reports
- `gdit-sdaf-idea-to-pr` - Full dev lifecycle from idea to PR
- `gdit-sdaf-plan-to-pr` - Implement from existing plan/spec

### Run a Workflow

**Interactive** (prompts for input):

```bash
archon workflow run gdit-sdaf-security-scan
```

**With arguments**:

```bash
archon workflow run gdit-sdaf-idea-to-pr "Add user authentication feature"
```

**Check status**:

```bash
archon workflow status
```

**Resume failed workflow**:

```bash
archon workflow resume <run-id>
```

### Forge-Aware Workflow Usage

After onboarding, all workflows automatically use the correct forge CLI:

```yaml
# Example workflow node that works with both GitHub and GitLab
- id: create-issue
  bash: |
    $FORGE_CLI issue create \
      --title "Security findings" \
      --body "$(cat scan-report.md)"
```

Variables available:

- `$FORGE_PROVIDER` - `github` or `gitlab`
- `$FORGE_CLI` - `gh` or `glab`

## Configuration Files

### `.archon/config.yaml` (Project-level)

Main Archon configuration for the project:

```yaml
forge:
  provider: github # Auto-detected or manually set

worktree:
  baseBranch: dev

docs:
  path: docs/

# Optional: Assistant overrides
assistants:
  claude:
    model: sonnet
```

### `.archon/config/project.yaml` (GDIT-specific)

GDIT workflow behavior configuration:

```yaml
workflow:
  spec-source: gdit-sdaf
  testing: disable # or enable
  frameworks: [spring-boot, react] # Detected frameworks

security:
  enabled-scanners: [gitleaks, semgrep, trivy, checkov]

sysml:
  enabled: true

well-architected:
  enabled: true
```

Edit these files to customize behavior.

## Re-Running Setup

The onboarding workflow is **idempotent** - safe to re-run:

```bash
archon workflow run gdit-sdaf-onboard
```

Behavior:

- ✓ Existing files are preserved
- ✓ Missing components are installed
- ✓ Configurations are updated only if changed
- ✓ No duplicate installations

## Troubleshooting

### "No git remote 'origin' found"

Add a remote to your repository:

```bash
git remote add origin https://github.com/user/repo.git
# or
git remote add origin https://gitlab.com/user/repo.git
```

### "Python 3.12+ required"

Check your Python version:

```bash
python3 --version
```

Install Python 3.12+:

- **macOS**: `brew install python@3.12`
- **Ubuntu**: `sudo apt install python3.12`
- **Windows**: Download from [python.org](https://python.org)

### "archon CLI not found"

Install Archon:

```bash
npm install -g archon
```

Or for development:

```bash
cd Archon
bun install
bun run cli --help
```

### "gh/glab not authenticated"

Authenticate the forge CLI:

```bash
gh auth login    # GitHub
glab auth login  # GitLab
```

### "Security scanner not found"

Install missing scanners:

```bash
pip install gitleaks semgrep trivy checkov ruff pyright
```

Or install individually:

```bash
pip install gitleaks
pip install semgrep
# etc.
```

### "Doctor checks failed"

Run the full setup wizard:

```bash
archon setup
```

Follow prompts to configure credentials and tokens.

## Advanced Usage

### Custom Forge Provider

Override auto-detection by editing `.archon/config.yaml`:

```yaml
forge:
  provider: gitlab # Force GitLab even if remote is GitHub
```

### Skip CLI Checks

The onboarding workflow will warn about missing CLI but continue. Workflows that need the CLI will fail later with clear error messages.

### Development Mode

When running Archon from source:

```bash
cd Archon
bun run cli workflow run gdit-sdaf-onboard
```

### Different Project Branches

Configure the base branch in `.archon/config.yaml`:

```yaml
worktree:
  baseBranch: main # or master, develop, etc.
```

## Next Steps

1. **Explore workflows**:

   ```bash
   archon workflow list | grep gdit-sdaf
   ```

2. **Run a security scan**:

   ```bash
   archon workflow run gdit-sdaf-security-scan
   ```

3. **Full development lifecycle**:

   ```bash
   archon workflow run gdit-sdaf-idea-to-pr "Add API rate limiting"
   ```

4. **Read workflow documentation**:
   - Check headers in `.archon/workflows/defaults/gdit-sdaf-*.yaml`
   - Each workflow includes usage triggers and descriptions

5. **Create custom workflows**:
   - Add `.yaml` files to `.archon/workflows/`
   - Use GDIT scripts and skills in your own workflows

## Support

- **Documentation**: [Archon Docs](https://archon.dev)
- **Issues**: [GitHub Issues](https://github.com/coleam00/Archon/issues)
- **Doctor command**: `archon doctor` (diagnoses setup issues)
- **Workflow validation**: `archon workflow validate <workflow-name>`

## Workflow Details

### Execution Flow

```
check-archon-cli
    ↓
detect-forge (parallel with check-python)
    ↓                    ↓
write-forge-config    check-python
    ↓                    ↓
check-forge-cli      install-scanners
    ↓                    ↓
              copy-gdit-scripts
                    ↓
              install-gdit-skills
                    ↓
              init-project-config
                    ↓
              verify-setup
```

### Time Estimates

- **First run**: 5-10 minutes (includes scanner installation)
- **Re-run**: 1-2 minutes (verification only)
- **Python installation** (if needed): +5 minutes
- **CLI installation** (if needed): +2 minutes

### Disk Space

- **GDIT Scripts**: ~2 MB
- **GDIT Skills**: ~5 MB
- **Security Scanners**: ~100-500 MB (varies by tool)

Total: ~500 MB for complete installation

## License

GDIT-SDAF workflows and scripts follow the Archon project license.
