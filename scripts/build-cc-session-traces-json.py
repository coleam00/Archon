#!/usr/bin/env python3
"""Build agent-trace JSON for the Archon AgentTracePage.

Scans Claude Code session-exports (JSONL one record per turn) and emits a
compact roll-up the static dashboard can render without a backend.

Per Greg Queue B 2026-06-11 decisions (D2 = session-exports cron to generated
trace JSON; D3 = head+tail transcript drill-down only, NOT full transcript):
  - source: jid5274/session-exports/<workspace-slug>/*.jsonl
  - drill-down: first 5 + last 5 user/assistant turns per session (PII guard)
  - no full-transcript field; no tool-result bodies; no system-prompt echoes

Output: packages/web/src/lib/traces.generated.json

Contract (frozen 2026-06-12):
  {
    "generated_at": "ISO-8601",
    "source": "jid5274/session-exports/**/*.jsonl",
    "session_count": int,
    "turn_count": int,
    "sessions": [
      {
        "session_id": str,            # uuid from filename
        "workspace": str,             # decoded workspace path
        "started_at": "ISO-8601",     # earliest turn ts
        "ended_at": "ISO-8601",       # latest turn ts
        "turn_count": int,
        "user_turn_count": int,
        "assistant_turn_count": int,
        "first_prompt_preview": str,  # first user turn, <=240 chars
        "last_activity_preview": str, # last assistant/user, <=240 chars
        "head_turns": [               # first 5 user+assistant turns
          {"role": "user"|"assistant", "ts": "ISO-8601", "preview": str}
        ],
        "tail_turns": [...],          # last 5 user+assistant turns (deduped if overlap)
      },
      ...
    ]
  }

Privacy guards (D3):
  - turn preview hard-capped at 240 chars
  - tool calls / tool results not included
  - memory / credentials patterns redacted (Bearer tokens, sk-..., AWS keys)
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
JID_ROOT = ARCHON_ROOT.parent
EXPORTS_DIR = JID_ROOT / "session-exports"
OUT_PATH = ARCHON_ROOT / "packages" / "web" / "src" / "lib" / "cc-session-traces.generated.json"

PREVIEW_LIMIT = 240
HEAD_TAIL_N = 5

# Secret-scrub patterns. Replaced with literal "[redacted]" before truncation.
SECRET_PATTERNS = [
    re.compile(r"sk-[A-Za-z0-9]{20,}"),
    re.compile(r"Bearer\s+[A-Za-z0-9._-]{20,}"),
    re.compile(r"AKIA[0-9A-Z]{16}"),
    re.compile(r"ghp_[A-Za-z0-9]{30,}"),
    re.compile(r"xox[baprs]-[A-Za-z0-9-]{20,}"),
]


def decode_workspace(slug: str) -> str:
    """Convert '-Users-jason-Desktop-jid5274' → '/Users/jason/Desktop/jid5274'."""
    if not slug.startswith("-"):
        return slug
    # Single dash → /, double dash (literal) preserved as a single dash in path.
    # Iterate carefully to keep the encoding readable.
    body = slug[1:]
    return "/" + body.replace("--", "\x00").replace("-", "/").replace("\x00", "-")


def scrub(text: str) -> str:
    for pat in SECRET_PATTERNS:
        text = pat.sub("[redacted]", text)
    return text


def extract_text(msg: Any) -> str:
    """Pull plain text out of a Claude Code message record. Returns '' on no text."""
    if msg is None:
        return ""
    if isinstance(msg, str):
        return msg
    if isinstance(msg, dict):
        content = msg.get("content")
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            chunks: list[str] = []
            for c in content:
                if isinstance(c, dict):
                    if c.get("type") == "text":
                        t = c.get("text")
                        if isinstance(t, str):
                            chunks.append(t)
                    # Skip tool_use / tool_result blocks per D3 (no tool bodies).
                elif isinstance(c, str):
                    chunks.append(c)
            return "\n".join(chunks)
    return ""


def preview(text: str) -> str:
    text = scrub(text).strip()
    # Collapse runs of whitespace so the preview reads cleanly in the UI.
    text = re.sub(r"\s+", " ", text)
    if len(text) > PREVIEW_LIMIT:
        return text[: PREVIEW_LIMIT - 1].rstrip() + "…"
    return text


def parse_session_file(path: Path) -> dict[str, Any] | None:
    """Return roll-up dict for one .jsonl, or None if it has no user/assistant turns."""
    turns: list[dict[str, Any]] = []
    earliest: str | None = None
    latest: str | None = None
    with path.open() as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            t = rec.get("type")
            if t not in ("user", "assistant"):
                continue
            ts = rec.get("timestamp")
            text = extract_text(rec.get("message"))
            if not text:
                continue
            turn = {"role": t, "ts": ts, "preview": preview(text)}
            turns.append(turn)
            if ts:
                if earliest is None or ts < earliest:
                    earliest = ts
                if latest is None or ts > latest:
                    latest = ts
    if not turns:
        return None

    user_turns = [t for t in turns if t["role"] == "user"]
    assistant_turns = [t for t in turns if t["role"] == "assistant"]

    head = turns[:HEAD_TAIL_N]
    tail = turns[-HEAD_TAIL_N:]
    # Dedup overlap when session is short.
    if len(turns) < HEAD_TAIL_N * 2:
        tail = []

    return {
        "session_id": path.stem,
        "workspace": decode_workspace(path.parent.name),
        "started_at": earliest,
        "ended_at": latest,
        "turn_count": len(turns),
        "user_turn_count": len(user_turns),
        "assistant_turn_count": len(assistant_turns),
        "first_prompt_preview": user_turns[0]["preview"] if user_turns else "",
        "last_activity_preview": turns[-1]["preview"],
        "head_turns": head,
        "tail_turns": tail,
    }


def main() -> int:
    if not EXPORTS_DIR.exists():
        print(f"[build-cc-session-traces] no session-exports dir at {EXPORTS_DIR}", file=sys.stderr)
        out = {
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "source": "jid5274/session-exports/**/*.jsonl",
            "session_count": 0,
            "turn_count": 0,
            "sessions": [],
        }
        OUT_PATH.write_text(json.dumps(out, indent=2) + "\n")
        return 0

    sessions: list[dict[str, Any]] = []
    total_turns = 0
    for jsonl in sorted(EXPORTS_DIR.glob("*/*.jsonl")):
        rolled = parse_session_file(jsonl)
        if rolled is None:
            continue
        sessions.append(rolled)
        total_turns += rolled["turn_count"]

    # Most recent first (by ended_at).
    sessions.sort(key=lambda s: s.get("ended_at") or "", reverse=True)

    out = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source": "jid5274/session-exports/**/*.jsonl",
        "session_count": len(sessions),
        "turn_count": total_turns,
        "sessions": sessions,
    }
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(out, indent=2) + "\n")
    print(
        f"[build-cc-session-traces] wrote {OUT_PATH.relative_to(ARCHON_ROOT)} "
        f"({len(sessions)} sessions, {total_turns} turns)",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
