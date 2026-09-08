"""Optional correction evidence from the engine's qualified checks read."""
import json
import os
import subprocess
import sys

ref = json.loads(os.environ["INPUTS_REF"])
command = [os.environ["ARCHON_EXECUTABLE"], *json.loads(os.environ["ARCHON_EXECUTABLE_ARGS"])]
result = subprocess.run([*command, "forge", "checks", "--ref", json.dumps(ref), "--json"], capture_output=True, text=True, encoding="utf-8")
sys.stderr.write(result.stderr)
if result.returncode:
    print("No CI evidence is available for this round: the engine forge read failed. Proceed on review findings alone.")
else:
    print("CI state for this pull request's currently pushed head: " + result.stdout.strip())
