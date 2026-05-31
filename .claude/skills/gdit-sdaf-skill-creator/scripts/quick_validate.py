#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""
Quick validation script for skills — checks structure, frontmatter, MENU.yaml, and body quality.
"""

import re
import sys
from pathlib import Path

MAX_SKILL_NAME_LENGTH = 64
KEBAB_CASE_RE = re.compile(r"^[a-z][a-z0-9-]*$")


def parse_yaml_simple(text):
    """Simple YAML parser for basic key-value pairs (no external deps)"""
    result = {}
    current_key = None
    current_value = []

    for line in text.split("\n"):
        if line.strip().startswith("#") or not line.strip():
            if current_key and current_value:
                result[current_key] = "\n".join(current_value).strip()
                current_key = None
                current_value = []
            continue

        if ":" in line and not line.startswith(" ") and not line.startswith("\t"):
            if current_key:
                result[current_key] = "\n".join(current_value).strip() if current_value else ""

            key, _, value = line.partition(":")
            current_key = key.strip()
            value = value.strip()

            if value.startswith('"') and value.endswith('"'):
                value = value[1:-1]
            elif value.startswith("'") and value.endswith("'"):
                value = value[1:-1]

            if value:
                result[current_key] = value
                current_key = None
                current_value = []
            else:
                current_value = []
        elif current_key:
            current_value.append(line)

    if current_key:
        result[current_key] = "\n".join(current_value).strip() if current_value else ""

    return result


def parse_menu_workflows(menu_content):
    """Parse MENU.yaml workflow entries from raw content (line-based)."""
    workflows = []
    current = None

    for line in menu_content.split("\n"):
        stripped = line.strip()
        # Detect workflow entry start: "- id: value"
        if stripped.startswith("- id:"):
            if current:
                workflows.append(current)
            current = {"id": stripped.split(":", 1)[1].strip().strip("\"'")}
        elif current and stripped.startswith("- id "):
            # edge case: "- id : value"
            pass
        elif current and ":" in stripped and not stripped.startswith("-") and not stripped.startswith("#"):
            # Parse fields within current workflow block (indented)
            if line.startswith("    ") or line.startswith("\t"):
                key, _, val = stripped.partition(":")
                key = key.strip()
                val = val.strip().strip("\"'")
                if key in ("label", "description", "script", "interactive"):
                    current[key] = val

    if current:
        workflows.append(current)

    return workflows


def normalize_name(raw):
    """Normalize a raw name to hyphen-case for suggestions."""
    normalized = raw.lower()
    normalized = re.sub(r"[^a-z0-9]+", "-", normalized)
    normalized = normalized.strip("-")
    normalized = re.sub(r"-{2,}", "-", normalized)
    return normalized


def validate_skill(skill_path):
    """Validate a skill directory — returns (passed, errors, warnings)."""
    skill_path = Path(skill_path)
    errors = []
    warnings = []

    # --- SKILL.md existence ---
    skill_md = skill_path / "SKILL.md"
    if not skill_md.exists():
        return False, ["SKILL.md not found"], []

    content = skill_md.read_text()
    if not content.startswith("---"):
        return False, ["No YAML frontmatter found"], []

    match = re.match(r"^---\n(.*?)\n---", content, re.DOTALL)
    if not match:
        return False, ["Invalid frontmatter format"], []

    frontmatter_text = match.group(1)

    try:
        frontmatter = parse_yaml_simple(frontmatter_text)
        if not isinstance(frontmatter, dict):
            return False, ["Frontmatter must be a YAML dictionary"], []
    except Exception as e:
        return False, [f"Invalid YAML in frontmatter: {e}"], []

    # --- Frontmatter field validation ---
    allowed_properties = {"name", "description", "license", "compatibility", "allowed-tools", "metadata"}
    unexpected_keys = set(frontmatter.keys()) - allowed_properties
    if unexpected_keys:
        allowed = ", ".join(sorted(allowed_properties))
        unexpected = ", ".join(sorted(unexpected_keys))
        errors.append(
            f"Unexpected key(s) in frontmatter: {unexpected}. Allowed: {allowed}"
        )

    if "name" not in frontmatter:
        errors.append("Missing 'name' in frontmatter")
    if "description" not in frontmatter:
        errors.append("Missing 'description' in frontmatter")

    name = frontmatter.get("name", "").strip()
    if name:
        if not re.match(r"^[a-z0-9-]+$", name):
            suggested = normalize_name(name)
            errors.append(
                f"Name '{name}' should be hyphen-case. Suggested: '{suggested}'"
            )
        elif name.startswith("-") or name.endswith("-") or "--" in name:
            errors.append(
                f"Name '{name}' cannot start/end with hyphen or contain consecutive hyphens"
            )
        elif len(name) > MAX_SKILL_NAME_LENGTH:
            errors.append(
                f"Name too long ({len(name)} chars). Maximum: {MAX_SKILL_NAME_LENGTH}"
            )

        # Name-directory consistency check
        if name != skill_path.name:
            errors.append(
                f"Name '{name}' does not match directory name '{skill_path.name}'. "
                f"These must match for skill discovery to work."
            )

    description = frontmatter.get("description", "").strip()
    if description:
        if "<" in description or ">" in description:
            errors.append("Description cannot contain angle brackets (< or >)")
        if len(description) > 1024:
            errors.append(
                f"Description too long ({len(description)} chars). Maximum: 1024"
            )

    # --- MENU.yaml validation ---
    menu_path = skill_path / "MENU.yaml"
    if menu_path.exists():
        try:
            menu_content = menu_path.read_text()
            menu_raw = menu_content.split("---", 2)[1] if menu_content.startswith("---") else menu_content
            menu_data = parse_yaml_simple(menu_raw)

            if "skill_name" not in menu_data:
                errors.append("MENU.yaml missing required field: skill_name")
            elif menu_data.get("skill_name") != name:
                errors.append(
                    f"MENU.yaml skill_name '{menu_data.get('skill_name')}' "
                    f"does not match SKILL.md name '{name}'"
                )

            # Deep workflow validation
            workflows = parse_menu_workflows(menu_content)
            if not workflows:
                warnings.append("MENU.yaml has no parseable workflow entries")
            else:
                ids_seen = []
                for i, wf in enumerate(workflows, 1):
                    wf_id = wf.get("id", "")
                    if not wf_id:
                        errors.append(f"Workflow #{i}: missing 'id' field")
                    else:
                        if not KEBAB_CASE_RE.match(wf_id):
                            errors.append(
                                f"Workflow '{wf_id}': id must be kebab-case. "
                                f"Suggested: '{normalize_name(wf_id)}'"
                            )
                        if wf_id in ids_seen:
                            errors.append(f"Workflow '{wf_id}': duplicate id")
                        ids_seen.append(wf_id)

                    if not wf.get("label"):
                        errors.append(f"Workflow '{wf_id or f'#{i}'}': missing 'label' field")
                    if not wf.get("description"):
                        errors.append(f"Workflow '{wf_id or f'#{i}'}': missing 'description' field")

                    # Validate script reference exists
                    script_ref = wf.get("script", "")
                    if script_ref:
                        script_path = skill_path / script_ref
                        if not script_path.exists():
                            errors.append(
                                f"Workflow '{wf_id}': script '{script_ref}' not found"
                            )

        except Exception as e:
            errors.append(f"Invalid MENU.yaml: {e}")

    # --- Python script PEP 723 validation ---
    scripts_dir = skill_path / "scripts"
    if scripts_dir.exists() and scripts_dir.is_dir():
        for script_file in scripts_dir.glob("*.py"):
            try:
                script_content = script_file.read_text()

                # Skip library modules (no if __name__ == "__main__")
                if 'if __name__ == "__main__"' not in script_content:
                    continue

                lines = script_content.split("\n")
                has_pep723 = False
                for i in range(min(10, len(lines))):
                    if lines[i].strip() == "# /// script":
                        for j in range(i + 1, min(i + 10, len(lines))):
                            if lines[j].strip() == "# ///":
                                has_pep723 = True
                                break
                        break

                if not has_pep723:
                    errors.append(
                        f"Script '{script_file.name}' missing PEP 723 metadata "
                        f"(# /// script ... # ///)"
                    )
            except Exception as e:
                errors.append(f"Error reading script '{script_file.name}': {e}")

    # --- Body quality checks (advisory) ---
    body_start = content.find("---", 3)
    if body_start != -1:
        body = content[body_start + 3:]
        body_lines = body.strip().split("\n")

        if len(body_lines) > 500:
            warnings.append(
                f"SKILL.md body is {len(body_lines)} lines (recommended: ≤500). "
                f"Consider splitting into reference files."
            )

        if "[TODO" in body:
            todo_count = body.count("[TODO")
            warnings.append(
                f"SKILL.md body contains {todo_count} [TODO marker(s) — skill may be incomplete"
            )

        if scripts_dir.exists() and scripts_dir.is_dir():
            if "## Scripts" not in body and "## scripts" not in body.lower().replace("## scripts", "## Scripts"):
                # Check case-insensitively
                if not re.search(r"^##\s+Scripts", body, re.MULTILINE | re.IGNORECASE):
                    warnings.append(
                        "Skill has scripts/ directory but no '## Scripts' section in body"
                    )

    passed = len(errors) == 0
    return passed, errors, warnings


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: python quick_validate.py <skill_directory>", file=sys.stderr)
        sys.exit(1)

    try:
        passed, errors, warnings = validate_skill(sys.argv[1])

        for err in errors:
            print(f"❌ {err}", file=sys.stderr)
        for warn in warnings:
            print(f"⚠️  {warn}", file=sys.stderr)

        if passed:
            if warnings:
                print(f"✅ Skill is valid ({len(warnings)} warning(s))")
            else:
                print("✅ Skill is valid!")
        else:
            print(f"❌ Validation failed: {len(errors)} error(s)", file=sys.stderr)

        sys.exit(0 if passed else 1)
    except KeyboardInterrupt:
        print("\n❌ Cancelled", file=sys.stderr)
        sys.exit(1)
