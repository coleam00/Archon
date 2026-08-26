# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""Deterministic verification for one stabilize-fix child.

Runs the targeted test `test_repetitions` consecutive times (each must exit 0)
then the project's broad check once. Any failure exits non-zero with the
failing command and its tail output — the workflow fails, the batch collector
records it, nothing ships.
"""

import json
import os
import subprocess
import sys

MAX_OUTPUT_CHARS = 4000


def run(cmd: str) -> tuple[int, str]:
    proc = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    tail = (proc.stdout + proc.stderr)[-MAX_OUTPUT_CHARS:]
    return proc.returncode, tail


def main() -> int:
    fix = json.loads(os.environ["INPUTS_FIX"])
    repetitions = int(os.environ.get("INPUTS_TEST_REPETITIONS", "5"))

    test_cmd = fix["test_cmd"].strip()
    validate_cmd = fix["validate_cmd"].strip()

    for i in range(1, repetitions + 1):
        code, tail = run(test_cmd)
        if code != 0:
            print(f"targeted test failed on repetition {i}/{repetitions}: {test_cmd}")
            print(tail)
            return 1
        print(f"targeted test green {i}/{repetitions}")

    code, tail = run(validate_cmd)
    if code != 0:
        print(f"project checks failed: {validate_cmd}")
        print(tail)
        return 1
    print("project checks green")

    print(json.dumps({"verified": True, "repetitions": repetitions}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
