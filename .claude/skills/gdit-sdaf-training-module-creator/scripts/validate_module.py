#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""Validate a training module directory for completeness and correctness.

Usage:
    validate_module.py <module-dir>
"""

import re
import sys
from pathlib import Path

REQUIRED_STEP_FIELDS = {"id", "title", "prompt", "variations", "expect", "concept"}


def parse_frontmatter(text: str) -> dict[str, str] | None:
    """Extract YAML frontmatter key-value pairs."""
    if not text.startswith("---"):
        return None
    end = text.find("---", 3)
    if end == -1:
        return None
    fm = text[3:end]
    result: dict[str, str] = {}
    for line in fm.strip().split("\n"):
        if ":" in line and not line.startswith(" "):
            key, _, val = line.partition(":")
            val = val.strip().strip("\"'")
            result[key.strip()] = val
    return result


def extract_step_fields(text: str) -> list[dict[str, bool]]:
    """Check which required fields each step has."""
    steps: list[dict[str, bool]] = []
    blocks = re.split(r"(?m)^[ \t]*- id:\s*", text)
    for block in blocks[1:]:
        fields: dict[str, bool] = {"id": True}
        for field in ("title", "prompt", "expect", "concept"):
            fields[field] = bool(re.search(rf"^\s+{field}:\s*\S", block, re.MULTILINE))
        fields["variations"] = bool(re.search(r"^\s+variations:\s*$", block, re.MULTILINE))
        # Check variation has at least one entry with label
        fields["variation_entry"] = bool(re.search(r"^\s+- label:\s*\S", block, re.MULTILINE))
        steps.append(fields)
    return steps


def check_pep723(scripts_dir: Path) -> list[str]:
    """Check PEP 723 metadata in Python scripts."""
    errors: list[str] = []
    if not scripts_dir.is_dir():
        return errors
    for f in scripts_dir.glob("*.py"):
        content = f.read_text()
        if "# /// script" not in content:
            errors.append(f"  {f.name}: missing PEP 723 metadata")
    return errors


def main() -> int:
    if len(sys.argv) != 2:
        print("Usage: validate_module.py <module-dir>", file=sys.stderr)
        return 1

    mod_dir = Path(sys.argv[1])
    if not mod_dir.is_dir():
        print(f"[ERROR] Not a directory: {mod_dir}", file=sys.stderr)
        return 1

    fails = 0
    warns = 0

    # --- SKILL.md checks ---
    skill_md = mod_dir / "SKILL.md"
    if not skill_md.exists():
        print("❌ FAIL  SKILL.md not found")
        fails += 1
    else:
        print("✅ PASS  SKILL.md exists")
        content = skill_md.read_text()
        fm = parse_frontmatter(content)
        if fm is None:
            print("❌ FAIL  SKILL.md has no valid frontmatter")
            fails += 1
        else:
            if "name" not in fm or not fm["name"]:
                print("❌ FAIL  SKILL.md frontmatter missing 'name'")
                fails += 1
            elif not re.match(r"^[a-z0-9]+(-[a-z0-9]+)*$", fm["name"]):
                print(f"❌ FAIL  SKILL.md name '{fm['name']}' is not hyphen-case")
                fails += 1
            else:
                print(f"✅ PASS  SKILL.md name: {fm['name']}")

            if "description" not in fm or not fm["description"]:
                print("❌ FAIL  SKILL.md frontmatter missing 'description'")
                fails += 1
            else:
                print("✅ PASS  SKILL.md has description")

            # Name vs directory match (strip numeric prefix)
            dir_name = re.sub(r"^\d+-", "", mod_dir.name)
            if fm.get("name") and fm["name"] != dir_name:
                print(f"❌ FAIL  SKILL.md name '{fm['name']}' does not match directory '{dir_name}'")
                fails += 1
            else:
                print("✅ PASS  SKILL.md name matches directory")

    # --- MENU.yaml checks ---
    menu_path = mod_dir / "MENU.yaml"
    if not menu_path.exists():
        print("❌ FAIL  MENU.yaml not found")
        fails += 1
    else:
        print("✅ PASS  MENU.yaml exists")
        menu_text = menu_path.read_text()

        # Top-level fields
        for field in ("name", "description", "version"):
            m = re.search(rf"^{field}:\s*\S", menu_text, re.MULTILINE)
            if m:
                print(f"✅ PASS  MENU.yaml has '{field}'")
            else:
                print(f"❌ FAIL  MENU.yaml missing '{field}'")
                fails += 1

        # Steps
        step_fields = extract_step_fields(menu_text)
        if not step_fields:
            print("❌ FAIL  MENU.yaml has no steps")
            fails += 1
        else:
            print(f"✅ PASS  MENU.yaml has {len(step_fields)} step(s)")
            for i, sf in enumerate(step_fields, 1):
                missing = [f for f in REQUIRED_STEP_FIELDS if not sf.get(f)]
                if missing:
                    print(f"❌ FAIL  Step {i} missing: {', '.join(missing)}")
                    fails += 1
                else:
                    print(f"✅ PASS  Step {i} has all required fields")
                if not sf.get("variation_entry"):
                    print(f"❌ FAIL  Step {i} has no variation entries")
                    fails += 1

    # --- course.html checks ---
    html_path = mod_dir / "course.html"
    if not html_path.exists():
        print("⚠️  WARN  course.html not found — run build_html.py to generate")
        warns += 1
    else:
        print("✅ PASS  course.html exists")
        if menu_path.exists() and html_path.stat().st_mtime < menu_path.stat().st_mtime:
            print("⚠️  WARN  course.html is older than MENU.yaml — regenerate with build_html.py")
            warns += 1

    # --- PEP 723 checks ---
    scripts_dir = mod_dir / "scripts"
    pep_errors = check_pep723(scripts_dir)
    if pep_errors:
        for e in pep_errors:
            print(f"❌ FAIL  PEP 723: {e}")
            fails += 1
    elif scripts_dir.is_dir() and list(scripts_dir.glob("*.py")):
        print("✅ PASS  All scripts have PEP 723 metadata")

    # --- Summary ---
    if fails == 0:
        print(f"\n✅ Module valid ({warns} warning(s))")
        return 0
    else:
        print(f"\n❌ {fails} failure(s), {warns} warning(s)")
        return 1


if __name__ == "__main__":
    sys.exit(main())
