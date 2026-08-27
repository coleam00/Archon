# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""Write one honest report over concern-level stabilizer children."""

import json
import os


def main() -> int:
    results = json.loads(os.environ["INPUTS_FIX_EACH"])
    if not isinstance(results, list):
        raise ValueError("fix-each output must be the engine-owned fan-out array")
    report_path = os.path.join(os.environ["ARTIFACTS_DIR"], "batch-report.md")

    lines = ["# Test stabilizer report", ""]
    lines.append(
        "No concerns were dispatched." if not results else f"{len(results)} concern(s) dispatched."
    )
    lines += ["", "| # | Concern | Branch | PR | CI | Status |", "|---|---------|--------|----|----|--------|"]

    delivered = []
    for index, result in enumerate(results, start=1):
        if result.get("archon_failed"):
            reason = " ".join(str(result.get("error", "child failed")).split())[:200].replace("|", "\\|")
            lines.append(f"| {index} | {reason} | — | — | — | FAILED |")
            continue
        concern = str(result.get("concern", "")).replace("|", "\\|")
        branch = result.get("branch", "—")
        pr_url = result.get("pr_url", "—")
        ci = result.get("ci_verdict", "unknown")
        status = "SHIPPED" if ci == "green" else ("CI-RED" if ci == "red" else "CI-TIMEOUT")
        lines.append(f"| {index} | {concern} | `{branch}` | {pr_url} | {ci} | {status} |")
        delivered.append(result)

    not_green = [result for result in delivered if result.get("ci_verdict") != "green"]
    failures = [result for result in results if result.get("archon_failed")]
    lines += ["", f"**{len(delivered)} delivered, {len(not_green)} not green, {len(failures)} child failure(s).**"]

    with open(report_path, "w") as report:
        report.write("\n".join(lines) + "\n")
    print("\n".join(lines))
    print(f"\nreport: {report_path}")
    return 1 if results and len(failures) == len(results) else 0


if __name__ == "__main__":
    raise SystemExit(main())
