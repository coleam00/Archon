"""Verify every evidence citation revalidate wrote against the current HEAD tree.

Bound inputs (`with:` bindings, canonical text in env):
- INPUTS_REVALIDATION: revalidate's full declared array (JSON text), delivered
  through node-output wiring rather than a file - revalidate is an agent node
  and every fixture stubs agent nodes, so a custom file it "would have
  written" would never exist in a fixture run. Reading it as a bound value
  instead means the same script path runs identically whether revalidate ran
  for real or was stubbed.

Unknown or missing evidence must not become proved new work: an entry the
model marked still valid but whose citations do not resolve against the
actual current repository gets overridden here, not trusted. This is the
deterministic half of the interpret-then-validate boundary - revalidate
interprets prose into typed citations, this verifies the citations against
reality using `git cat-file`, no natural-language parsing of its own.
"""

import json
import os
import subprocess
import sys


def fail(message: str) -> None:
    print(message, file=sys.stderr)
    sys.exit(1)


def read_json_array(path: str, label: str) -> list:
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except OSError as err:
        fail(f"check-evidence: could not read {label} ({err}).")
    except ValueError as err:
        fail(f"check-evidence: {label} is not valid JSON ({err}).")
    if not isinstance(data, list):
        fail(f"check-evidence: {label} must be a JSON array.")
    return data


def parse_json_array_env(name: str, label: str) -> list:
    raw = os.environ.get(name, "")
    try:
        data = json.loads(raw) if raw else []
    except ValueError as err:
        fail(f"check-evidence: {label} is not valid JSON ({err}).")
    if not isinstance(data, list):
        fail(f"check-evidence: {label} must be a JSON array.")
    return data


def line_count(path: str) -> int:
    """Lines in `path` at HEAD, or -1 when the blob cannot be read."""
    try:
        result = subprocess.run(
            ["git", "show", f"HEAD:{path}"],
            capture_output=True,
            timeout=10,
        )
    except (OSError, subprocess.TimeoutExpired):
        return -1
    if result.returncode != 0:
        return -1
    return result.stdout.count(b"\n") + (1 if result.stdout and not result.stdout.endswith(b"\n") else 0)


def path_exists_at_head(path: str) -> bool:
    try:
        result = subprocess.run(
            ["git", "cat-file", "-e", f"HEAD:{path}"],
            capture_output=True,
            timeout=10,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    return result.returncode == 0


def evidence_status(refs: object) -> tuple:
    """(status, reason) for one entry's evidence_refs."""
    if not isinstance(refs, list) or not refs:
        return "unsupported", "no evidence_refs were cited"
    for ref in refs:
        if not isinstance(ref, dict):
            continue
        path = ref.get("path")
        line = ref.get("line")
        if not isinstance(path, str) or not path or not isinstance(line, int):
            continue
        if not path_exists_at_head(path):
            continue
        total = line_count(path)
        if total >= 0 and 1 <= line <= total:
            return "verified", ""
    return "unsupported", "no cited path:line resolved against the current HEAD tree"


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8", newline="\n")
    sys.stderr.reconfigure(encoding="utf-8", newline="\n")
    artifacts = os.environ["ARTIFACTS_DIR"]

    normalized = read_json_array(
        os.path.join(artifacts, "discoveries", "normalized.json"), "discoveries/normalized.json"
    )
    revalidation = parse_json_array_env("INPUTS_REVALIDATION", "revalidate's output")

    expected_indices = {entry.get("item_index") for entry in normalized if isinstance(entry, dict)}
    by_index = {
        entry.get("item_index"): entry for entry in revalidation if isinstance(entry, dict)
    }
    if set(by_index.keys()) != expected_indices:
        fail(
            "check-evidence: revalidate's output does not cover the same item_index set as "
            f"discoveries/normalized.json (expected {sorted(expected_indices)}, got "
            f"{sorted(by_index.keys())}). revalidate must declare exactly one entry per input entry."
        )

    checked = []
    overridden_count = 0
    for index in sorted(expected_indices):
        entry = by_index[index]
        claimed_valid = bool(entry.get("still_valid"))
        evidence_refs = entry.get("evidence_refs") if isinstance(entry.get("evidence_refs"), list) else []
        status, reason = evidence_status(evidence_refs)
        final_valid = claimed_valid and status == "verified"
        if claimed_valid and not final_valid:
            overridden_count += 1
        checked.append(
            {
                "item_index": index,
                "evidence_status": status,
                "still_valid": final_valid,
                "reason": reason,
                "evidence_refs": evidence_refs,
            }
        )

    with open(
        os.path.join(artifacts, "evidence-check.json"), "w", encoding="utf-8", newline="\n"
    ) as f:
        json.dump(checked, f, indent=2)

    print(json.dumps({"count": len(checked), "overridden_count": overridden_count}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
