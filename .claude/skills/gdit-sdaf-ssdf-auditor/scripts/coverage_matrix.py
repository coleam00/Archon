#!/usr/bin/env python3
"""Generate SSDF compliance coverage matrix — NIST 800-218 format, multi-dimensional."""
import argparse
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path.home() / ".kiro" / "scripts"))
from sysml_graph import scan_specs  # noqa: E402
from git_evidence import collect_commits, build_practice_index  # noqa: E402
from scan_evidence import SCANNER_PRACTICE_MAP  # noqa: E402
from ssdf_attestation_sections import T2_PRACTICES  # noqa: E402
from pipeline_evidence import load_pipeline_variant  # noqa: E402

_FAMILIES = {"PO": "Prepare the Organization", "PS": "Protect the Software",
             "PW": "Produce Well-Secured Software", "RV": "Respond to Vulnerabilities"}

_REFS_DIR = Path.home() / ".kiro" / "skills" / "ssdf-compliance-mapping" / "references"

# Practices that CAN be evidenced by security scanners
_SCAN_ASSESSABLE = set()
for _tools_practices in SCANNER_PRACTICE_MAP.values():
    _SCAN_ASSESSABLE.update(_tools_practices)


def _load_t2_org_evidence() -> dict[str, str]:
    """Load org-standards crosswalk for T2 practices."""
    crosswalk = _REFS_DIR / "ORG-STANDARDS-SSDF-CROSSWALK.md"
    if not crosswalk.exists():
        return {}
    content = crosswalk.read_text()
    evidence: dict[str, str] = {}
    current_practice = ""
    import re
    for line in content.splitlines():
        m = re.match(r"### ([A-Z]{2}\.\d+\.\d+):", line)
        if m:
            current_practice = m.group(1)
        elif current_practice in T2_PRACTICES and line.startswith("- "):
            if current_practice not in evidence:
                evidence[current_practice] = line[2:].split(":")[0]
    return evidence


def _build_scan_evidence_from_git(commits) -> dict[str, set[str]]:
    """Build practice → set of scanner tools from git Evidence: fields."""
    # Map tool names found in commits back to practices
    practice_tools: dict[str, set[str]] = {}
    for commit in commits:
        for tool in commit.evidence_tools:
            practices = SCANNER_PRACTICE_MAP.get(tool, [])
            for pid in practices:
                practice_tools.setdefault(pid, set()).add(tool)
    return practice_tools


def main() -> int:
    parser = argparse.ArgumentParser(description="SSDF coverage matrix (NIST 800-218 format)")
    parser.add_argument("--specs-dir", default=".kiro/specs", help="Path to specs directory")
    parser.add_argument("--project", default=".", help="Project root directory")
    parser.add_argument("--days", type=int, default=365, help="Git lookback days")
    parser.add_argument("--output", help="Write to file instead of stdout")
    args = parser.parse_args()

    project = Path(args.project)
    graph = scan_specs(args.specs_dir)
    commits = collect_commits(project, args.days)
    git_index = build_practice_index(commits)
    scan_evidence = _build_scan_evidence_from_git(commits)

    # Dimension 4: Pipeline
    pipeline = load_pipeline_variant(project)
    pipeline_ids = pipeline.covered_ids() if pipeline else set()

    # Collect all known practice IDs
    all_pids = sorted(set(list(graph.satisfy) + list(graph.verify) + list(git_index) + list(scan_evidence) + list(pipeline_ids)))

    lines = ["# NIST SP 800-218 Compliance Coverage Matrix", ""]
    lines.append(f"**Project**: {project.resolve().name}")
    lines.append(f"**Generated**: {datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S')}Z")
    lines.append(f"**Assessment Period**: {args.days} days")
    lines.append("")
    lines.append("---")

    # Separate T1 and T2
    t1_pids = [p for p in all_pids if p not in T2_PRACTICES]
    t2_pids = [p for p in all_pids if p in T2_PRACTICES]

    covered = partial = gaps = 0

    # Group by family
    for family, family_name in _FAMILIES.items():
        family_pids = [p for p in t1_pids if p.startswith(family)]
        if not family_pids:
            continue
        lines.append("")
        lines.append(f"## {family} — {family_name}")
        lines.append("")
        lines.append("| Practice | SysML | Commits | Scans | Pipeline | Overall |")
        lines.append("|----------|-------|---------|-------|----------|---------|")

        for pid in family_pids:
            has_sysml = bool(graph.components_for(pid))
            commit_count = len(git_index.get(pid, []))
            scan_applicable = pid in _SCAN_ASSESSABLE
            has_scans = bool(scan_evidence.get(pid)) if scan_applicable else False
            has_pipeline = pid in pipeline_ids

            # Count dimensions (scans only count if applicable)
            dims = sum([has_sysml, commit_count > 0, has_scans, has_pipeline])
            # For non-scan practices, 2 dims = SysML + commits is sufficient
            needed = 2

            if dims >= needed:
                status = "✅ Evidenced"
                covered += 1
            elif dims >= 1:
                status = "⚠️ Partial"
                partial += 1
            else:
                status = "❌ Gap"
                gaps += 1

            sysml_str = "✅" if has_sysml else "—"
            commits_str = str(commit_count) if commit_count else "—"
            if not scan_applicable:
                scans_str = "N/A"
            elif has_scans:
                tools = ", ".join(sorted(scan_evidence[pid]))
                scans_str = f"✅ {tools}"
            else:
                scans_str = "—"
            pipeline_str = f"✅" if has_pipeline else "—"
            lines.append(f"| {pid} | {sysml_str} | {commits_str} | {scans_str} | {pipeline_str} | {status} |")

    # T2 section
    if t2_pids:
        t2_evidence = _load_t2_org_evidence()
        lines.append("")
        lines.append("## T2 — Organization-Deferred Practices")
        lines.append("")
        lines.append("*These practices require organizational policy/process evidence, not pipeline artifacts.*")
        lines.append("")
        lines.append("| Practice | Status | Org-Standards Evidence |")
        lines.append("|----------|--------|----------------------|")
        for pid in sorted(t2_pids):
            org_ref = t2_evidence.get(pid, "See ORG-STANDARDS-SSDF-CROSSWALK.md")
            lines.append(f"| {pid} | ORG | {org_ref} |")

    # Summary
    total = covered + partial + gaps
    pct = int((covered + partial) / total * 100) if total else 0
    lines.append("")
    lines.append("---")
    lines.append("")
    lines.append("## Summary")
    lines.append("")
    lines.append(f"- **T1 Coverage**: {covered}/{total} evidenced ({pct}%), {partial} partial, {gaps} gaps")
    lines.append(f"- **T2 Practices**: {len(t2_pids)} (organization-deferred, excluded from coverage %)")
    lines.append(f"- **Scan-assessable practices**: {', '.join(sorted(_SCAN_ASSESSABLE))}")

    output = "\n".join(lines) + "\n"
    if args.output:
        Path(args.output).write_text(output)
        print(f"Written to {args.output}")
    else:
        print(output)
    return 0


if __name__ == "__main__":
    sys.exit(main())
