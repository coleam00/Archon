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
    test_cmd = implement["test_cmd"].strip()
    validate_cmd = implement["validate_cmd"].strip()
    if not test_cmd or not validate_cmd:
        invalid = []
        if not test_cmd:
            invalid.append("test_cmd must be non-empty")
        if not validate_cmd:
            invalid.append("validate_cmd must be non-empty")
        reason = "; ".join(invalid)
        print(json.dumps({
            "green": False,
            "targeted": {
                "command": test_cmd,
                "passed": False,
                "artifact": None,
                "reason": reason,
            },
            "project": {
                "command": validate_cmd,
                "passed": False,
                "artifact": None,
                "reason": reason,
            },
        }))
        return 0

    targeted = run(test_cmd, os.path.join(artifacts, "stabilizer-targeted.log"))
    project = run(
        validate_cmd, os.path.join(artifacts, "stabilizer-project.log")
    ) if targeted["passed"] else {
        "command": validate_cmd,
        "passed": False,
        "artifact": None,
        "reason": "not run because targeted validation failed",
    }
    print(json.dumps({"green": targeted["passed"] and project["passed"], "targeted": targeted, "project": project}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
