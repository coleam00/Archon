#!/usr/bin/env python3
"""Query SSDF compliance evidence for a specific NIST 800-218 sub-practice (multi-dimensional)."""
import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path.home() / ".kiro" / "scripts"))
from sysml_graph import scan_specs  # noqa: E402
from git_evidence import collect_commits, build_practice_index  # noqa: E402
from scan_evidence import read_manifest, map_scanners_to_practices  # noqa: E402
from pipeline_evidence import load_pipeline_variant  # noqa: E402

_PRACTICE_RE = re.compile(r"^[A-Z]{2}\.\d+\.\d+$")


def main() -> int:
    parser = argparse.ArgumentParser(description="Query SSDF practice evidence (multi-dimensional)")
    parser.add_argument("practice_id", help="NIST 800-218 sub-practice ID (e.g., PW.1.1)")
    parser.add_argument("--specs-dir", default=".kiro/specs", help="Path to specs directory")
    parser.add_argument("--project", default=".", help="Project root directory")
    parser.add_argument("--days", type=int, default=365, help="Git lookback days")
    parser.add_argument("--json", action="store_true", dest="json_out", help="Output as JSON")
    args = parser.parse_args()

    if not _PRACTICE_RE.match(args.practice_id):
        print(f"Error: Invalid practice ID format: {args.practice_id}", file=sys.stderr)
        return 1

    pid = args.practice_id
    project = Path(args.project)

    # Check if T2 (organization-deferred)
    from ssdf_attestation_sections import T2_PRACTICES  # noqa: E402
    if pid in T2_PRACTICES:
        if args.json_out:
            import json as json_mod
            print(json_mod.dumps({"practice_id": pid, "status": "org-deferred",
                                  "note": "Organization-deferred — not pipeline-assessable"}, indent=2))
            return 0
        print(f"# NIST SP 800-218 Evidence: {pid}\n")
        print("**Status**: ORG — Organization-Deferred Practice")
        print()
        print("This practice requires organizational policy/process evidence,")
        print("not pipeline artifacts. It cannot be assessed programmatically.")
        print()
        print("**Reference**: See `~/.kiro/skills/ssdf-compliance-mapping/references/ORG-STANDARDS-SSDF-CROSSWALK.md`")
        return 0

    # Dimension 1: SysML
    graph = scan_specs(args.specs_dir)
    components = graph.components_for(pid)
    tests = graph.tests_for(pid)
    org_policies = list(dict.fromkeys(graph.org_policies_for(pid)))  # deduplicate preserving order
    source = graph.sources.get(pid, "")

    # Dimension 2: Git
    commits = collect_commits(project, args.days)
    git_index = build_practice_index(commits)
    practice_commits = git_index.get(pid, [])

    # Dimension 3: Scans
    scan_results = read_manifest(project)
    scan_index = map_scanners_to_practices(scan_results) if scan_results else {}
    practice_scans = scan_index.get(pid, [])

    # Dimension 4: Pipeline
    pipeline = load_pipeline_variant(project)
    pipeline_practice = pipeline.covers(pid) if pipeline else None

    # Temporal assessment
    dates = [c.date for c in practice_commits]
    scan_ts = practice_scans[0].timestamp if practice_scans else ""
    if dates:
        most_recent = max(dates)
        from datetime import datetime, timezone
        days_ago = (datetime.now(timezone.utc) - datetime.fromisoformat(most_recent + "T00:00:00+00:00")).days
        age = "Current" if days_ago <= 30 else "Aging" if days_ago <= 90 else "Stale"
    elif scan_ts:
        age = "Current (scan only)"
        most_recent = scan_ts[:10]
    else:
        age = "Missing"
        most_recent = "—"

    has_any = components or practice_commits or practice_scans or pipeline_practice
    status = "evidenced" if (components and (practice_commits or practice_scans or pipeline_practice)) or pipeline_practice else "partial" if has_any else "gap"

    if args.json_out:
        print(json.dumps({
            "practice_id": pid,
            "status": status,
            "components": components,
            "tests": tests,
            "org_policies": org_policies,
            "sources": [source] if source else [],
            "commits": len(practice_commits),
            "commit_date_range": f"{min(dates)} → {max(dates)}" if dates else "",
            "tools_evidenced": list({t for c in practice_commits for t in c.evidence_tools}),
            "scanners": [s.tool for s in practice_scans],
            "evidence_age": age,
        }, indent=2))
        return 0

    if not has_any:
        print(f"# NIST SP 800-218 Evidence: {pid}\n")
        print("No evidence found for this practice.")
        return 0

    status_icon = "✅ Evidenced" if status == "evidenced" else "⚠️ Partial" if status == "partial" else "❌ Gap"
    print(f"# NIST SP 800-218 Evidence: {pid}\n")
    print(f"**Overall Status**: {status_icon}")
    print(f"**Evidence Age**: {age} (last activity: {most_recent})")
    print()

    # Dimension 1
    if components or tests or org_policies:
        print("## Dimension 1: Formal Model (SysML ComplianceGraph)\n")
        if components:
            print(f"- **Satisfying Components**: {', '.join(components)}")
        if tests:
            print(f"- **Verifying Tests**: {', '.join(tests)}")
        if org_policies:
            print(f"- **Organization Policies**: {', '.join(org_policies)}")
        if source:
            print(f"- **Source**: {source}")
        print()

    # Dimension 2
    if practice_commits:
        tools = sorted({t for c in practice_commits for t in c.evidence_tools})
        print("## Dimension 2: Implementation Proof (Git History)\n")
        print(f"- **Commits**: {len(practice_commits)} tagged {pid} ({min(dates)} → {max(dates)})")
        if tools:
            print(f"- **Tools evidenced**: {', '.join(tools)}")
        for c in practice_commits[:3]:
            print(f"- \"{c.summary}\" ({c.date})")
        print()

    # Dimension 3
    if practice_scans:
        print("## Dimension 3: Validation Proof (Security Scans)\n")
        for s in practice_scans:
            print(f"- **{s.tool}**: exit {s.exit_code}, {len(s.files)} files")
        if scan_ts:
            print(f"- **Last scan**: {scan_ts}")
        print()

    # Dimension 4
    if pipeline_practice:
        print("## Dimension 4: Pipeline Infrastructure\n")
        print(f"- **Variant**: {pipeline.variant_id}")
        print(f"- **Stage**: {pipeline_practice.stage}")
        print(f"- **Evidence**: {pipeline_practice.evidence}")
        print()

    return 0


if __name__ == "__main__":
    sys.exit(main())
