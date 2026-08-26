# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""Batch collector: one canonical surface over all fan-out children.

Reads the aggregated child results ($fix-each.output — one entry per work
order; failed children arrive as {"archon_failed": true, ...}) and writes the
batch report to $ARTIFACTS_DIR/batch-report.md, then prints a summary. Exit 0
unless EVERY dispatched child failed — partial success is a completed batch
with honest bookkeeping. An empty dispatch (upstream stage skipped or produced
no orders) is also an honest completion, reported as such.
"""

import json
import os
import sys


def parse_entries(raw: str) -> list:
    """Normalize fan-out join output into result dicts.

    The join may deliver: a JSON array of dicts, a JSON array of raw-JSON-text
    entries, a single dict, or back-to-back JSON objects as one text blob."""
    dec = json.JSONDecoder()
    out = []
    s = raw.strip()

    # Fast path: the whole thing parses (array or single object).
    try:
        data, rest = dec.raw_decode(s)
        entries = data if isinstance(data, list) else [data]
    except json.JSONDecodeError:
        entries = [s]
        rest = ""

    for entry in entries:
        if isinstance(entry, dict):
            out.append(entry)
            continue
        # Raw JSON text entry — parse it; may itself hold several objects.
        entry_s = str(entry).strip()
        while entry_s:
            obj, idx = dec.raw_decode(entry_s)
            out.append(obj)
            entry_s = entry_s[idx:].lstrip()

    # Anything left over after fast-path parse = trailing concatenated objects.
    while rest.strip():
        obj, idx = dec.raw_decode(rest.strip())
        out.append(obj)
        rest = rest.strip()[idx:].lstrip()

    return out


def main() -> int:
    raw = os.environ.get("INPUTS_FIX_EACH", "")
    if not raw.strip() or raw.strip() == "[]":
        # Upstream stage produced no children (skipped or empty fan-out):
        # report it honestly instead of inventing a phantom failure.
        results = []
        no_dispatch = True
    else:
        no_dispatch = False
        results = parse_entries(raw)

    artifacts = os.environ["ARTIFACTS_DIR"]
    report_path = os.path.join(artifacts, "batch-report.md")

    lines = ["# Stabilize batch report", ""]
    if no_dispatch:
        lines.append("No work orders were dispatched (upstream stage produced none).")
    else:
        lines.append(f"{len(results)} work order(s) dispatched.")
    lines.append("")
    lines.append("| # | Order | Branch | PR | CI | Status |")
    lines.append("|---|-------|--------|----|----|--------|")

    shipped = []
    for i, r in enumerate(results, start=1):
        if r.get("archon_failed"):
            reason = " ".join(str(r.get("error", "child failed")).split())[:200].replace("|", "\\|")
            lines.append(f"| {i} | {reason} | — | — | — | FAILED |")
            continue
        pr_url = r.get("pr_url", "—")
        ci = r.get("ci_verdict", "unknown")
        branch = r.get("branch", "—")
        status = "SHIPPED" if ci == "green" else ("CI-RED" if ci == "red" else "CI-PENDING")
        title = ""
        order_text = r.get("order") or ""
        if order_text:
            title = order_text.strip().splitlines()[0][:60].replace("|", "\\|")
        lines.append(f"| {i} | {title} | `{branch}` | {pr_url} | {ci} | {status} |")
        shipped.append((i, branch, pr_url, ci))

    reds = [s for s in shipped if s[3] != "green"]
    child_failures = len([r for r in results if r.get("archon_failed")])
    lines += [
        "",
        f"**{len(shipped)} shipped, {len(reds)} not green, "
        f"{child_failures} child failure(s).**",
    ]

    with open(report_path, "w") as f:
        f.write("\n".join(lines) + "\n")

    print("\n".join(lines))
    print(f"\nreport: {report_path}")

    # Every dispatched child failed => the batch itself failed. Partial
    # success and empty dispatch complete honestly.
    return 1 if (results and all(r.get("archon_failed") for r in results)) else 0


if __name__ == "__main__":
    sys.exit(main())
