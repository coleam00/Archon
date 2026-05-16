#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""
Skill Initializer - Creates a new skill from template

Usage:
    init_skill.py <skill-name> --path <path> [--resources scripts,references,assets] [--menu] [--examples]

Examples:
    init_skill.py my-new-skill --path .kiro/skills
    init_skill.py my-new-skill --path .kiro/skills --resources scripts,references
    init_skill.py my-api-helper --path .kiro/skills --resources scripts --menu
    init_skill.py custom-skill --path /custom/location --examples
"""

import argparse
import re
import sys
from pathlib import Path

MAX_SKILL_NAME_LENGTH = 64
ALLOWED_RESOURCES = {"scripts", "references", "assets", "config"}

SKILL_TEMPLATE = """---
name: {skill_name}
description: "[TODO: What this skill does and WHEN to use it. Include trigger phrases. Example: Automated security scanning and remediation. Use when users want to scan for vulnerabilities, review findings, or fix security issues.]"
# license: MIT
# compatibility: Python 3.12+
# allowed-tools: Bash(python3:*) Read Write
# metadata:
#   author: [your-name]
#   version: "1.0.0"
#   category: [development|security|automation|documentation]
#   tags: [comma, separated, keywords]
#   python_version: ">=3.12"
---

# {skill_title}

## Overview

[TODO: 1-2 sentences explaining what this skill enables]

## Platform Requirements

[TODO: List runtime prerequisites (Python version, external tools, cloud access) — or remove this section if none]

## [TODO: Add your main sections here]

[TODO: Add content based on your skill structure]
"""

MENU_TEMPLATE = """---
skill_name: {skill_name}
menu_version: "1.0"
description: {skill_title} workflows
python_version: ">=3.12"

workflows:
  - id: example-workflow
    label: "Example Workflow"
    description: "Example workflow description"
    script: scripts/example.py
    interactive: false
    instructions: |
      [TODO: Add detailed instructions for this workflow]
      
      Steps:
      1. Step one
      2. Step two
      3. Step three
      
      Run: python3 scripts/example.py
    parameters:
      - name: example_param
        required: false
        prompt: "Example parameter prompt"
        default: "default_value"

# AI Usage Instructions:
# When user loads this skill:
# 1. Present workflows as numbered menu
# 2. When user selects workflow, show instructions
# 3. Prompt for required parameters
# 4. Execute via specified command
"""

EXAMPLE_SCRIPT = """#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
\"\"\"
Example script for {skill_name}

This is a template script demonstrating PEP 723 compliance.
Replace this with your actual script logic.
\"\"\"

import sys
from pathlib import Path


def main():
    \"\"\"Main entry point\"\"\"
    print("✅ Example script for {skill_name}")
    print("ℹ️  Replace this with your actual implementation")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\\n❌ Cancelled", file=sys.stderr)
        sys.exit(1)
"""

EXAMPLE_REFERENCE = """# {skill_title} Reference

This is an example reference document.

## Section 1

Add your reference content here.

## Section 2

More reference content.
"""

EXAMPLE_ASSET = """Example asset file for skill.
Replace this with actual asset content.
"""


def normalize_skill_name(raw_name):
    """Normalize skill name to lowercase hyphen-case."""
    normalized = raw_name.lower()
    normalized = re.sub(r"[^a-z0-9]+", "-", normalized)
    normalized = normalized.strip("-")
    normalized = re.sub(r"-{2,}", "-", normalized)
    return normalized


def title_case_skill_name(skill_name):
    """Convert hyphenated skill name to Title Case for display."""
    return " ".join(word.capitalize() for word in skill_name.split("-"))


def parse_resources(raw_resources):
    if not raw_resources:
        return []
    resources = [item.strip() for item in raw_resources.split(",") if item.strip()]
    invalid = sorted({item for item in resources if item not in ALLOWED_RESOURCES})
    if invalid:
        allowed = ", ".join(sorted(ALLOWED_RESOURCES))
        print(f"❌ Unknown resource type(s): {', '.join(invalid)}", file=sys.stderr)
        print(f"   Allowed: {allowed}", file=sys.stderr)
        sys.exit(1)
    deduped = []
    seen = set()
    for resource in resources:
        if resource not in seen:
            deduped.append(resource)
            seen.add(resource)
    return deduped


def create_resource_dirs(skill_dir, skill_name, skill_title, resources, include_examples):
    for resource in resources:
        resource_dir = skill_dir / resource
        resource_dir.mkdir(exist_ok=True)
        if resource == "scripts":
            if include_examples:
                example_script = resource_dir / "example.py"
                example_script.write_text(EXAMPLE_SCRIPT.format(skill_name=skill_name))
                example_script.chmod(0o755)
                print("✅ Created scripts/example.py")
            else:
                print("✅ Created scripts/")
        elif resource == "references":
            if include_examples:
                example_reference = resource_dir / "api_reference.md"
                example_reference.write_text(EXAMPLE_REFERENCE.format(skill_title=skill_title))
                print("✅ Created references/api_reference.md")
            else:
                print("✅ Created references/")
        elif resource == "assets":
            if include_examples:
                example_asset = resource_dir / "example_asset.txt"
                example_asset.write_text(EXAMPLE_ASSET)
                print("✅ Created assets/example_asset.txt")
            else:
                print("✅ Created assets/")
        elif resource == "config":
            if include_examples:
                config_file = resource_dir / "config.json"
                config_file.write_text('{\n  "default_setting": "value"\n}\n')
                print("✅ Created config/config.json")
            else:
                print("✅ Created config/")


def init_skill(skill_name, path, resources, include_menu, include_examples):
    """
    Initialize a new skill directory with template SKILL.md.

    Args:
        skill_name: Name of the skill
        path: Path where the skill directory should be created
        resources: Resource directories to create
        include_menu: Whether to create MENU.yaml template
        include_examples: Whether to create example files in resource directories

    Returns:
        Path to created skill directory, or None if error
    """
    # Determine skill directory path
    skill_dir = Path(path).resolve() / skill_name

    # Check if directory already exists
    if skill_dir.exists():
        print(f"❌ Skill directory already exists: {skill_dir}", file=sys.stderr)
        return None

    # Create skill directory
    try:
        skill_dir.mkdir(parents=True, exist_ok=False)
        print(f"✅ Created skill directory: {skill_dir}")
    except Exception as e:
        print(f"❌ Error creating directory: {e}", file=sys.stderr)
        return None

    # Create SKILL.md from template
    skill_title = title_case_skill_name(skill_name)
    skill_content = SKILL_TEMPLATE.format(skill_name=skill_name, skill_title=skill_title)

    skill_md_path = skill_dir / "SKILL.md"
    try:
        skill_md_path.write_text(skill_content)
        print("✅ Created SKILL.md")
    except Exception as e:
        print(f"❌ Error creating SKILL.md: {e}", file=sys.stderr)
        return None

    # Create MENU.yaml if requested
    if include_menu:
        menu_content = MENU_TEMPLATE.format(skill_name=skill_name, skill_title=skill_title)
        menu_path = skill_dir / "MENU.yaml"
        try:
            menu_path.write_text(menu_content)
            print("✅ Created MENU.yaml")
        except Exception as e:
            print(f"❌ Error creating MENU.yaml: {e}", file=sys.stderr)
            return None

    # Create resource directories if requested
    if resources:
        try:
            create_resource_dirs(skill_dir, skill_name, skill_title, resources, include_examples)
        except Exception as e:
            print(f"❌ Error creating resource directories: {e}", file=sys.stderr)
            return None

    # Print next steps
    print(f"\n✅ Skill '{skill_name}' initialized successfully at {skill_dir}")
    print("\nNext steps:")
    print("1. Edit SKILL.md to complete the TODO items and update the description")
    step = 2
    if include_menu:
        print(f"{step}. Edit MENU.yaml to define your workflows")
        step += 1
    if resources:
        if include_examples:
            print(f"{step}. Customize or delete the example files in resource directories")
        else:
            print(f"{step}. Add resources to scripts/, references/, and assets/ as needed")
        step += 1
    else:
        print(f"{step}. Create resource directories only if needed (scripts/, references/, assets/)")
        step += 1
    print(f"{step}. Run the validator when ready to check the skill structure")

    return skill_dir


def main():
    parser = argparse.ArgumentParser(
        description="Create a new skill directory with a SKILL.md template.",
    )
    parser.add_argument("skill_name", help="Skill name (normalized to hyphen-case)")
    parser.add_argument("--path", required=True, help="Output directory for the skill")
    parser.add_argument(
        "--resources",
        default="",
        help="Comma-separated list: scripts,references,assets",
    )
    parser.add_argument(
        "--menu",
        action="store_true",
        help="Create MENU.yaml template for interactive workflows",
    )
    parser.add_argument(
        "--examples",
        action="store_true",
        help="Create example files inside the selected resource directories",
    )
    args = parser.parse_args()

    raw_skill_name = args.skill_name
    skill_name = normalize_skill_name(raw_skill_name)
    if not skill_name:
        print("❌ Skill name must include at least one letter or digit.", file=sys.stderr)
        sys.exit(1)
    if len(skill_name) > MAX_SKILL_NAME_LENGTH:
        print(
            f"❌ Skill name '{skill_name}' is too long ({len(skill_name)} characters). "
            f"Maximum is {MAX_SKILL_NAME_LENGTH} characters.",
            file=sys.stderr,
        )
        sys.exit(1)
    if skill_name != raw_skill_name:
        print(f"ℹ️  Normalized skill name from '{raw_skill_name}' to '{skill_name}'.")

    resources = parse_resources(args.resources)
    if args.examples and not resources:
        print("❌ --examples requires --resources to be set.", file=sys.stderr)
        sys.exit(1)

    path = args.path

    print(f"Initializing skill: {skill_name}")
    print(f"   Location: {path}")
    if resources:
        print(f"   Resources: {', '.join(resources)}")
        if args.examples:
            print("   Examples: enabled")
    else:
        print("   Resources: none (create as needed)")
    if args.menu:
        print("   MENU.yaml: enabled")
    print()

    result = init_skill(skill_name, path, resources, args.menu, args.examples)

    if result:
        sys.exit(0)
    else:
        sys.exit(1)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n❌ Cancelled", file=sys.stderr)
        sys.exit(1)
