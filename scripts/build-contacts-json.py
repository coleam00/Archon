#!/usr/bin/env python3
"""
Build a static JSON contact registry from the second-brain vault.

Walks ~/repos/jid5274/second-brain/contacts/, parses YAML frontmatter
on each .md file, and emits a single
packages/web/src/lib/contacts.generated.json that ContactsPage imports.

Run when contact files change:
    python3 scripts/build-contacts-json.py

This is a build step, not runtime. The dashboard does NOT need filesystem
access — the JSON is bundled into the Vite build / served by the dev server.
"""

import json
import re
import sys
from pathlib import Path

# ---- paths ----
REPO_ROOT = Path(__file__).resolve().parents[1]
CONTACTS_DIR = (REPO_ROOT.parent / "second-brain" / "contacts").resolve()
OUT_PATH = (REPO_ROOT / "packages" / "web" / "src" / "lib" / "contacts.generated.json").resolve()

# Categories to include — _<name>.md MOC files and *.csv.sidecar.md fixtures excluded
INCLUDE_CATEGORIES = {"team", "prospects", "clinical-partners"}


def parse_frontmatter(text: str) -> tuple[dict, str]:
    """Tiny YAML-ish frontmatter parser. Handles flat key:value, list items
    (- "..."), and nested 1-level indented blocks. NOT a full YAML parser.
    Returns (frontmatter_dict, body_text)."""
    if not text.startswith("---\n"):
        return {}, text
    end = text.find("\n---\n", 4)
    if end == -1:
        return {}, text
    fm_raw = text[4:end]
    body = text[end + 5 :]

    fm: dict = {}
    current_list_key = None
    for line in fm_raw.splitlines():
        if not line.strip():
            current_list_key = None
            continue
        # List item under a key
        if line.startswith("  - ") and current_list_key:
            val = line[4:].strip().strip('"').strip("'")
            fm.setdefault(current_list_key, []).append(val)
            continue
        # New key:value
        m = re.match(r"^([a-zA-Z_][\w-]*):\s*(.*)$", line)
        if m:
            k, v = m.group(1), m.group(2).strip()
            current_list_key = None
            if v == "":
                # could be a list key — peek not needed, just track
                current_list_key = k
                continue
            # Strip surrounding quotes
            if (v.startswith('"') and v.endswith('"')) or (v.startswith("'") and v.endswith("'")):
                v = v[1:-1]
            # Inline list e.g. tags: [a, b, c]
            if v.startswith("[") and v.endswith("]"):
                inner = v[1:-1].strip()
                items = [i.strip().strip('"').strip("'") for i in inner.split(",") if i.strip()]
                fm[k] = items
            else:
                fm[k] = v
    return fm, body


def normalize_action_field(value: object) -> str:
    """Normalize contact action fields so placeholders don't create broken actions."""
    if value is None:
        return ""
    text = str(value).strip()
    if text.upper() in {"TBD", "?", "N/A", "NA", "NONE", "UNKNOWN"}:
        return ""
    if "pending Jason confirmation" in text or "verification notes" in text:
        return ""
    return text


def extract_first_paragraph(body: str) -> str:
    """Pull the first non-empty line/paragraph after the H1 header, if any."""
    lines = body.split("\n")
    in_h1 = False
    out: list[str] = []
    for line in lines:
        if line.startswith("# "):
            in_h1 = True
            continue
        if in_h1:
            stripped = line.strip()
            if stripped == "":
                if out:
                    break
                continue
            if stripped.startswith("#"):
                break
            # Strip markdown bold/italics for preview
            cleaned = re.sub(r"[\*_>]+", "", stripped).strip()
            out.append(cleaned)
            if len(" ".join(out)) > 200:
                break
    return " ".join(out)[:280] if out else ""


def categorize(filepath: Path) -> str:
    """Return the category name (folder under contacts/) or '' to skip."""
    rel = filepath.relative_to(CONTACTS_DIR)
    parts = rel.parts
    if len(parts) < 2:
        return ""
    cat = parts[0]
    if cat not in INCLUDE_CATEGORIES:
        return ""
    # Skip MOC / sidecar files
    if filepath.name.startswith("_"):
        return ""
    if filepath.name.endswith(".sidecar.md"):
        return ""
    return cat


def main() -> int:
    if not CONTACTS_DIR.is_dir():
        print(f"FATAL: contacts dir not found at {CONTACTS_DIR}", file=sys.stderr)
        return 1

    contacts: list[dict] = []

    for md_path in sorted(CONTACTS_DIR.rglob("*.md")):
        category = categorize(md_path)
        if not category:
            continue

        try:
            text = md_path.read_text(encoding="utf-8")
        except Exception as e:
            print(f"WARN: read failed {md_path}: {e}", file=sys.stderr)
            continue

        fm, body = parse_frontmatter(text)

        slug = md_path.stem
        name = fm.get("name") or slug.replace("-", " ").title()
        # Build preview (description from frontmatter > first paragraph)
        preview = fm.get("description") or extract_first_paragraph(body)

        contact = {
            "id": f"{category}/{slug}",
            "slug": slug,
            "category": category,
            "name": name,
            "role": fm.get("role") or fm.get("specialty") or "",
            "company": fm.get("company") or fm.get("team") or "",
            "email": normalize_action_field(fm.get("email")),
            "linkedin": normalize_action_field(fm.get("linkedin")),
            "phone": normalize_action_field(fm.get("phone")),
            "status": fm.get("status") or "",
            "preview": preview,
            "tags": fm.get("tags") or [],
            "vaultPath": str(md_path.relative_to(CONTACTS_DIR.parent)),
        }
        contacts.append(contact)

    # Sort: team first, then clinical-partners, then prospects; alpha within
    cat_order = {"team": 0, "clinical-partners": 1, "prospects": 2}
    contacts.sort(key=lambda c: (cat_order.get(c["category"], 99), c["name"].lower()))

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with OUT_PATH.open("w", encoding="utf-8") as f:
        json.dump(
            {
                "generated_at": __import__("datetime").datetime.utcnow().isoformat() + "Z",
                "vault_path": str(CONTACTS_DIR.relative_to(CONTACTS_DIR.parent.parent)),
                "count": len(contacts),
                "contacts": contacts,
            },
            f,
            indent=2,
        )

    counts: dict[str, int] = {}
    for c in contacts:
        counts[c["category"]] = counts.get(c["category"], 0) + 1
    print(f"Wrote {len(contacts)} contacts to {OUT_PATH}")
    for cat, n in sorted(counts.items()):
        print(f"  {cat:20s} {n}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
