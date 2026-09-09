"""Validate the slice before anything is published, and render it for review.

Shape, unique keys, dependencies that point only backwards, the bound, and the
factory's one structural rule (the first ticket depends on nothing) are checked
here deterministically. Whether the tickets are good is the planner's judgment
and the reader's; this script only refuses a slice no publisher should act on.
"""

import json
import os
import re
import sys
from pathlib import Path

SIZES = ("small_bounded", "risky", "large")
KEY = re.compile(r"^[a-z0-9][a-z0-9-]{1,60}$")


def fail(message: str) -> None:
    print(f"check-backlog: {message}", file=sys.stderr)
    sys.exit(1)


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8", newline="\n")
    artifacts = Path(os.environ["ARTIFACTS_DIR"])
    bound = int(os.environ["INPUTS_MAX_ISSUES"])
    path = artifacts / "backlog.json"
    if not path.is_file():
        fail("the planner wrote no backlog.json")
    try:
        tickets = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        fail(f"backlog.json is not valid JSON: {error}")
    if not isinstance(tickets, list):
        fail("backlog.json must be an array")
    if not tickets:
        # Nothing the tracker does not already carry is a fact, not a failure:
        # the planner said so in its summary, and the publisher has nothing to do.
        print(json.dumps({"count": 0, "keys": []}))
        return 0
    if len(tickets) > bound:
        fail(f"{len(tickets)} tickets exceed the bound of {bound}")
    seen: list[str] = []
    for index, ticket in enumerate(tickets):
        if not isinstance(ticket, dict):
            fail(f"ticket {index} is not an object")
        for field in ("key", "title", "phase", "body"):
            value = ticket.get(field)
            if not isinstance(value, str) or not value.strip():
                fail(f"ticket {index} needs a non-empty string '{field}'")
        key = ticket["key"]
        if not KEY.match(key):
            fail(f"ticket {index} key '{key}' must be a lowercase slug")
        if key in seen:
            fail(f"duplicate key '{key}'")
        deps = ticket.get("depends_on", [])
        if not isinstance(deps, list) or any(not isinstance(d, str) for d in deps):
            fail(f"ticket '{key}' depends_on must be an array of keys")
        for dep in deps:
            if dep not in seen:
                fail(f"ticket '{key}' depends on '{dep}', which is not an earlier ticket")
        if index == 0 and deps:
            fail("the first ticket must depend on nothing")
        if ticket.get("size") not in SIZES:
            fail(f"ticket '{key}' size must be one of {', '.join(SIZES)}")
        if len(ticket["body"]) < 120:
            fail(f"ticket '{key}' body is too short to be a contract")
        seen.append(key)
    lines = ["# Backlog", "", f"{len(tickets)} tickets, in build order.", ""]
    for index, ticket in enumerate(tickets, 1):
        deps = ", ".join(ticket.get("depends_on", [])) or "none"
        lines += [f"## {index}. {ticket['title']}", "",
                  f"- key: `{ticket['key']}`  phase: {ticket['phase']}  size: {ticket['size']}  depends on: {deps}",
                  "", ticket["body"].strip(), ""]
    (artifacts / "backlog.md").write_text("\n".join(lines), encoding="utf-8")
    print(json.dumps({"count": len(tickets), "keys": seen}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
