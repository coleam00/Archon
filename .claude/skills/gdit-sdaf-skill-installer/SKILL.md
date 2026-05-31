---
name: skill-installer
description: Install skills from GitHub, GitLab, or local paths into ~/.kiro/skills. Use when a user asks to list installable skills, install a skill from a registry, or install from a local directory.
metadata:
  short-description: Install skills from GitHub, GitLab, or local paths
---

# Skill Installer

Install skills from multiple sources into `~/.kiro/skills/`.

## Supported Sources

| Source | Script | Example |
|--------|--------|---------|
| GitHub repo | `install-skill-from-github.py` | `--repo org/repo --path skills/my-skill` |
| GitHub URL | `install-skill-from-github.py` | `--url https://github.com/org/repo/tree/main/skills/my-skill` |
| Local path | `install-skill-from-local.py` | `./path/to/my-skill` |

## Usage

**List available skills from a GitHub registry:**
```
python3 ~/.kiro/skills/skill-installer/scripts/list-skills.py --repo org/skills-catalog
```

**Install from GitHub (repo + path):**
```
python3 ~/.kiro/skills/skill-installer/scripts/install-skill-from-github.py --repo org/repo --path skills/my-skill
```

**Install from GitHub URL:**
```
python3 ~/.kiro/skills/skill-installer/scripts/install-skill-from-github.py --url https://github.com/org/repo/tree/main/skills/my-skill
```

**Install from local directory:**
```
python3 ~/.kiro/skills/skill-installer/scripts/install-skill-from-local.py ./path/to/my-skill
```

After installing, restart the agent to pick up new skills.

## Communication

When listing skills, output:
```
Skills from registry:
1. skill-1
2. skill-2 (already installed)
Which ones would you like installed?
```

After installing: "Installed [name]. Restart the agent to pick up new skills."

## Prerequisites

This skill requires GDIT-SDAF to be set up. Run once per machine:

```
archon workflow run gdit-sdaf-setup
```

After setup, scripts are available at `~/.kiro/skills/skill-installer/scripts/`.
