# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""Combine local validation and independent review into the loop verdict."""

import json
import os


def main() -> int:
    order = json.loads(os.environ["INPUTS_ORDER"])
    implement = json.loads(os.environ["INPUTS_IMPLEMENT"])
    verification = json.loads(os.environ["INPUTS_VERIFICATION"])
    review = json.loads(os.environ["INPUTS_REVIEW"])

    assigned = sorted(order["diagnosis_ids"])
    addressed = sorted(implement["addressed_diagnosis_ids"])
    coverage_ok = assigned == addressed
    done = bool(verification.get("green")) and bool(review.get("approved")) and coverage_ok

    feedback = {
        "validation": verification,
        "review": review,
        "coverage_error": None if coverage_ok else {
            "assigned": assigned,
            "addressed": addressed,
        },
    }
    print(json.dumps({
        "done": done,
        "concern": order["title"],
        "branch": implement["branch"],
        "summary": implement["summary"],
        "validate_cmd": implement["validate_cmd"],
        "test_cmd": implement["test_cmd"],
        "diagnosis_ids": assigned,
        "feedback": feedback,
    }))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

