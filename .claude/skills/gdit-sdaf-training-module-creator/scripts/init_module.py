#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""Scaffold a new training module directory with template files.

Usage:
    init_module.py --name <module-name> --path <modules-dir> [--prefix NN] [--steps <json-file>]
"""

import argparse
import json
import re
import sys
from pathlib import Path

MAX_NAME_LENGTH = 64

SKILL_MD_TEMPLATE = """\
---
name: {name}
description: "[TODO: Module description — what students learn and prerequisites]"
license: MIT
compatibility: Requires GDIT Spec-Driven AI Framework installed via scripts/install.py
---

# {title}

[TODO: Brief description of this training module.]

## Steps

[TODO: List the steps covered in this module.]

## Usage

Say "load framework-training skill" and select this module from the list.
"""

MENU_YAML_TEMPLATE = """\
name: {title}
description: "[TODO: One-line module description]"
version: "1.0"

steps:
  - id: example-step
    title: "1. Example Step Title"
    prompt: |
      [TODO: Full AI prompt — what the agent should teach or demonstrate in this step.
      This is the text students paste into their AI session.]
    variations:
      - label: Concise
        prompt: |
          [TODO: Shorter version of the main prompt — same result, less typing]
      - label: Minimal
        prompt: |
          [TODO: Minimal version — fewest words, same result]
    expect: "[TODO: What the student should see after pasting the prompt]"
    concept: "[TODO: Key concept or takeaway for this step]"
"""


def normalize_name(raw: str) -> str:
    """Normalize to lowercase hyphen-case."""
    name = raw.lower()
    name = re.sub(r"[^a-z0-9]+", "-", name)
    name = name.strip("-")
    name = re.sub(r"-{2,}", "-", name)
    return name


def title_case(name: str) -> str:
    """Convert hyphenated name to Title Case."""
    return " ".join(w.capitalize() for w in name.split("-"))


def detect_next_prefix(target: Path) -> int:
    """Scan for NN-* directories and return max + 1."""
    highest = 0
    for d in target.iterdir():
        if d.is_dir():
            m = re.match(r"^(\d+)-", d.name)
            if m:
                highest = max(highest, int(m.group(1)))
    return highest + 1


def _yaml_escape(text: str) -> str:
    """Escape a string for safe YAML scalar output."""
    if any(c in text for c in (':', '#', '{', '}', '[', ']', '&', '*', '?', '|', '>', '"', "'", '\n')):
        return '"' + text.replace('\\', '\\\\').replace('"', '\\"').replace('\n', '\\n') + '"'
    return text


def _indent(text: str, spaces: int) -> str:
    """Indent each line of a multi-line string."""
    pad = " " * spaces
    return "\n".join(pad + ln for ln in text.split("\n"))


def build_menu_from_steps(title: str, steps: list[dict]) -> str:
    """Generate MENU.yaml content from a list of step dicts."""
    lines = [
        f"name: {title}",
        'description: "[TODO: One-line module description]"',
        'version: "1.0"',
        "",
        "steps:",
    ]
    for step in steps:
        lines.append(f"  - id: {step['id']}")
        lines.append(f"    title: {_yaml_escape(step.get('title', ''))}")
        # prompt as block scalar
        prompt = step.get("prompt", "[TODO]")
        lines.append("    prompt: |")
        lines.append(_indent(prompt.rstrip(), 6))
        # variations
        variations = step.get("variations", [])
        if variations:
            lines.append("    variations:")
            for var in variations:
                lines.append(f"      - label: {var.get('label', 'Concise')}")
                lines.append("        prompt: |")
                lines.append(_indent(var.get("prompt", "[TODO]").rstrip(), 10))
        else:
            lines.append("    variations:")
            lines.append("      - label: Concise")
            lines.append("        prompt: |")
            lines.append("          [TODO: Shorter version]")
            lines.append("      - label: Minimal")
            lines.append("        prompt: |")
            lines.append("          [TODO: Minimal version]")
        # expect and concept
        lines.append(f"    expect: {_yaml_escape(step.get('expect', '[TODO]'))}")
        lines.append(f"    concept: {_yaml_escape(step.get('concept', '[TODO]'))}")
        # optional fields
        if "time" in step:
            lines.append(f"    time: {_yaml_escape(step['time'])}")
        if step.get("summary"):
            lines.append("    summary: true")
    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description="Scaffold a new training module.")
    parser.add_argument("--name", required=True, help="Module name")
    parser.add_argument("--path", required=True, help="Target modules directory")
    parser.add_argument("--prefix", type=int, default=None,
                        help="Numeric prefix (auto-detects if omitted)")
    parser.add_argument("--steps", default=None,
                        help="JSON file with pre-planned step definitions")
    args = parser.parse_args()

    name = normalize_name(args.name)
    if not name:
        print("[ERROR] Module name must contain at least one letter or digit.", file=sys.stderr)
        return 1
    if len(name) > MAX_NAME_LENGTH:
        print(f"[ERROR] Name '{name}' exceeds {MAX_NAME_LENGTH} characters.", file=sys.stderr)
        return 1
    if name != args.name.lower().strip():
        print(f"Note: Normalized name to '{name}'.")

    target = Path(args.path)
    if not target.is_dir():
        print(f"[ERROR] Target path does not exist: {target}", file=sys.stderr)
        return 1

    # Check for collision
    for d in target.iterdir():
        if d.is_dir():
            stripped = re.sub(r"^\d+-", "", d.name)
            if stripped == name:
                print(f"[ERROR] Module '{name}' already exists: {d}", file=sys.stderr)
                return 1

    # Load steps from JSON if provided
    steps_data: list[dict] | None = None
    if args.steps:
        steps_path = Path(args.steps)
        if not steps_path.exists():
            print(f"[ERROR] Steps file not found: {steps_path}", file=sys.stderr)
            return 1
        try:
            steps_data = json.loads(steps_path.read_text(encoding="utf-8"))
            if not isinstance(steps_data, list) or not steps_data:
                print("[ERROR] Steps file must contain a non-empty JSON array.", file=sys.stderr)
                return 1
        except json.JSONDecodeError as exc:
            print(f"[ERROR] Invalid JSON in steps file: {exc}", file=sys.stderr)
            return 1

    prefix = args.prefix if args.prefix is not None else detect_next_prefix(target)
    dir_name = f"{prefix:02d}-{name}"
    mod_dir = target / dir_name

    mod_dir.mkdir(parents=True)
    title = title_case(name)

    (mod_dir / "SKILL.md").write_text(SKILL_MD_TEMPLATE.format(name=name, title=title))

    if steps_data:
        menu_content = build_menu_from_steps(title, steps_data)
    else:
        menu_content = MENU_YAML_TEMPLATE.format(title=title)
    (mod_dir / "MENU.yaml").write_text(menu_content)

    (mod_dir / "scripts").mkdir()

    step_info = f" ({len(steps_data)} steps from plan)" if steps_data else ""
    print(f"[OK] Created module: {mod_dir}{step_info}")
    print("  SKILL.md")
    print("  MENU.yaml")
    print("  scripts/")
    print("\nNext steps:")
    if steps_data:
        print("  1. Review MENU.yaml — refine the generated prompts and variations")
    else:
        print("  1. Edit MENU.yaml — replace TODO placeholders with your steps")
    print("  2. Edit SKILL.md — update the description and step list")
    print(f"  3. Run: python3 scripts/build_html.py --module {mod_dir}")
    print(f"  4. Run: python3 scripts/validate_module.py {mod_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
