"""Check exact report invariants. Observation truth and assessment remain model judgments."""

import json
import os
from pathlib import Path


def assess():
    def result(status, reason, candidate=""):
        return {"status": status, "reason": reason, "candidate": candidate}

    if os.environ["INPUTS_START_OK"] != "true":
        return result("inconclusive", "environment setup or start failed; see node logs")
    directory = Path(os.environ["INPUTS_DIRECTORY"]).resolve()
    if os.environ["INPUTS_IDENTITY_OK"] != "true":
        return result("inconclusive", "target identity probe failed; see identity-run logs")
    candidate = (directory / "target.txt").read_text(encoding="utf-8").strip()
    if not candidate:
        return result("inconclusive", "target identity probe returned no identity")
    expected = os.environ["INPUTS_EXPECTED_CANDIDATE"].strip()
    if expected and candidate != expected:
        return result("inconclusive", "target identity does not match the requested candidate", candidate)

    def malformed(reason):
        return result("malformed", reason, candidate)

    try:
        report = json.loads(Path(os.environ["INPUTS_REPORT_PATH"]).read_text(encoding="utf-8"))
    except (FileNotFoundError, UnicodeError, json.JSONDecodeError):
        return malformed("report is missing or is not valid UTF-8 JSON")
    if not isinstance(report, dict):
        return malformed("report must be an object")
    if report.get("candidate") != candidate:
        return malformed("reported candidate does not match the target probe")
    assertions = report.get("assertions")
    if not isinstance(assertions, list) or not assertions:
        return malformed("report must contain assertions")
    required = json.loads(os.environ["INPUTS_REQUIRED_IDS"])
    seen = set()
    for entry in assertions:
        if not isinstance(entry, dict):
            return malformed("assertion must be an object")
        aid = entry.get("id")
        if not isinstance(aid, str) or aid not in required or aid in seen:
            return malformed("assertion ids must match the scenario exactly, without duplicates")
        seen.add(aid)
        if entry.get("outcome") not in ("passed", "failed", "inconclusive"):
            return malformed(f"assertion '{aid}' needs a declared outcome")
        # JSON false, true, zero and null can all be measured values. No prose stoplist.
        if "observed" not in entry or "expected" not in entry:
            return malformed(f"assertion '{aid}' needs expected and observed values")
        if not isinstance(entry.get("reason"), str) or not entry["reason"].strip():
            return malformed(f"assertion '{aid}' needs an assessment reason")
        evidence = entry.get("evidence_path")
        if not isinstance(evidence, str) or not evidence.strip():
            return malformed(f"assertion '{aid}' needs an evidence path")
        path = Path(evidence)
        path = (directory / path).resolve() if not path.is_absolute() else path.resolve()
        if not path.is_relative_to(directory):
            return malformed(f"assertion '{aid}' evidence is outside this attempt")
        if not path.is_file() or path.stat().st_size == 0:
            return malformed(f"assertion '{aid}' evidence is missing or empty")
    if seen != set(required):
        return malformed("report is missing required assertion coverage")
    if any(entry["outcome"] == "inconclusive" for entry in assertions):
        return result("inconclusive", "one or more assertions could not be assessed", candidate)
    failed = [entry["id"] for entry in assertions if entry["outcome"] == "failed"]
    if failed:
        return result("failed", f"assertions did not pass: {', '.join(failed)}", candidate)
    return result(
        "verified",
        "all declared assertions assessed as passed; report structure and target identity checked",
        candidate,
    )


if __name__ == "__main__":
    print(json.dumps(assess()))
