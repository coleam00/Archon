"""Map the retry loop's final per-attempt status onto this workflow's typed,
three-way result. This tail's terminal report, like every other SDLC tail's
(see deliver/scripts/outcome.py) — a named script keeps the mapping out of a
bash body and out of the loop itself, and gives the workflow one place that
owns the `outcome_field: verified` mapping the run's lifecycle result reads.

`check-evidence.py`'s four-way `status` collapses to three outcomes here:
`unavailable` and an exhausted `malformed` both mean nobody could reach a
trustworthy verdict about the candidate, which is `inconclusive`, not
`failed` — a `failed` verdict is a specific, evidence-backed claim that an
assertion did not hold, and this workflow never manufactures one from an
absent or untrustworthy report.

Bound inputs (`with:` bindings, canonical text in env):
- INPUTS_STATUS: the last attempt's check-evidence status.
- INPUTS_REASON: that attempt's reason text.
- INPUTS_CANDIDATE: that attempt's observed candidate identity (may be '').
"""

import json
import os
import sys

_VERDICT_FOR_STATUS = {
    "verified": "verified",
    "failed": "failed",
    "unavailable": "inconclusive",
    "malformed": "inconclusive",
}


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8", newline="\n")
    sys.stderr.reconfigure(encoding="utf-8", newline="\n")

    status = os.environ.get("INPUTS_STATUS", "").strip()
    reason = os.environ.get("INPUTS_REASON", "").strip()
    candidate = os.environ.get("INPUTS_CANDIDATE", "").strip()

    verdict = _VERDICT_FOR_STATUS.get(status)
    if verdict is None:
        print(
            f"gate-verified: the retry loop produced an unrecognized status "
            f"'{status}' — refusing to guess a verdict.",
            file=sys.stderr,
        )
        return 1

    if status == "malformed":
        summary = f"malformed report after exhausting the retry budget: {reason}"
    elif status == "unavailable":
        summary = f"target unavailable: {reason}"
    else:
        summary = reason

    print(
        json.dumps(
            {
                "verified": verdict == "verified",
                "verdict": verdict,
                "candidate": candidate,
                "summary": summary,
            }
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
