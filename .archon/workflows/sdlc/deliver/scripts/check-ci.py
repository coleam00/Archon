"""Read the engine's checks verdict for the run's qualified PR, once."""
import json
import os
import subprocess
import sys
import time


def forge(*args):
    command = [os.environ["ARCHON_EXECUTABLE"], *json.loads(os.environ["ARCHON_EXECUTABLE_ARGS"])]
    result = subprocess.run([*command, "forge", *args, "--json"], capture_output=True, text=True, encoding="utf-8")
    # The engine's existing subprocess transcript retains each op's audit record.
    sys.stderr.write(result.stderr)
    if result.returncode:
        raise RuntimeError("Engine forge read failed: " + result.stdout.strip())
    return json.loads(result.stdout)


def main():
    ref = json.loads(os.environ["INPUTS_REF"])
    verdict = forge("checks", "--ref", json.dumps(ref))
    if verdict["state"] == "none":
        time.sleep(60)
        verdict = forge("checks", "--ref", json.dumps(ref))
    state = verdict.get("required", verdict)["state"]
    if state == "none":
        detail = "No check units were reported after registration grace; this is not a green verdict."
    else:
        detail = json.dumps(verdict, ensure_ascii=False)
    # Workflow policy remains here. Unknown and manual gates never become green.
    workflow_state = "pending" if state == "pending" else "concluded" if state in ("green", "none") else "red"
    print(json.dumps({"state": workflow_state, "detail": detail}))


if __name__ == "__main__":
    main()
