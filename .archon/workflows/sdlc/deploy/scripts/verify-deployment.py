"""Decide whether the deployment happened, from read-back rather than exit codes.

deployed is true only when the deploy command succeeded, the health command
passed, and (when an identity command is configured) the running service reports
exactly the resolved revision. The record is written to deployment.md so the
verdict survives the run.
"""

import json
import os
import subprocess
import sys
from pathlib import Path


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8", newline="\n")
    revision = os.environ["INPUTS_REVISION"].strip()
    branch = os.environ["INPUTS_BRANCH"].strip()
    identity = os.environ.get("INPUTS_IDENTITY", "").strip()
    deploy_ok = os.environ["INPUTS_DEPLOY_OK"] == "true"
    health_ok = os.environ["INPUTS_HEALTH_OK"] == "true"
    observed = ""
    if not deploy_ok:
        deployed, summary = False, "the deploy command failed; see the deploy node output"
    elif not health_ok:
        deployed, summary = False, "the service did not report healthy within thirty seconds of the deploy"
    elif identity:
        probe = subprocess.run(identity, shell=True, capture_output=True, text=True)
        observed = probe.stdout.strip()
        if probe.returncode != 0 or not observed:
            deployed, summary = False, "the identity command failed or printed nothing"
        elif observed != revision:
            deployed, summary = False, f"the service reports {observed[:12]}, not the deployed {revision[:12]}"
        else:
            deployed, summary = True, f"{branch} head {revision[:12]} is deployed, healthy and reports its revision"
    else:
        deployed, summary = True, f"{branch} head {revision[:12]} deployed and healthy (no identity command configured)"
    record = {"deployed": deployed, "revision": revision, "branch": branch,
              "observed": observed, "summary": summary}
    artifacts = Path(os.environ["ARTIFACTS_DIR"])
    artifacts.mkdir(parents=True, exist_ok=True)
    (artifacts / "deployment.md").write_text(
        "# Deployment\n\n" + "\n".join(f"- {key}: {value}" for key, value in record.items()) + "\n",
        encoding="utf-8")
    print(json.dumps({"deployed": deployed, "revision": revision, "observed": observed, "summary": summary}))
    return 0 if deployed else 1


if __name__ == "__main__":
    sys.exit(main())
