"""Deterministic readiness join: certifies the review verdict before validate
and flip spend.

Bound inputs (no latch files -- values arrive through `with:` bindings):
- INPUTS_REVIEW_READY: the initial review's ready boolean as canonical text
  ("true"/"false"); "false" also when the review block was skipped upstream.
- INPUTS_CORRECTIONS: the correction loop's output text, or "null" when the
  loop was skipped because the initial review was already ready.

A completed correction loop implies readiness: `until_bash` on the recheck
verdict is its only success exit. A loop that exhausted its bound, or a review
that failed outright, fails this node's binding resolution before this script
runs -- lifecycle completion can never bypass a not-ready review.
"""

import os
import sys

review_ready = os.environ.get("INPUTS_REVIEW_READY", "")
corrections = os.environ.get("INPUTS_CORRECTIONS", "null")

if review_ready == "true" or corrections != "null":
    print('{"ready":"true"}')
    sys.exit(0)

print(
    "not ready: the initial review did not report ready and no correction loop "
    "completed -- see the earliest failed or skipped node, the review report in "
    "the run artifacts, and the canonical PR comment.",
    file=sys.stderr,
)
sys.exit(1)
