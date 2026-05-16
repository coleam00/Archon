#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""Scan modules/ for training module skills and generate top-level MENU.yaml."""

import re
import sys
from pathlib import Path


def parse_frontmatter(skill_md: Path) -> dict[str, str] | None:
    """Extract name and description from SKILL.md YAML frontmatter."""
    text = skill_md.read_text(encoding="utf-8")
    if not text.startswith("---"):
        return None
    end = text.find("---", 3)
    if end == -1:
        return None
    fm = text[3:end]
    name_m = re.search(r"^name:\s*(.+)$", fm, re.MULTILINE)
    # description may be single-line or multi-line (>- folded scalar)
    desc_m = re.search(
        r"^description:\s*>-?\s*\n((?:[ \t]+.+\n?)+)", fm, re.MULTILINE
    )
    if not desc_m:
        desc_m = re.search(r"^description:\s*(.+)$", fm, re.MULTILINE)
    if not name_m or not desc_m:
        return None
    name = name_m.group(1).strip().strip("\"'")
    desc_raw = desc_m.group(1).strip().strip("\"'")
    # Collapse multi-line folded scalar into single line
    desc = re.sub(r"\s*\n\s*", " ", desc_raw)
    return {"name": name, "description": desc}


def count_steps(menu_yaml: Path) -> int:
    """Count step entries in a MENU.yaml by matching '- id:' lines."""
    if not menu_yaml.exists():
        return 0
    text = menu_yaml.read_text(encoding="utf-8")
    return len(re.findall(r"^\s*- id:", text, re.MULTILINE))


def discover_modules(modules_dir: Path) -> list[dict]:
    """Discover valid training modules sorted by directory name."""
    modules = []
    if not modules_dir.is_dir():
        return modules
    for d in sorted(modules_dir.iterdir()):
        if not d.is_dir():
            continue
        skill_md = d / "SKILL.md"
        if not skill_md.exists():
            print(f"warning: skipping {d.name}/ — no SKILL.md", file=sys.stderr)
            continue
        meta = parse_frontmatter(skill_md)
        if not meta:
            print(
                f"warning: skipping {d.name}/ — invalid SKILL.md frontmatter",
                file=sys.stderr,
            )
            continue
        steps = count_steps(d / "MENU.yaml")
        modules.append(
            {
                "dir_name": d.name,
                "name": meta["name"],
                "description": meta["description"],
                "steps": steps,
                "path": str(d),
            }
        )
    return modules


def generate_menu_yaml(modules: list[dict], skill_dir: Path) -> str:
    """Generate MENU.yaml content from discovered modules."""
    lines = [
        "name: GDIT-SDAF Framework Training",
        "description: Modular training platform for the GDIT-SDAF Framework",
        'version: "1.0"',
        "",
        "preamble: |",
        "  You are in the GDIT-SDAF Framework Training hub. Track your context:",
        "  - HUB: You are at the top-level module list (this menu).",
        "  - MODULE:<name>: You are inside a training module's steps.",
        "",
        "  Navigation commands (case-insensitive):",
        '  - Number: In HUB selects a module. In MODULE selects a step.',
        '  - "back" / "menu" / "exit module": In MODULE returns to HUB. In HUB is a no-op.',
        '  - "exit skill" / "exit training": Exits completely from any context.',
        '  - "exit": In MODULE returns to HUB. In HUB exits completely.',
        "",
        "  On module completion: return to HUB, show module list, suggest next module.",
        "",
        "steps:",
    ]
    for i, mod in enumerate(modules, 1):
        module_menu_path = f"{skill_dir}/modules/{mod['dir_name']}/MENU.yaml"
        step_info = f" ({mod['steps']} steps)" if mod["steps"] else ""
        # Escape any double quotes in name/description
        name_safe = mod["name"].replace('"', '\\"')
        desc_safe = mod["description"].replace('"', '\\"')
        lines.extend(
            [
                f"  - id: {mod['dir_name']}",
                f'    title: "{i}. {name_safe}"',
                f'    description: "{desc_safe}{step_info}"',
                "    prompt: |",
                f"      You are now in MODULE:{mod['dir_name']}. Read the module menu at:",
                f"      {module_menu_path}",
                "      Present its steps to the user as a numbered list.",
                "",
                '      Remind the user: type a step number to begin, "back" to return to the',
                "      training hub module list, or \"exit\" to leave training.",
                "",
            ]
        )
    return "\n".join(lines) + "\n"


def main() -> None:
    skill_dir = Path(__file__).resolve().parent.parent
    modules_dir = skill_dir / "modules"

    modules = discover_modules(modules_dir)
    if not modules:
        print("error: no valid training modules found in modules/", file=sys.stderr)
        sys.exit(1)

    menu_content = generate_menu_yaml(modules, skill_dir)
    out_path = skill_dir / "MENU.yaml"
    out_path.write_text(menu_content, encoding="utf-8")
    print(f"Generated {out_path} with {len(modules)} module(s):")
    for i, mod in enumerate(modules, 1):
        step_info = f" ({mod['steps']} steps)" if mod["steps"] else ""
        print(f"  {i}. {mod['name']}{step_info}")


if __name__ == "__main__":
    main()
