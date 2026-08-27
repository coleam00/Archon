# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""Run one targeted validation and one project validation for a concern."""

import json
import os
import subprocess

def run(cmd: str, artifact: str) -> dict:
    proc = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    with open(artifact, "w") as output:
        output.write(proc.stdout)
        output.write(proc.stderr)
    return {
        "command": cmd,
        "passed": proc.returncode == 0,
        "artifact": artifact,
    }


def main() -> int:
    implement = json.loads(os.environ["INPUTS_IMPLEMENT"])
    artifacts = os.environ["ARTIFACTS_DIR"]
    targeted = run(
        implement["test_cmd"].strip(), os.path.join(artifacts, "stabilizer-targeted.log")
    )
    project = run(
        implement["validate_cmd"].strip(), os.path.join(artifacts, "stabilizer-project.log")
    ) if targeted["passed"] else {
        "command": implement["validate_cmd"].strip(),
        "passed": False,
        "artifact": None,
        "reason": "not run because targeted validation failed",
    }
    print(json.dumps({"green": targeted["passed"] and project["passed"], "targeted": targeted, "project": project}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
