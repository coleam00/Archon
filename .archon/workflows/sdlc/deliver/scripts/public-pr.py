"""Bind delivery publication to the recorded PR and the checked-out commit."""
import json
import os
import subprocess
import sys


def forge(*args, request=None):
    command = [os.environ["ARCHON_EXECUTABLE"], *json.loads(os.environ["ARCHON_EXECUTABLE_ARGS"])]
    result = subprocess.run([*command, "forge", *args, "--json", *(["--request", "-"] if request is not None else [])], input=json.dumps(request) if request is not None else None, capture_output=True, text=True, encoding="utf-8")
    sys.stderr.write(result.stderr)
    if result.returncode:
        raise RuntimeError("Forge publication refused: " + result.stdout.strip())
    return json.loads(result.stdout)


def git(*args):
    result = subprocess.run(["git", *args], capture_output=True, text=True, encoding="utf-8")
    if result.returncode:
        raise RuntimeError("Cannot verify delivery checkout")
    return result.stdout.strip()


pr = json.loads(os.environ["INPUTS_PR"])
expected = {key: pr[key] for key in ("head_repo", "head", "base")}
expected["head_sha"] = git("rev-parse", "HEAD")
if git("branch", "--show-current") != pr["head"]:
    raise RuntimeError("Delivery checkout changed branch")
operation = os.environ["INPUTS_OPERATION"]
request = {"ref": pr["ref"], "expected": expected}
if operation == "edit-body":
    request["body"] = os.environ["INPUTS_BODY"]
elif operation == "ready":
    verdict = forge("checks", "--ref", json.dumps(pr["ref"]))
    if verdict["head_sha"] != expected["head_sha"] or verdict.get("required", verdict)["state"] not in ("green", "none"):
        raise RuntimeError("Ready refused: checks are not green for the checked-out head")
else:
    raise RuntimeError("Unsupported delivery publication operation")
result = forge("pr", operation, request=request)
print(result["url"] if operation == "ready" else json.dumps(result))
