"""Resolve once through the engine; downstream probes retain this repository."""
import json
import os
import subprocess
import sys

command = [os.environ["ARCHON_EXECUTABLE"], *json.loads(os.environ["ARCHON_EXECUTABLE_ARGS"])]
result = subprocess.run([*command, "forge", "resolve", "--json"], capture_output=True, text=True, encoding="utf-8")
sys.stderr.write(result.stderr)
if result.returncode:
    raise RuntimeError("Forge resolution failed: " + result.stdout.strip())
resolved = json.loads(result.stdout)
if resolved["forge"] == "none":
    raise RuntimeError("Deliver CI checks require a configured forge for this repository")
print(json.dumps(resolved["repo"]))
