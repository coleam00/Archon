"""Parse and validate the project-owned runtime scenario file.

A malformed scenario file is a bad invocation, not a bad verification result:
this script exits non-zero (failing the node, and the run) rather than
producing a soft verdict. The retry loop downstream retries a malformed AGENT
REPORT; it never retries a malformed project config.
"""

import json
import os
import sys


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8", newline="\n")
    sys.stderr.reconfigure(encoding="utf-8", newline="\n")

    def fail(message: str) -> int:
        print(f"read-scenario: {message}", file=sys.stderr)
        return 1

    path = os.environ.get("INPUTS_SCENARIO", "").strip()
    if not path:
        return fail("the 'scenario' input is required and was empty")

    if not os.path.isfile(path):
        return fail(f"scenario file not found: {path}")

    with open(path, "r", encoding="utf-8") as handle:
        raw = handle.read()

    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        return fail(f"scenario file is not valid JSON: {exc}")

    if not isinstance(data, dict):
        return fail("scenario file must be a JSON object")

    assertions = data.get("assertions")
    if not isinstance(assertions, list) or len(assertions) == 0:
        return fail("scenario file must declare a non-empty 'assertions' array")

    ids: list[str] = []
    descriptions: dict[str, str] = {}
    for entry in assertions:
        if not isinstance(entry, dict) or not isinstance(entry.get("id"), str) or not entry["id"].strip():
            return fail("every assertion needs a non-empty string 'id'")
        aid = entry["id"]
        if aid in ids:
            return fail(f"duplicate assertion id in scenario file: {aid}")
        ids.append(aid)
        descriptions[aid] = str(entry.get("description", ""))

    environment = data.get("environment")
    if environment is None:
        environment = {}
    if not isinstance(environment, dict):
        return fail("scenario file's 'environment' must be an object when present")

    result = {
        "setup": str(environment.get("setup", "") or ""),
        "start": str(environment.get("start", "") or ""),
        "teardown": str(environment.get("teardown", "") or ""),
        "candidate_command": str(environment.get("candidate_command", "") or "") or "git rev-parse HEAD",
        "assertion_ids": ids,
        "assertion_descriptions": descriptions,
        "assertions_json": assertions,
    }
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
