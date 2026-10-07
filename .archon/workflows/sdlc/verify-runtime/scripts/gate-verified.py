"""Publish only a completed attempt's typed verdict."""

import json
import os

verdict = os.environ["INPUTS_STATUS"]
if verdict not in ("verified", "failed", "inconclusive"):
    raise ValueError(f"unexpected terminal assessment: {verdict}")
print(json.dumps({
    "verified": verdict == "verified",
    "verdict": verdict,
    "candidate": os.environ["INPUTS_CANDIDATE"],
    "checkout": os.environ["INPUTS_CHECKOUT"],
    "directory": os.environ["INPUTS_DIRECTORY"],
    "report_path": os.environ["INPUTS_REPORT_PATH"],
    "summary": os.environ["INPUTS_REASON"],
}))
