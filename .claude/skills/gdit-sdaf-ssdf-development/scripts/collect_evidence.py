#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""Collect SSDF compliance evidence from git commit history.

Parses git log for Compliance: fields, builds per-practice evidence index,
and generates a markdown coverage report.
"""

import re
import subprocess
import sys
from collections import defaultdict
from datetime import datetime, timedelta
from pathlib import Path

ALL_PRACTICES = [
    "PO.1.1","PO.1.2","PO.1.3","PO.2.1","PO.2.2","PO.3.1","PO.3.2","PO.3.3",
    "PO.4.1","PO.4.2","PO.5.1","PO.5.2",
    "PS.1.1","PS.2.1","PS.3.1","PS.3.2",
    "PW.1.1","PW.2.1","PW.4.1","PW.4.2","PW.5.1","PW.6.1","PW.6.2",
    "PW.7.1","PW.7.2","PW.8.1","PW.8.2","PW.9.1","PW.9.2",
    "RV.1.1","RV.1.2","RV.1.3","RV.2.1","RV.2.2","RV.3.1","RV.3.2","RV.3.3","RV.3.4",
]

# Practices achievable through development commits (from SSDF-COMMIT-TAGS.md)
COMMIT_EVIDENCEABLE = {
    "PS.1.1","PS.2.1","PS.3.1","PS.3.2",
    "PW.1.1","PW.2.1","PW.4.1","PW.4.2","PW.5.1","PW.6.1","PW.6.2",
    "PW.7.1","PW.7.2","PW.8.1","PW.8.2","PW.9.1","PW.9.2",
    "RV.1.1","RV.2.1",
}

# Organizational/documentation practices — handled by ssdf-compliance-mapping skill
ORGANIZATIONAL = {
    "PO.1.1","PO.1.2","PO.1.3","PO.2.1","PO.2.2","PO.3.1","PO.3.2","PO.3.3",
    "PO.4.1","PO.4.2","PO.5.1","PO.5.2",
}

# Event-driven practices — only triggered when vulnerabilities are found
EVENT_DRIVEN = {
    "RV.1.2","RV.1.3","RV.2.2","RV.3.1","RV.3.2","RV.3.3","RV.3.4",
}

FAMILIES = {"PO": "Prepare the Organization", "PS": "Protect the Software",
            "PW": "Produce Well-Secured Software", "RV": "Respond to Vulnerabilities"}


MARKER_FILE = Path(".security-scans") / ".evidence-last-run"


def parse_args() -> dict:
    args = {"days": None, "output": None, "full": False, "summary": False, "sysml": False}
    i = 1
    while i < len(sys.argv):
        if sys.argv[i] == "--days" and i + 1 < len(sys.argv):
            args["days"] = int(sys.argv[i + 1])
            i += 2
        elif sys.argv[i] == "--output" and i + 1 < len(sys.argv):
            args["output"] = sys.argv[i + 1]
            i += 2
        elif sys.argv[i] == "--full":
            args["full"] = True
            i += 1
        elif sys.argv[i] == "--summary":
            args["summary"] = True
            i += 1
        elif sys.argv[i] == "--sysml":
            args["sysml"] = True
            i += 1
        elif sys.argv[i] in ("-h", "--help"):
            print("Usage: collect_evidence.py [--days N] [--output PATH] [--full] [--summary] [--sysml]")
            sys.exit(0)
        else:
            i += 1
    return args


def read_marker() -> str | None:
    if MARKER_FILE.exists():
        return MARKER_FILE.read_text().strip()
    return None


def write_marker() -> None:
    MARKER_FILE.parent.mkdir(parents=True, exist_ok=True)
    MARKER_FILE.write_text(datetime.now().strftime("%Y-%m-%dT%H:%M:%S"))


def resolve_since(args: dict) -> str:
    """Determine the --since value for git log."""
    if args["days"] is not None:
        return (datetime.now() - timedelta(days=args["days"])).strftime("%Y-%m-%d")
    if not args["full"]:
        marker = read_marker()
        if marker:
            return marker
    return (datetime.now() - timedelta(days=365)).strftime("%Y-%m-%d")


def collect_commits(since: str) -> list[dict]:
    sep = "---COMMIT-SEP---"
    fmt = f"%H|%ai|%s%n%b{sep}"
    result = subprocess.run(
        ["git", "log", f"--since={since}", f"--format={fmt}"],
        capture_output=True, text=True
    )
    if result.returncode != 0:
        print(f"Error running git log: {result.stderr}", file=sys.stderr)
        return []

    commits = []
    for block in result.stdout.split(sep):
        block = block.strip()
        if not block:
            continue
        lines = block.split("\n", 1)
        header = lines[0]
        body = lines[1] if len(lines) > 1 else ""
        parts = header.split("|", 2)
        if len(parts) < 3:
            continue

        compliance_match = re.search(r"Compliance:\s*(.+)", body)
        if not compliance_match:
            continue

        practices = [p.strip() for p in compliance_match.group(1).split(",")]
        commits.append({
            "hash": parts[0][:8],
            "date": parts[1].split()[0],
            "summary": parts[2],
            "practices": practices,
        })
    return commits


def build_index(commits: list[dict]) -> dict[str, list[dict]]:
    index: dict[str, list[dict]] = defaultdict(list)
    for c in commits:
        for p in c["practices"]:
            index[p].append(c)
    return index


def load_sysml_graph() -> object | None:
    """Try to load and scan ComplianceGraph blocks. Returns graph or None."""
    try:
        sys.path.insert(0, str(Path.home() / ".kiro" / "scripts"))
        from sysml_graph import scan_specs
        graph = scan_specs(".kiro/specs")
        if not graph.satisfy and not graph.verify:
            return None
        return graph
    except Exception:
        return None


def generate_sysml_section(graph: object, index: dict[str, list[dict]]) -> str:
    """Generate 'SysML Graph Coverage' report section."""
    report = graph.coverage_report()
    if not report:
        return ""
    lines = [
        "## SysML Graph Coverage",
        "",
        "| Practice | Satisfy (components) | Verify (tests) | Org Policy | Commit Evidence | Status |",
        "|----------|---------------------|----------------|------------|-----------------|--------|",
    ]
    for pid in sorted(report):
        entry = report[pid]
        comps = ", ".join(entry["components"]) if entry["components"] else "—"
        tests = ", ".join(entry["tests"]) if entry["tests"] else "—"
        orgs = ", ".join(entry["org_policies"]) if entry["org_policies"] else "—"
        commit_count = len(index.get(pid, []))
        commit_str = f"{commit_count} commit(s)" if commit_count else "—"
        has_satisfy = bool(entry["components"])
        has_verify = bool(entry["tests"])
        has_commits = commit_count > 0
        if has_satisfy and has_verify and has_commits:
            status = "✅ FULL"
        elif has_satisfy or has_verify or has_commits:
            status = "⚠️ PARTIAL"
        else:
            status = "❌ NONE"
        lines.append(f"| {pid} | {comps} | {tests} | {orgs} | {commit_str} | {status} |")
    lines.append("")
    return "\n".join(lines) + "\n"


def generate_report(index: dict[str, list[dict]], since: str, total_commits: int,
                    sysml_graph: object | None = None) -> str:
    now = datetime.now().strftime("%Y-%m-%d %H:%M")
    commit_practices = [p for p in ALL_PRACTICES if p in COMMIT_EVIDENCEABLE]
    lines = [
        "# SSDF Evidence Report",
        "",
        f"Generated: {now}",
        f"Since: {since}",
        f"Commits with Compliance tags: {total_commits}",
        f"Scope: {len(commit_practices)} commit-evidenceable practices "
        f"(of {len(ALL_PRACTICES)} total SSDF sub-practices)",
        "",
        "## Coverage Summary",
        "",
        "| Family | Name | Evidenceable | With Evidence | Coverage | Excluded |",
        "|--------|------|-------------|---------------|----------|----------|",
    ]

    for fam, name in FAMILIES.items():
        fam_practices = [p for p in ALL_PRACTICES if p.startswith(fam + ".")]
        fam_evidenceable = [p for p in fam_practices if p in COMMIT_EVIDENCEABLE]
        covered = sum(1 for p in fam_evidenceable if p in index)
        total = len(fam_evidenceable)
        excluded = len(fam_practices) - total
        pct = (covered / total * 100) if total > 0 else 0
        excl_label = f"{excluded} organizational" if fam == "PO" else (f"{excluded} event-driven" if excluded else "—")
        lines.append(f"| {fam} | {name} | {total} | {covered} | {pct:.0f}% | {excl_label} |")

    all_covered = sum(1 for p in commit_practices if p in index)
    overall_pct = (all_covered / len(commit_practices) * 100) if commit_practices else 0
    total_excluded = len(ALL_PRACTICES) - len(commit_practices)
    lines.append(f"| **Total** | | **{len(commit_practices)}** | **{all_covered}** | **{overall_pct:.0f}%** | {total_excluded} excluded |")

    lines.extend(["", "## Per-Practice Evidence", ""])
    for fam, name in FAMILIES.items():
        lines.append(f"### {fam} — {name}")
        lines.append("")
        fam_practices = [p for p in ALL_PRACTICES if p.startswith(fam + ".")]
        for p in fam_practices:
            commits = index.get(p, [])
            if commits:
                dates = [c["date"] for c in commits]
                lines.append(f"- ✅ **{p}**: {len(commits)} commits ({min(dates)} to {max(dates)})")
                for c in commits[:3]:
                    lines.append(f"  - `{c['hash']}` {c['date']} — {c['summary']}")
                if len(commits) > 3:
                    lines.append(f"  - ... and {len(commits) - 3} more")
            elif p in ORGANIZATIONAL:
                lines.append(f"- ⬜ **{p}**: organizational — use `ssdf-compliance-mapping` skill")
            elif p in EVENT_DRIVEN:
                lines.append(f"- ⬜ **{p}**: event-driven — evidence generated when vulnerabilities are found")
            else:
                lines.append(f"- ❌ **{p}**: no evidence")
        lines.append("")

    gaps = [p for p in commit_practices if p not in index]
    if gaps:
        lines.extend(["## Gaps (Commit-Evidenceable Practices Without Evidence)", ""])
        for p in gaps:
            lines.append(f"- {p}")
        lines.append("")

    org = [p for p in ALL_PRACTICES if p in ORGANIZATIONAL]
    evt = [p for p in ALL_PRACTICES if p in EVENT_DRIVEN]
    if org or evt:
        lines.extend(["## Excluded from Gap Analysis", ""])
        if org:
            lines.append(f"**Organizational ({len(org)} practices)**: {', '.join(org)}")
            lines.append("  → Use `load ssdf-compliance-mapping skill` for PO family documentation")
            lines.append("")
        if evt:
            lines.append(f"**Event-driven ({len(evt)} practices)**: {', '.join(evt)}")
            lines.append("  → Evidence generated when vulnerability response activities occur")
            lines.append("")

    if sysml_graph is not None:
        lines.append(generate_sysml_section(sysml_graph, index))

    return "\n".join(lines) + "\n"


def generate_summary(index: dict[str, list[dict]], total_commits: int) -> str:
    """One-line summary for --summary mode."""
    practices = sorted(set(p for p in index if p in COMMIT_EVIDENCEABLE))
    if not practices:
        return "Evidence: 0 practices tagged"
    return f"Evidence: {len(practices)} practices tagged in {total_commits} commit(s) ({', '.join(practices)})"


def main() -> None:
    args = parse_args()
    since = resolve_since(args)
    commits = collect_commits(since)
    index = build_index(commits)

    sysml_graph = load_sysml_graph() if args["sysml"] else None

    if args["summary"]:
        print(generate_summary(index, len(commits)), file=sys.stderr)

    report = generate_report(index, since, len(commits), sysml_graph=sysml_graph)

    if args["output"]:
        Path(args["output"]).parent.mkdir(parents=True, exist_ok=True)
        Path(args["output"]).write_text(report)
        if not args["summary"]:
            print(f"Report written to {args['output']}", file=sys.stderr)
    elif not args["summary"]:
        print(report)

    write_marker()


if __name__ == "__main__":
    main()
