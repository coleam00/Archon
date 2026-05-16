#!/usr/bin/env python3
"""Generate SSDF gap report — practices with missing evidence across any dimension."""
import argparse
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path.home() / ".kiro" / "scripts"))
from sysml_graph import scan_specs  # noqa: E402
from git_evidence import collect_commits, build_practice_index  # noqa: E402
from scan_evidence import read_manifest, map_scanners_to_practices, SCANNER_PRACTICE_MAP  # noqa: E402
from ssdf_attestation_sections import T2_PRACTICES  # noqa: E402
from pipeline_evidence import load_pipeline_variant  # noqa: E402

_FAMILIES = {"PO": "Prepare the Organization", "PS": "Protect the Software",
             "PW": "Produce Well-Secured Software", "RV": "Respond to Vulnerabilities"}

# Practices that CAN be evidenced by security scanners
_SCAN_ASSESSABLE = set()
for _tp in SCANNER_PRACTICE_MAP.values():
    _SCAN_ASSESSABLE.update(_tp)

_REMEDIATION = {
    "SysML": "Add satisfy/verify elements to ComplianceGraph in relevant spec model.sysml",
    "Commits": "Tag commits with this practice in Compliance: field",
    "Scans": "Run relevant security scanner and ensure scan manifest covers this practice",
}


def main() -> int:
    parser = argparse.ArgumentParser(description="SSDF gap report (multi-dimensional)")
    parser.add_argument("--specs-dir", default=".kiro/specs", help="Path to specs directory")
    parser.add_argument("--project", default=".", help="Project root directory")
    parser.add_argument("--days", type=int, default=365, help="Git lookback days")
    parser.add_argument("--output", help="Write to file instead of stdout")
    args = parser.parse_args()

    project = Path(args.project)
    graph = scan_specs(args.specs_dir)
    commits = collect_commits(project, args.days)
    git_index = build_practice_index(commits)
    scan_results = read_manifest(project)
    scan_index = map_scanners_to_practices(scan_results) if scan_results else {}

    all_pids = sorted(set(list(graph.satisfy) + list(git_index) + list(scan_index)))
    t1_pids = [p for p in all_pids if p not in T2_PRACTICES]

    # Pipeline inheritance
    pipeline = load_pipeline_variant(project)
    pipeline_ids = pipeline.covered_ids() if pipeline else set()

    # Find gaps: practices with insufficient evidence
    gaps_by_family: dict[str, list[tuple[str, list[str], list[str]]]] = defaultdict(list)
    for pid in t1_pids:
        # Pipeline-inherited practices are not gaps
        if pid in pipeline_ids:
            continue
        has_sysml = bool(graph.components_for(pid))
        has_commits = len(git_index.get(pid, [])) > 0
        has_scans = pid in scan_index if pid in _SCAN_ASSESSABLE else True  # N/A = not a gap
        dims = sum([has_sysml, has_commits])  # base dimensions
        if dims >= 2:
            continue  # SysML + commits = sufficient
        if dims == 1 and has_scans and pid in _SCAN_ASSESSABLE:
            continue  # 1 base dim + scans = sufficient for scan-assessable
        missing = []
        remediation = []
        if not has_sysml:
            missing.append("SysML")
            remediation.append(_REMEDIATION["SysML"])
        if not has_commits:
            missing.append("Commits")
            remediation.append(_REMEDIATION["Commits"])
        if pid in _SCAN_ASSESSABLE and not (pid in scan_index):
            missing.append("Scans")
            remediation.append(_REMEDIATION["Scans"])
        if not missing:
            continue
        family = pid[:2]
        gaps_by_family[family].append((pid, missing, remediation))

    lines = ["# NIST SP 800-218 Gap Report", ""]
    lines.append(f"**Project**: {project.resolve().name}")
    lines.append(f"**Generated**: {datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S')}Z")
    lines.append("")
    lines.append("---")

    if not any(gaps_by_family.values()):
        lines.append("")
        lines.append("No gaps found — all T1 practices have multi-dimensional evidence coverage.")
        output = "\n".join(lines) + "\n"
        if args.output:
            Path(args.output).write_text(output)
        else:
            print(output)
        return 0

    full_gaps = 0
    partial_gaps = 0

    for family in ["PO", "PS", "PW", "RV"]:
        family_gaps = gaps_by_family.get(family, [])
        if not family_gaps:
            continue
        lines.append("")
        lines.append(f"## {family} — {_FAMILIES.get(family, family)}")
        lines.append("")
        lines.append("| Practice | Missing Dimensions | Remediation |")
        lines.append("|----------|-------------------|-------------|")
        for pid, missing, remediation in family_gaps:
            if len(missing) >= 2:
                full_gaps += 1
            else:
                partial_gaps += 1
            lines.append(f"| {pid} | {', '.join(missing)} | {remediation[0]} |")

    lines.append("")
    lines.append("---")
    lines.append("")
    lines.append("## Summary")
    lines.append("")
    lines.append(f"- **Total gaps**: {full_gaps + partial_gaps} ({full_gaps} full, {partial_gaps} partial)")
    lines.append("- **Priority**: Full gaps (multiple missing dimensions) first")

    output = "\n".join(lines) + "\n"
    if args.output:
        Path(args.output).write_text(output)
        print(f"Written to {args.output}")
    else:
        print(output)
    return 0


if __name__ == "__main__":
    sys.exit(main())
