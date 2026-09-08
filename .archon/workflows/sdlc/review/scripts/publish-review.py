"""Publish the agent's public report through the canonical marker operation."""
import json
import os
from pathlib import Path
import subprocess
import sys

verdict = json.loads(os.environ["INPUTS_VERDICT"])
target = json.loads((Path(os.environ["ARTIFACTS_DIR"]) / "review" / "publication-target.json").read_text(encoding="utf-8"))
if target is not None:
    body = (Path(os.environ["ARTIFACTS_DIR"]) / "review" / "public-report.md").read_text(encoding="utf-8")
    request = {"target": {"kind": "pr", "ref": target["ref"], "expected": target}, "marker": "<!-- archon-review-report -->", "body": body}
    command = [os.environ["ARCHON_EXECUTABLE"], *json.loads(os.environ["ARCHON_EXECUTABLE_ARGS"])]
    result = subprocess.run([*command, "forge", "comment", "upsert", "--request", "-", "--json"], input=json.dumps(request), capture_output=True, text=True, encoding="utf-8")
    sys.stderr.write(result.stderr)
    if result.returncode:
        raise RuntimeError("Review publication refused: " + result.stdout.strip())
print(json.dumps(verdict))
