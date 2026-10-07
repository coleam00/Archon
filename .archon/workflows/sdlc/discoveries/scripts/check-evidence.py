"""Check citation bounds at the pinned revision, without judging claim truth."""

import json
import os
import subprocess
import sys
from pathlib import PurePosixPath, PureWindowsPath

VERDICTS = ("supported", "disproved", "inconclusive")

def fail(message):
    print(message, file=sys.stderr)
    sys.exit(1)


def citation_status(refs, revision):
    if not refs:
        return "unverified"
    for ref in refs:
        path, line = ref["path"], ref["line"]
        if (not path or PurePosixPath(path).is_absolute() or PureWindowsPath(path).drive
                or "\\" in path or any(ord(c) < 32 for c in path)
                or any(p in (".", "..", "") for p in path.split("/"))
                or type(line) is not int or line < 1):
            return "unverified"
        tree = subprocess.run(["git", "ls-tree", "-z", revision, "--", path], capture_output=True)
        if tree.returncode != 0 or tree.stdout.split(b" ", 1)[0] not in (b"100644", b"100755"):
            return "unverified"
        result = subprocess.run(["git", "show", f"{revision}:{path}"], capture_output=True)
        if result.returncode != 0 or line > len(result.stdout.splitlines()):
            return "unverified"
    return "source-bound"


def main():
    sys.stdout.reconfigure(encoding="utf-8", newline="\n")
    sys.stderr.reconfigure(encoding="utf-8", newline="\n")
    directory = os.path.join(os.environ["ARTIFACTS_DIR"], "discoveries")
    with open(os.path.join(directory, "context.json"), encoding="utf-8") as f:
        context = json.load(f)
    with open(os.path.join(directory, "normalized.json"), encoding="utf-8") as f:
        normalized = json.load(f)
    try:
        entries = json.loads(os.environ["INPUTS_REVALIDATION"])
    except (KeyError, ValueError):
        fail("check-evidence: revalidation must be a JSON array.")
    if (not isinstance(entries, list) or len(entries) != len(normalized)
            or any(not isinstance(e, dict) or type(e.get("item_index")) is not int for e in entries)
            or sorted(e["item_index"] for e in entries) != list(range(len(normalized)))):
        fail("check-evidence: expected exactly one revalidation per input item.")
    head = subprocess.run(["git", "rev-parse", "HEAD"], capture_output=True, text=True)
    if head.returncode != 0 or head.stdout.strip() != context["revision"]:
        fail("check-evidence: source revision moved after input resolution; revalidate again.")
    checked = []
    for entry in entries:
        refs = entry.get("evidence_refs")
        if (entry.get("verdict") not in VERDICTS
                or not isinstance(entry.get("note"), str)
                or not isinstance(refs, list) or any(
                    not isinstance(ref, dict) or not isinstance(ref.get("path"), str)
                    or type(ref.get("line")) is not int for ref in refs)):
            fail("check-evidence: invalid revalidation or citation shape.")
        status = citation_status(refs, context["revision"])
        checked.append({**entry, "evidence_status": status})
    with open(os.path.join(os.environ["ARTIFACTS_DIR"], "evidence-check.json"), "w", encoding="utf-8") as f:
        json.dump(checked, f, indent=2)
    print(json.dumps({"count": len(checked),
                      "unverified_count": sum(e["evidence_status"] == "unverified" for e in checked)}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
