#!/usr/bin/env python3
"""
build-drive-index-json.py — vault-driven-dashboard build script for the Drive
index tab. Walks second-brain/resources/drive-index/*.md, parses frontmatter
and the rendered Drive table body, emits packages/web/src/lib/drive-index.generated.json.

Mirrors scripts/build-contacts-json.py exactly in shape so vite.plugin.vault-drive-index.ts
can debounce-rebuild on vault file changes (Drive snapshot cron writes those files
hourly; this script repackages them for the dashboard route).

Output shape:
{
  "generated_at": "...",
  "vault_path": "second-brain/resources/drive-index",
  "count": <folder count>,
  "folders": [
    {
      "id": "<slug>",
      "slug": "<slug>",
      "name": "Lead Lists & Apollo Imports",
      "folderId": "<google drive folder id>",
      "parentId": "<google drive parent folder id>",
      "audience": "all" | "internal" | "partner-only" | "jason-only",
      "lastSynced": "2026-06-01T19:45:00Z",
      "fileCount": 23,
      "vaultPath": "resources/drive-index/lead-lists-apollo-imports.md",
      "driveUrl": "https://drive.google.com/drive/folders/<id>",
      "files": [
        { "name": "...", "type": "g-document", "modified": "2026-05-20", "size": "12KB", "link": "https://..." },
        ...
      ]
    }
  ]
}
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
DRIVE_DIR = (ARCHON_ROOT / ".." / "second-brain" / "resources" / "drive-index").resolve()
OUT_PATH = (ARCHON_ROOT / "packages" / "web" / "src" / "lib" / "drive-index.generated.json").resolve()

# Folder name -> audience default if frontmatter is missing
DEFAULT_AUDIENCE = "all"


def parse_frontmatter(text: str) -> tuple[dict, str]:
    """Tiny YAML-ish parser. Matches build-contacts-json.py conventions."""
    if not text.startswith("---\n"):
        return {}, text
    end = text.find("\n---\n", 4)
    if end == -1:
        return {}, text
    fm_raw = text[4:end]
    body = text[end + 5:]

    fm: dict = {}
    current_list_key = None
    for line in fm_raw.splitlines():
        if not line.strip():
            current_list_key = None
            continue
        if line.startswith("  - ") and current_list_key:
            val = line[4:].strip().strip('"').strip("'")
            fm.setdefault(current_list_key, []).append(val)
            continue
        m = re.match(r"^([a-zA-Z_][\w-]*):\s*(.*)$", line)
        if m:
            k, v = m.group(1), m.group(2).strip()
            current_list_key = None
            if v == "":
                current_list_key = k
                continue
            if (v.startswith('"') and v.endswith('"')) or (v.startswith("'") and v.endswith("'")):
                v = v[1:-1]
            if v.startswith("[") and v.endswith("]"):
                inner = v[1:-1].strip()
                items = [i.strip().strip('"').strip("'") for i in inner.split(",") if i.strip()]
                fm[k] = items
            else:
                fm[k] = v
    return fm, body


def parse_file_table(body: str) -> list[dict[str, str]]:
    """Pull rows out of the markdown table the snapshot script writes.

    Table header is:
      | Name | Type | Modified | Size | Link |
      |---|---|---|---|---|

    Each data row: | name | type | YYYY-MM-DD | size | [open](url) |
    """
    out: list[dict[str, str]] = []
    lines = body.split("\n")
    in_table = False
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("| Name |"):
            in_table = True
            continue
        if in_table and stripped.startswith("|---"):
            continue
        if in_table:
            if not stripped.startswith("|"):
                in_table = False
                continue
            cells = [c.strip() for c in stripped.strip("|").split("|")]
            if len(cells) < 5:
                continue
            name, ftype, modified, size, link_md = cells[0], cells[1], cells[2], cells[3], cells[4]
            link = ""
            m = re.search(r"\((https?://[^\s)]+)\)", link_md)
            if m:
                link = m.group(1)
            out.append({
                "name": name.replace("\\|", "|"),
                "type": ftype,
                "modified": modified,
                "size": size,
                "link": link,
            })
    return out


def build_folder(md_path: Path, fm: dict, body: str) -> dict[str, Any]:
    slug = md_path.stem.lstrip("_") or "root"
    folder_id = fm.get("folder_id", "")
    parent_id = fm.get("parent_id", "")
    drive_url = f"https://drive.google.com/drive/folders/{folder_id}" if folder_id else ""

    files = parse_file_table(body)

    return {
        "id": slug,
        "slug": slug,
        "name": fm.get("folder_name") or slug.replace("-", " ").title(),
        "folderId": folder_id,
        "parentId": parent_id,
        "audience": fm.get("audience") or DEFAULT_AUDIENCE,
        "lastSynced": fm.get("last_synced") or "",
        "fileCount": int(fm.get("file_count") or len(files)),
        "vaultPath": str(md_path.relative_to(DRIVE_DIR.parent.parent.parent)),
        "driveUrl": drive_url,
        "files": files,
    }


def main() -> int:
    if not DRIVE_DIR.is_dir():
        print(f"FATAL: drive-index dir not found at {DRIVE_DIR}", file=sys.stderr)
        # Still write an empty JSON so the UI renders an empty state, not a 404
        OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
        OUT_PATH.write_text(json.dumps({
            "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "vault_path": "second-brain/resources/drive-index",
            "count": 0,
            "folders": [],
            "error": f"vault dir not found: {DRIVE_DIR}",
        }, indent=2))
        return 0

    folders: list[dict[str, Any]] = []
    for md_path in sorted(DRIVE_DIR.glob("*.md")):
        try:
            text = md_path.read_text(encoding="utf-8")
        except Exception as e:
            print(f"WARN read {md_path}: {e}", file=sys.stderr)
            continue
        fm, body = parse_frontmatter(text)
        if fm.get("type") != "drive-index":
            # Skip MOC files etc.
            continue
        folders.append(build_folder(md_path, fm, body))

    # Root file ("_root.md") sorts to the top; others alphabetical by name
    folders.sort(key=lambda f: (0 if f["id"] == "root" else 1, f["name"].lower()))

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps({
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "vault_path": "second-brain/resources/drive-index",
        "count": len(folders),
        "folders": folders,
    }, indent=2))

    total_files = sum(f["fileCount"] for f in folders)
    print(f"Wrote {len(folders)} folders, {total_files} files to {OUT_PATH.relative_to(ARCHON_ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
