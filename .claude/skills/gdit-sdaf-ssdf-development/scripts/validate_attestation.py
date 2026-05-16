#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""Validate attestation readiness against CISA Secure Software Development Attestation Form.

Checks commit evidence, project artifacts, and mapping doc presence for each
attestation statement. Produces a readiness report.
"""

import re
import subprocess
import sys
from datetime import datetime, timedelta
from pathlib import Path

STATEMENTS = []
try:
    sys.path.insert(0, str(Path.home() / ".kiro" / "scripts"))
    from ssdf_attestation_sections import ATTESTATION_SECTIONS as STATEMENTS
except ImportError:
    # Fallback inline if shared module not available
    STATEMENTS = [
        {"id": 1, "title": "Secure Development Environment", "practices": ["PO.5.1", "PS.1.1", "PS.2.1"], "artifacts": [], "mapping_doc": "PS-PROTECT-SOFTWARE.md"},
        {"id": 2, "title": "Source Code Supply Chain", "practices": ["PS.3.1", "PS.3.2"], "artifacts": ["docs/compliance-by-family/PS/SBOM-*.json"], "mapping_doc": "PS-PROTECT-SOFTWARE.md"},
        {"id": 3, "title": "Automated Security Testing", "practices": ["PW.7.1", "PW.7.2"], "artifacts": [], "mapping_doc": "PW-PRODUCE-WELL-SECURED-SOFTWARE.md"},
        {"id": 4, "title": "Vulnerability Management", "practices": ["RV.1.1", "RV.1.2", "RV.2.1", "RV.2.2"], "artifacts": [], "mapping_doc": "RV-RESPOND-VULNERABILITIES.md"},
        {"id": 5, "title": "Code Review and Analysis", "practices": ["PW.4.1", "PW.4.2"], "artifacts": [], "mapping_doc": "PW-PRODUCE-WELL-SECURED-SOFTWARE.md"},
        {"id": 6, "title": "Secure Software Design", "practices": ["PW.1.1", "PW.1.2"], "artifacts": ["docs/compliance-by-family/PW/THREAT-MODEL.md"], "mapping_doc": "PW-PRODUCE-WELL-SECURED-SOFTWARE.md"},
        {"id": 7, "title": "Build Integrity", "practices": ["PO.3.1", "PO.3.2", "PO.3.3"], "artifacts": [], "mapping_doc": None},
        {"id": 8, "title": "Testing", "practices": ["PW.8.1", "PW.8.2"], "artifacts": [], "mapping_doc": None},
    ]


def parse_args() -> dict:
    args = {"project": ".", "output": None, "days": 365, "sysml": False}
    i = 1
    while i < len(sys.argv):
        if sys.argv[i] == "--project" and i + 1 < len(sys.argv):
            args["project"] = sys.argv[i + 1]
            i += 2
        elif sys.argv[i] == "--output" and i + 1 < len(sys.argv):
            args["output"] = sys.argv[i + 1]
            i += 2
        elif sys.argv[i] == "--days" and i + 1 < len(sys.argv):
            args["days"] = int(sys.argv[i + 1])
            i += 2
        elif sys.argv[i] == "--sysml":
            args["sysml"] = True
            i += 1
        elif sys.argv[i] in ("-h", "--help"):
            print("Usage: validate_attestation.py [--project DIR] [--days N] [--output PATH] [--sysml]")
            sys.exit(0)
        else:
            i += 1
    return args


def get_commit_practices(days: int) -> set[str]:
    since = (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%d")
    result = subprocess.run(
        ["git", "log", f"--since={since}", "--format=%b"],
        capture_output=True, text=True
    )
    practices: set[str] = set()
    if result.returncode == 0:
        for match in re.finditer(r"Compliance:\s*(.+)", result.stdout):
            for p in match.group(1).split(","):
                practices.add(p.strip())
    return practices


def check_artifacts(project: Path, patterns: list[str]) -> list[Path]:
    found = []
    for pattern in patterns:
        found.extend(project.glob(pattern))
    return found


def check_mapping_doc(project: Path, doc_name: str | None) -> bool:
    if doc_name is None:
        return True  # not required
    return (project / "docs" / "compliance-by-family" / doc_name).exists()


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


def assess_statement(stmt: dict, commit_practices: set[str], project: Path,
                     sysml_graph: object | None = None) -> dict:
    has_practices = all(p in commit_practices for p in stmt["practices"])
    some_practices = any(p in commit_practices for p in stmt["practices"])
    artifacts = check_artifacts(project, stmt["artifacts"])
    has_artifacts = len(artifacts) > 0 if stmt["artifacts"] else True
    has_mapping = check_mapping_doc(project, stmt["mapping_doc"])

    # SysML graph dimensions (only when --sysml and graph available)
    has_satisfy = False
    has_verify = False
    if sysml_graph is not None:
        has_satisfy = all(sysml_graph.components_for(p) for p in stmt["practices"])
        has_verify = all(sysml_graph.tests_for(p) for p in stmt["practices"])

    if sysml_graph is not None:
        # Enriched verdict: all four dimensions required for READY
        if has_practices and has_artifacts and has_satisfy and has_verify:
            status = "READY"
        elif some_practices or has_artifacts or has_mapping or has_satisfy or has_verify:
            status = "PARTIAL"
        else:
            status = "NOT READY"
    else:
        # Original logic (backward compatible)
        if has_practices and has_artifacts:
            status = "READY"
        elif some_practices or has_artifacts or has_mapping:
            status = "PARTIAL"
        else:
            status = "NOT READY"

    result = {
        "id": stmt["id"],
        "title": stmt["title"],
        "status": status,
        "has_practices": has_practices,
        "some_practices": some_practices,
        "practice_detail": {p: p in commit_practices for p in stmt["practices"]},
        "has_artifacts": has_artifacts,
        "artifacts_found": [str(a) for a in artifacts],
        "has_mapping": has_mapping,
        "mapping_doc": stmt["mapping_doc"],
    }
    if sysml_graph is not None:
        result["has_satisfy"] = has_satisfy
        result["has_verify"] = has_verify
    return result


def generate_report(results: list[dict], days: int) -> str:
    now = datetime.now().strftime("%Y-%m-%d %H:%M")
    ready = sum(1 for r in results if r["status"] == "READY")
    total = len(results)
    pct = (ready / total * 100) if total > 0 else 0

    status_icon = {"READY": "✅", "PARTIAL": "⚠️", "NOT READY": "❌"}

    lines = [
        "# Attestation Readiness Report",
        "",
        f"Generated: {now}",
        f"Period: last {days} days",
        f"Overall: {ready}/{total} statements READY ({pct:.0f}%)",
        "",
        "## Summary",
        "",
        "| # | Statement | Status |",
        "|---|-----------|--------|",
    ]

    for r in results:
        icon = status_icon[r["status"]]
        lines.append(f"| {r['id']} | {r['title']} | {icon} {r['status']} |")

    lines.extend(["", "## Detail", ""])

    for r in results:
        icon = status_icon[r["status"]]
        lines.append(f"### Statement {r['id']}: {r['title']} — {icon} {r['status']}")
        lines.append("")

        lines.append("**Commit evidence:**")
        for p, found in r["practice_detail"].items():
            lines.append(f"- {'✅' if found else '❌'} {p}")

        if r["artifacts_found"]:
            lines.append(f"**Artifacts:** {', '.join(r['artifacts_found'])}")
        elif any(STATEMENTS[r['id']-1]["artifacts"]):
            lines.append("**Artifacts:** ❌ not found")

        if r["mapping_doc"]:
            lines.append(f"**Mapping doc:** {'✅' if r['has_mapping'] else '❌'} {r['mapping_doc']}")

        if r.get("has_satisfy") is not None:
            lines.append(f"**Graph satisfy:** {'✅' if r['has_satisfy'] else '❌'}")
            lines.append(f"**Graph verify:** {'✅' if r['has_verify'] else '❌'}")

        if r["status"] != "READY":
            lines.append("")
            lines.append("**Remediation:**")
            if not r["has_practices"]:
                missing = [p for p, found in r["practice_detail"].items() if not found]
                lines.append(f"- Generate commit evidence for: {', '.join(missing)}")
            if not r["has_artifacts"] and STATEMENTS[r['id']-1]["artifacts"]:
                lines.append("- Run `load ssdf-development skill` → generate-sbom (or create required artifact)")
            if not r["has_mapping"] and r["mapping_doc"]:
                family = r["mapping_doc"].split("-")[0]
                lines.append(f"- Run `load ssdf-compliance-mapping skill` → create-family-mapping for {family} family")

        lines.append("")

    return "\n".join(lines) + "\n"


def main() -> None:
    args = parse_args()
    project = Path(args["project"]).resolve()
    commit_practices = get_commit_practices(args["days"])
    sysml_graph = load_sysml_graph() if args["sysml"] else None
    results = [assess_statement(s, commit_practices, project, sysml_graph=sysml_graph) for s in STATEMENTS]
    report = generate_report(results, args["days"])

    if args["output"]:
        Path(args["output"]).parent.mkdir(parents=True, exist_ok=True)
        Path(args["output"]).write_text(report)
        print(f"Report written to {args['output']}", file=sys.stderr)
    else:
        print(report)

    ready = sum(1 for r in results if r["status"] == "READY")
    sys.exit(0 if ready == len(results) else 1)


if __name__ == "__main__":
    main()
