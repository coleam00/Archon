"""Regression route. Judgment remains owned by the included agent producers."""

import json
import os
from pathlib import Path
import sys


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def boolean(value, name):
    if value not in ("true", "false"):
        raise ValueError(f"{name} must be a boolean")
    return value == "true"


def report_text(artifacts, name):
    text = (artifacts / name).read_text(encoding="utf-8").strip()
    if not text:
        raise ValueError(f"missing evidence: {name} is empty")
    return text


def route(artifacts):
    green = boolean(os.environ["INPUTS_GREEN"], "green")
    performed = boolean(os.environ["INPUTS_CHECKS_PERFORMED"], "checks_performed")
    cause = os.environ["INPUTS_RED_CAUSE"]
    summary = os.environ["INPUTS_SUMMARY"].strip()
    report_text(artifacts, "validation.md")
    if not summary or (green and cause):
        raise ValueError("validation verdict is inconsistent or has no summary")
    if green:
        reason = "checks_passed" if performed else "no_checks"
    elif not performed or cause == "environment":
        reason = "infrastructure"
    elif cause in ("introduced", "inherited"):
        reason = "investigate"
    else:
        reason = "unclassified_failure"
    result = {"investigate": reason == "investigate", "reason": reason,
              "checks_performed": performed, "summary": summary}
    write_json(artifacts / "regression-route.json", result)
    return result


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", newline="\n")
    print(json.dumps(route(Path(os.environ["ARTIFACTS_DIR"]))))
