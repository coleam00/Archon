"""Allocate fresh report storage and count attempts through engine-owned LOOP_PREV data."""

import json
import os
from pathlib import Path
import subprocess
import tempfile

attempt = int(os.environ["INPUTS_PREVIOUS_ATTEMPT"] or "0") + 1
root = Path(os.environ["ARTIFACTS_DIR"]) / "runtime-verification"
root.mkdir(parents=True, exist_ok=True)
directory = Path(tempfile.mkdtemp(prefix=f"attempt-{attempt}-", dir=root))
# This is checkout metadata only, never a fallback for the target identity probe.
checkout = subprocess.run(["git", "rev-parse", "HEAD"], capture_output=True, text=True, check=False)
print(json.dumps({
    "attempt": attempt,
    "directory": str(directory),
    "report_path": str(directory / "report.json"),
    "checkout": checkout.stdout.strip() if checkout.returncode == 0 else "",
}))
