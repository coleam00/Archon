#!/usr/bin/env python3
"""Regenerate platform adapter files from structural templates.

Populates {{SLOT_NAME}} placeholders with content derived from the live
framework state (steering files, scripts, skills). Validates structural
integrity before writing.

Usage:
    python3 ~/.kiro/scripts/update-harness.py --platform claude-code
    python3 ~/.kiro/scripts/update-harness.py --platform opencode
    python3 ~/.kiro/scripts/update-harness.py --all
"""

import argparse
import hashlib
import re
import sys
from pathlib import Path

KIRO_HOME = Path.home() / ".kiro"
TEMPLATES_DIR = KIRO_HOME / "harness-templates"

PLATFORMS = {
    "claude-code": {
        "template": "claude-code/CLAUDE.md.tmpl",
        "output": Path.home() / ".claude" / "CLAUDE.md",
        "expected_sections": [
            "## Identity",
            "## Steering Files Loaded via Rules",
            "## Mandatory First Action",
            "## Protocol Header Format",
            "## Validation Scripts",
            "## Git Checkpoint Rules",
            "## Skills Management",
            "## Session Coordination",
            "## Knowledge Discovery",
            "## Prohibited Behaviors",
        ],
    },
    "opencode": {
        "template": "opencode/AGENTS.md.tmpl",
        "output": Path.home() / ".config" / "opencode" / "AGENTS.md",
        "expected_sections": [],  # defined when opencode template exists
    },
}

# Files to exclude from rules/ symlinks (on-demand or per-agent)
STEERING_EXCLUDE = [
    "spec-templates.md",
    "lang-",
    "-reference.md",
    "compliance-pattern-catalog.md",
]


def scan_steering_files() -> list[str]:
    """Scan ~/.kiro/steering/ for files that should be in rules/."""
    steering_dir = KIRO_HOME / "steering"
    if not steering_dir.is_dir():
        return []

    files = []
    for f in sorted(steering_dir.glob("*.md")):
        if any(excl in f.name for excl in STEERING_EXCLUDE):
            continue
        files.append(f.name)
    return files


def scan_scripts() -> list[dict]:
    """Scan ~/.kiro/scripts/ for validation scripts."""
    scripts_dir = KIRO_HOME / "scripts"
    if not scripts_dir.is_dir():
        return []

    known = {
        "validate-spec.py": "Validate spec quality gates",
        "audit-steering-compliance.py": "Post-task steering compliance audit",
        "session-lock.py": "File-level session coordination",
        "audit-component-usage.py": "Shared registry consumer breakage check",
        "knowledge-init.py": "Knowledge base discovery and freshness check",
        "update-harness.py": "Regenerate platform adapter from template",
    }

    scripts = []
    for name, purpose in sorted(known.items()):
        if (scripts_dir / name).exists():
            scripts.append({"name": name, "purpose": purpose})
    return scripts


def scan_skills() -> list[str]:
    """Scan ~/.kiro/skills/ for available skills."""
    cache_file = KIRO_HOME / "skills" / ".skills-cache.txt"
    if cache_file.exists():
        return [line.strip() for line in cache_file.read_text().splitlines() if line.strip()]

    skills_dir = KIRO_HOME / "skills"
    if not skills_dir.is_dir():
        return []

    return sorted(
        d.name for d in skills_dir.iterdir()
        if d.is_dir() and (d / "SKILL.md").exists()
    )


def generate_steering_list(files: list[str]) -> str:
    """Generate bullet list of steering files."""
    lines = []
    for f in files:
        lines.append(f"- `{f}`")
    return "\n".join(lines)


def generate_scripts_table(scripts: list[dict]) -> str:
    """Generate markdown table of scripts."""
    lines = [
        "| Script | Command | Purpose |",
        "|--------|---------|---------|",
    ]
    for s in scripts:
        cmd = f"`python3 ~/.kiro/scripts/{s['name']} <args>`"
        lines.append(f"| {s['name']} | {cmd} | {s['purpose']} |")
    return "\n".join(lines)


def generate_skills_block(skills: list[str]) -> str:
    """Generate skills list with loading instructions."""
    if not skills:
        return "No skills detected. Run `python3 ~/.kiro/skills/update-agent.py --force` to refresh."

    lines = ["Available skills in `~/.kiro/skills/` (loaded via symlink at `~/.claude/skills/`):", ""]
    for skill in skills:
        lines.append(f"- **{skill}**")

    lines.extend([
        "",
        "**Loading a skill:**",
        "1. Read `~/.kiro/skills/<skill-name>/SKILL.md` for context",
        "2. Check if `MENU.yaml` exists in the skill directory",
        "3. If MENU.yaml exists, parse it and present menu options interactively",
        "4. Wait for user selection before proceeding with the selected workflow",
        "5. If no MENU.yaml, proceed with the skill's default instructions",
        "",
        "**Running skill scripts:**",
        "- ALWAYS use absolute paths: `python3 ~/.kiro/skills/<skill-name>/scripts/<script>.py`",
        "- NEVER use relative paths like `scripts/<script>.py`",
        "- NEVER use `uv run` — use `python3` directly",
        "- The working directory is the user's project, not the skill directory",
    ])
    return "\n".join(lines)


def generate_identity_block() -> str:
    """Generate the identity block content."""
    return (
        "You are GDIT-SDAF (Spec-Driven AI Framework), an AI assistant that combines\n"
        "specification-driven federal development with Claude Code's agentic capabilities.\n"
        "\n"
        "You enforce spec-first development, NIST 800-218 compliance, and security-by-default\n"
        "for all code generation. Steering rules are loaded via ~/.claude/rules/ — do not\n"
        "restate them. This file provides Claude Code-specific behavioral adaptations only.\n"
        "\n"
        "Language: Python (default). For Java or .NET, delegate to the appropriate subagent\n"
        "in ~/.claude/agents/."
    )


def generate_knowledge_block() -> str:
    """Generate knowledge discovery block for Claude Code (Grep-based, no semantic search)."""
    return (
        "Claude Code does not have a native semantic search tool. Use `Read`, `Grep`, and `Glob`\n"
        "targeted at discovered project directories.\n"
        "\n"
        "**Before generating code** that references infrastructure, APIs, shared utilities, schemas,\n"
        "specs, or shared components — search the relevant directory first:\n"
        "\n"
        "| What you need | Where to search |\n"
        "|---------------|----------------|\n"
        "| Infrastructure resources | `infrastructure/` (CloudFormation, SAM, Terraform, CDK) |\n"
        "| API operations / services | `frontend/src/services/` or `src/` |\n"
        "| Shared utilities / layers | `src/layers/` |\n"
        "| Validation schemas | `frontend/src/schemas/` |\n"
        "| Existing specs | `.kiro/specs/` |\n"
        "| Shared components | `.kiro/registry/` |\n"
        "| Architecture decisions | `docs/` |\n"
        "\n"
        "**When NOT to search**: exact-path reads, files already in context, steering rules, active edits.\n"
        "\n"
        "**Discovery**: Run `python3 ~/.kiro/scripts/knowledge-init.py --project-dir $(pwd) --dry-run`\n"
        "to see which directories exist and are indexable in the current project."
    )


def populate_slots(template: str) -> str:
    """Replace all {{SLOT_NAME}} placeholders with generated content."""
    steering_files = scan_steering_files()
    scripts = scan_scripts()
    skills = scan_skills()

    replacements = {
        "IDENTITY_BLOCK": generate_identity_block(),
        "STEERING_FILES_LIST": generate_steering_list(steering_files),
        "SCRIPTS_REFERENCE": generate_scripts_table(scripts),
        "SKILLS_BLOCK": generate_skills_block(skills),
        "KNOWLEDGE_BLOCK": generate_knowledge_block(),
    }

    result = template
    for slot, content in replacements.items():
        result = result.replace(f"{{{{{slot}}}}}", content)

    return result


def validate_output(output: str, expected_sections: list[str]) -> list[str]:
    """Validate structural integrity of generated output."""
    errors = []

    # Check all expected sections present
    for section in expected_sections:
        if section not in output:
            errors.append(f"Missing section: {section}")

    # Check no unreplaced slots remain
    remaining = re.findall(r"\{\{[A-Z_]+\}\}", output)
    if remaining:
        errors.append(f"Unreplaced slots: {', '.join(remaining)}")

    return errors


def file_hash(path: Path) -> str:
    """Get SHA-256 hash of file content."""
    if not path.exists():
        return ""
    return hashlib.sha256(path.read_bytes()).hexdigest()


def generate_platform(platform: str) -> bool:
    """Generate adapter file for a platform. Returns True if file was written."""
    config = PLATFORMS.get(platform)
    if not config:
        print(f"ERROR: Unknown platform '{platform}'")
        return False

    template_path = TEMPLATES_DIR / config["template"]
    if not template_path.exists():
        print(f"  SKIP  {platform} — template not found: {template_path}")
        return False

    output_path = config["output"]

    # Read and populate template
    template = template_path.read_text()
    output = populate_slots(template)

    # Validate structure
    errors = validate_output(output, config["expected_sections"])
    if errors:
        print(f"  ERROR {platform} — structural validation failed:")
        for e in errors:
            print(f"    - {e}")
        print("  Output NOT written.")
        return False

    # Check if content changed
    new_hash = hashlib.sha256(output.encode()).hexdigest()
    if file_hash(output_path) == new_hash:
        print(f"  OK    {platform} — no changes needed")
        return False

    # Write output
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(output)
    print(f"  WRITE {platform} → {output_path}")
    return True


def main() -> None:
    """Main entry point."""
    parser = argparse.ArgumentParser(description="Regenerate platform adapter files from templates")
    parser.add_argument("--platform", choices=list(PLATFORMS.keys()), help="Target platform")
    parser.add_argument("--all", action="store_true", help="Generate for all platforms")
    args = parser.parse_args()

    if not args.platform and not args.all:
        parser.print_help()
        sys.exit(1)

    print("GDIT-SDAF Harness Update")
    print("=" * 40)

    platforms = list(PLATFORMS.keys()) if args.all else [args.platform]
    written = 0

    for platform in platforms:
        if generate_platform(platform):
            written += 1

    print(f"\nDone. {written} file(s) written.")


if __name__ == "__main__":
    main()
