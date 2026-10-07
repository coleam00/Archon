"""Admit the product document before any planner spends on it.

A missing or empty document, or a path outside the checkout, is a bad
invocation: fail the node rather than let a planner invent a product.
"""

import json
import os
import sys
from pathlib import Path


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8", newline="\n")
    raw = os.environ.get("INPUTS_PRD", "").strip()
    if not raw:
        raise ValueError("the 'prd' input is required and was empty")
    root = Path.cwd().resolve()
    path = (root / raw).resolve() if not Path(raw).is_absolute() else Path(raw).resolve()
    if not path.is_relative_to(root):
        raise ValueError("the product document must live inside the checkout")
    if not path.is_file():
        raise ValueError(f"product document not found: {raw}")
    text = path.read_text(encoding="utf-8", errors="replace")
    if len(text.strip()) < 200:
        raise ValueError("the product document is too short to slice (under 200 characters)")
    bound = os.environ.get("INPUTS_MAX_ISSUES", "12").strip()
    if not bound.isdigit() or not 1 <= int(bound) <= 50:
        raise ValueError("max_issues must be an integer between 1 and 50")
    print(json.dumps({"path": str(path.relative_to(root)), "characters": len(text),
                      "max_issues": int(bound)}))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError) as error:
        print(f"read-prd: {error}", file=sys.stderr)
        sys.exit(1)
