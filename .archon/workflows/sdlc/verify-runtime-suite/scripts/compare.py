"""Compare typed runtime returns, never parse agent reports or observation prose."""

import json
import os

manifest = json.loads(os.environ["INPUTS_MANIFEST"])
results = json.loads(os.environ["INPUTS_RESULTS"])
if not isinstance(results, list):
    raise ValueError("runtime aggregate must be an ordered array")

rows = []
for index, case in enumerate(manifest["cases"]):
    result = results[index] if index < len(results) else None
    available = isinstance(result, dict) and result.get("archon_failed") is not True
    verdict = result.get("verdict") if available else None
    measured = available and verdict in ("verified", "failed", "inconclusive")
    candidate = result.get("candidate") if measured else None
    if not measured or verdict == "inconclusive":
        comparison = "unavailable"
    elif candidate != case["candidate"]:
        comparison = "wrong_identity"
    elif verdict == case["expected_verdict"]:
        comparison = "matched"
    elif case["expected_verdict"] == "failed":
        comparison = "escaped"
    else:
        comparison = "unexpected_failure"
    rows.append({
        **case,
        # The engine's fan_out_instances event maps this ordinal to its durable
        # instance scope, including when a failed instance has no typed return.
        "attribution": {
            "run_id": os.environ["WORKFLOW_ID"],
            "fan_out_node": "cases",
            "ordinal": index,
            "return_node": "gate-verified",
            "agent_node": "verify-loop.verify",
        },
        "executed": measured,
        "candidate_observed": candidate,
        "underlying_verdict": verdict,
        "comparison": comparison,
        "expectation_met": comparison == "matched",
        "runtime": result,
    })

exact_count = len(results) == len(rows)
passed = exact_count and all(row["expectation_met"] for row in rows)
unavailable = not exact_count or any(row["comparison"] in ("unavailable", "wrong_identity") for row in rows)
baseline = next(row for row in rows if row["id"] == manifest["baseline"])
print(json.dumps({
    "expectations_passed": passed,
    "verdict": "passed" if passed else "inconclusive" if unavailable else "failed",
    "all_cases_executed": exact_count and all(row["executed"] for row in rows),
    "baseline_verified": baseline["comparison"] == "matched",
    "baseline_verification": baseline,
    "cases": rows,
    "summary": (
        "suite expectations passed; baseline verification is reported separately"
        if passed else
        f"suite expectations not met; expected {len(rows)} results, received {len(results)}"
    ),
}))
