"""Admit the complete finite case set before any runtime agent can spend."""

import json
import os
from pathlib import Path
import sys


def read_manifest():
    path = Path(os.environ["INPUTS_MANIFEST"]).resolve(strict=True)
    manifest = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(manifest, dict):
        raise ValueError("manifest must be an object")
    cases = manifest.get("cases")
    if not isinstance(cases, list) or not 2 <= len(cases) <= 16:
        raise ValueError("manifest must contain 2 to 16 cases")
    ids = set()
    for case in cases:
        if not isinstance(case, dict):
            raise ValueError("each case must be an object")
        for key in ("id", "candidate", "scenario"):
            value = case.get(key)
            if not isinstance(value, str) or not value or value != value.strip() or "\0" in value:
                raise ValueError(f"case {key} must be a nonempty canonical string (no surrounding whitespace or NUL)")
        if case["id"] in ids:
            raise ValueError(f"duplicate case id: {case['id']}")
        ids.add(case["id"])
        if case.get("expected_verdict") not in ("verified", "failed"):
            raise ValueError("expected_verdict must be verified or failed")
        scenario = (path.parent / case["scenario"]).resolve(strict=True)
        if not scenario.is_file():
            raise ValueError(f"scenario must be a file: {scenario}")
        case["scenario"] = str(scenario)
    baseline = manifest.get("baseline")
    if not isinstance(baseline, str) or baseline not in ids:
        raise ValueError("baseline must name a configured healthy control")
    if next(case for case in cases if case["id"] == baseline)["expected_verdict"] != "verified":
        raise ValueError("baseline must expect verified")
    if not any(case["expected_verdict"] == "failed" for case in cases):
        raise ValueError("manifest must include a deliberate expected-failed control")
    return {"baseline": baseline, "cases": cases, "scenarios": [case["scenario"] for case in cases]}


if __name__ == "__main__":
    try:
        print(json.dumps(read_manifest()))
    except (OSError, ValueError) as error:
        print(f"read-manifest: {error}", file=sys.stderr)
        sys.exit(1)
