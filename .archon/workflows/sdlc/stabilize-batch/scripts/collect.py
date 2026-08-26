# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""Batch collector: one canonical surface over all fan-out children.

Reads the aggregated child results ($fix-each.output — one entry per work
order; failed children arrive as {"archon_failed": true, ...}) and writes the
batch report to $ARTIFACTS_DIR/batch-report.md, then prints a summary. Exit 0
unless EVERY child failed — partial success is a completed batch with honest
bookkeeping.
"""

import json
import os
import sys


def main() -> int:
    raw = os.environ.get("INPUTS_FIX_EACH", "[]")
    try:
        results = json.loads(raw)
        if isinstance(results, dict):
            results = [results]
    except json.JSONDecodeError:
        results = [{"archon_failed": True, "error": f"unparseable child output: {raw[:500]}"}]

    artifacts = os.environ["ARTIFACTS_DIR"]
    report_path = os.path.join(artifacts, "batch-report.md")

    lines = [
        "# Stabilize batch report",
        "",
        f"{len(results)} work order(s) dispatched.",
        "",
        "| # | Order | Branch | PR | CI | Status |",
        "|---|-------|--------|----|----|--------|",
    ]
    shipped = []
    for i, r in enumerate(results, start=1):
        if r.get("archon_failed"):
            lines.append(
                f"| {i} | {r.get('error', 'child failed')[:80]} | — | — | — | FAILED |"
            )
            continue
        pr_url = r.get("pr_url", "—")
        ci = r.get("ci_verdict", "unknown")
        branch = r.get("branch", "—")
        status = "SHIPPED" if ci == "green" else ("CI-RED" if ci == "red" else "CI-PENDING")
        title = ""
        order_text = r.get("order") or ""
        if order_text:
            title = order_text.strip().splitlines()[0][:60]
        lines.append(f"| {i} | {title} | `{branch}` | {pr_url} | {ci} | {status} |")
        shipped.append((i, branch, pr_url, ci))

    reds = [s for s in shipped if s[3] != "green"]
    lines += ["", f"**{len(shipped)} shipped, {len(reds)} not green, "
                  f"{len(results) - len(shipped)} child failures.**"]

    with open(report_path, "w") as f:
        f.write("\n".join(lines) + "\n")

    print("\n".join(lines))
    print(f"\nreport: {report_path}")

    # Every child failed => the batch itself failed. Partial success completes.
    if results and all(r.get("archon_failed") for r in results):
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
