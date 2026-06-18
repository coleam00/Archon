#!/usr/bin/env python3
"""
build-solutions-json.py — emit packages/web/src/lib/solutions.generated.json
from second-brain/partners/<slug>/_<slug>.md (and the flat thinksgink.md).

Walks the partners/ vault subdir, parses each entity's MOC frontmatter +
extracts the body's TL;DR (the leading >-blockquote) as the one-line description.

Output shape:
{
  "generated_at": "...",
  "vault_path": "second-brain/partners",
  "count": <n>,
  "solutions": [
    {
      "id": "medvectis", "slug": "medvectis", "name": "MedVectis",
      "category": "solution" | "partner" | "services",
      "model": "distributorship-or-services-partnership",
      "status": "active" | "exploring" | "prospect" | "dormant",
      "audience": "all" | "internal" | "partner-only" | "jason-only",
      "website": "https://...",
      "tagline": "Healthcare Revenue Intelligence...",
      "description": "<frontmatter description>",
      "keyContact": "Vlad Ljesevic / Co-Founder, MP",
      "lastTouch": "2026-06-01",
      "vaultPath": "partners/medvectis/_medvectis.md",
      "tags": [...]
    }
  ]
}

Pairs with vite.plugin.vault-solutions.ts. Mirrors the build-drive-index-json.py
+ build-contacts-json.py pattern.
"""
from __future__ import annotations
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
ARCHON_ROOT = SCRIPT_DIR.parent
PARTNERS_DIR = (ARCHON_ROOT / ".." / "second-brain" / "partners").resolve()
OUT_PATH = (ARCHON_ROOT / "packages" / "web" / "src" / "lib" / "solutions.generated.json").resolve()


def parse_frontmatter(text: str) -> tuple[dict, str]:
    if not text.startswith("---\n"):
        return {}, text
    end = text.find("\n---\n", 4)
    if end == -1:
        return {}, text
    fm_raw = text[4:end]
    body = text[end + 5:]
    fm: dict = {}
    current_list_key = None
    current_dict_key = None
    current_dict: dict = {}
    for line in fm_raw.splitlines():
        if not line.strip():
            current_list_key = None
            current_dict_key = None
            continue
        # Nested dict items: "  key: value" (2-space indent)
        if line.startswith("  ") and not line.startswith("  -") and current_dict_key:
            m = re.match(r"^\s+([a-zA-Z_][\w-]*):\s*(.*)$", line)
            if m:
                k, v = m.group(1), m.group(2).strip()
                v = v.strip('"').strip("'")
                current_dict[k] = v
                continue
        # List items under a key
        if line.startswith("  - ") and current_list_key:
            val = line[4:].strip().strip('"').strip("'")
            fm.setdefault(current_list_key, []).append(val)
            continue
        # New key:value
        m = re.match(r"^([a-zA-Z_][\w-]*):\s*(.*)$", line)
        if m:
            # Flush any pending dict
            if current_dict_key and current_dict:
                fm[current_dict_key] = current_dict
                current_dict = {}
                current_dict_key = None
            k, v = m.group(1), m.group(2).strip()
            current_list_key = None
            if v == "":
                # Could be either a list or a dict — wait to see
                current_list_key = k
                current_dict_key = k
                current_dict = {}
                continue
            if (v.startswith('"') and v.endswith('"')) or (v.startswith("'") and v.endswith("'")):
                v = v[1:-1]
            if v.startswith("[") and v.endswith("]"):
                inner = v[1:-1].strip()
                items = [i.strip().strip('"').strip("'") for i in inner.split(",") if i.strip()]
                fm[k] = items
            else:
                fm[k] = v
    # Flush trailing dict
    if current_dict_key and current_dict:
        fm[current_dict_key] = current_dict
    return fm, body


def extract_tagline(body: str) -> str:
    """Pull the first '> ...' blockquote after the H1 as the tagline."""
    in_h1 = False
    for line in body.split("\n"):
        s = line.strip()
        if s.startswith("# "):
            in_h1 = True
            continue
        if in_h1 and s.startswith(">"):
            return s.lstrip(">").strip().strip("*").strip()
    return ""


def build_solution(filepath: Path, fm: dict, body: str) -> dict[str, Any]:
    slug = fm.get("slug") or filepath.stem.lstrip("_")
    name = fm.get("name") or slug.replace("-", " ").title()
    key_contact_struct = fm.get("key_contact") or {}
    key_contact = ""
    if isinstance(key_contact_struct, dict):
        kc_name = key_contact_struct.get("name", "")
        kc_title = key_contact_struct.get("title", "")
        if kc_name and kc_title and kc_name not in ("TBD", ""):
            key_contact = f"{kc_name} / {kc_title}"
        elif kc_name and kc_name not in ("TBD", ""):
            key_contact = kc_name
    return {
        "id": slug,
        "slug": slug,
        "name": name,
        "type": fm.get("type") or "",
        "category": fm.get("category") or "",
        "model": fm.get("commercial_model") or "",
        "status": fm.get("status") or "",
        "audience": fm.get("audience") or "all",
        "website": fm.get("website") or fm.get("website_parent") or fm.get("website_alt") or "",
        "tagline": extract_tagline(body),
        "description": fm.get("description") or "",
        "keyContact": key_contact,
        "lastTouch": fm.get("last_touch") or "",
        "vaultPath": str(filepath.relative_to(PARTNERS_DIR.parent.parent)),
        "tags": fm.get("tags") or [],
    }


def main() -> int:
    if not PARTNERS_DIR.is_dir():
        print(f"FATAL: partners dir not found at {PARTNERS_DIR}", file=sys.stderr)
        return 1

    solutions: list[dict[str, Any]] = []

    # Folder-based MOCs: partners/<slug>/_<slug>.md
    for slug_dir in sorted(PARTNERS_DIR.iterdir()):
        if not slug_dir.is_dir():
            continue
        moc = slug_dir / f"_{slug_dir.name}.md"
        if not moc.exists():
            continue
        try:
            text = moc.read_text(encoding="utf-8")
        except Exception as e:
            print(f"WARN read {moc}: {e}", file=sys.stderr)
            continue
        fm, body = parse_frontmatter(text)
        if fm.get("type") not in ("solution", "partner", "services", "distributorship", None, ""):
            # Don't filter aggressively -- include anything resembling a partner
            pass
        solutions.append(build_solution(moc, fm, body))

    # Flat partners (e.g. thinksgink.md)
    for flat in sorted(PARTNERS_DIR.glob("*.md")):
        if flat.name.startswith("_"):
            continue  # skip the catalog MOC
        try:
            text = flat.read_text(encoding="utf-8")
        except OSError as e:
            print(f"WARN read {flat}: {e}", file=sys.stderr)
            continue
        fm, body = parse_frontmatter(text)
        solutions.append(build_solution(flat, fm, body))

    # Sort: active first, then exploring, then prospect, then dormant, alpha within
    status_order = {"active": 0, "exploring": 1, "prospect": 2, "dormant": 3, "": 4}
    solutions.sort(key=lambda s: (status_order.get(s["status"], 5), s["name"].lower()))

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps({
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "vault_path": "second-brain/partners",
        "count": len(solutions),
        "solutions": solutions,
    }, indent=2))

    by_status: dict[str, int] = {}
    for s in solutions:
        by_status[s["status"]] = by_status.get(s["status"], 0) + 1
    print(f"Wrote {len(solutions)} solutions to {OUT_PATH.relative_to(ARCHON_ROOT)}")
    for status, n in sorted(by_status.items()):
        print(f"  {status or '(unspecified)':15s} {n}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
