"""Regression report. Judgment remains owned by the included agent producers."""

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


def report(artifacts):
    route_result = json.loads((artifacts / "regression-route.json").read_text(encoding="utf-8"))
    revision = os.environ["INPUTS_REVISION"]
    for phase in ("before", "checked", "after"):
        record = json.loads((artifacts / f"regression-{phase}.json").read_text(encoding="utf-8"))
        if record != {"expected": revision, "head": revision, "tracked_clean": True, "untracked": []}:
            raise ValueError(f"invalid {phase} identity evidence")
    validation = report_text(artifacts, "validation.md")
    reason = route_result["reason"]
    summary = route_result["summary"]
    discoveries = []
    if route_result["investigate"]:
        investigation = report_text(artifacts, "investigation.md")
        rooted = boolean(os.environ["INPUTS_ROOTED"], "rooted")
        summary = os.environ["INPUTS_SUMMARY"].strip()
        if not summary or summary == "null":
            raise ValueError("investigation has no summary")
        reason = "reproduced_defect" if rooted else "unrooted"
        if rooted:
            discoveries.append({
                "title": "Reproduced check defect",
                "claim": summary,
                "evidence": f"Revision: {revision}\n\n{validation}\n\n{investigation}",
                "relation": "adjacent",
                "source_node": "investigate__investigate",
            })
    status = ("healthy" if reason == "checks_passed" else
              "regression" if reason == "reproduced_defect" else "inconclusive")
    # This run owns one raw producer sidecar. No tracking IDs or dedup state:
    # publication and cross-run consolidation belong to archon-discoveries.
    sidecar = artifacts / "discoveries" / "regress.json"
    write_json(sidecar, discoveries)
    result = {"status": status, "reason": reason, "revision": revision,
              "checks_performed": route_result["checks_performed"],
              "summary": summary, "discovery": str(sidecar)}
    write_json(artifacts / "regression.json", result)
    (artifacts / "regression.md").write_text(
        f"# Regression diagnosis\n\nStatus: {status}\nReason: {reason}\n"
        f"Revision before and after: {revision}\n\n{summary}\n\n"
        "Evidence: validation.md, regression-before.json, regression-checked.json, "
        "regression-after.json.\n"
        + ("Investigation: investigation.md.\n" if route_result["investigate"] else "")
        + f"Discovery sidecar: {sidecar}\n\n"
        "Ordinary checks only. Runtime verification was not performed.\n"
        "No tracker publication was performed.\n",
        encoding="utf-8",
    )
    return result


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", newline="\n")
    print(json.dumps(report(Path(os.environ["ARTIFACTS_DIR"]))))
