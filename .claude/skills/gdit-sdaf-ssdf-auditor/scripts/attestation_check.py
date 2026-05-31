#!/usr/bin/env python3
"""Check readiness to sign CISA SSDF attestation form (multi-dimensional evidence)."""
import argparse
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path.home() / ".kiro" / "scripts"))
from sysml_graph import scan_specs  # noqa: E402
from ssdf_attestation_sections import ATTESTATION_SECTIONS  # noqa: E402
from pipeline_evidence import load_pipeline_variant  # noqa: E402

_COMPLIANCE_RE = __import__("re").compile(r"([A-Z]{2}\.\d+\.\d+)")


def _get_commit_practices(project_dir: Path, days: int = 365) -> set[str]:
    """Extract practice IDs from git Compliance: tags."""
    result = subprocess.run(
        ["git", "log", f"--since={days} days ago", "--format=%B"],
        cwd=project_dir, capture_output=True, text=True,
    )
    if result.returncode != 0:
        return set()
    practices = set()
    for line in result.stdout.splitlines():
        if line.strip().startswith("Compliance:"):
            practices.update(_COMPLIANCE_RE.findall(line))
    return practices


def main() -> int:
    parser = argparse.ArgumentParser(description="CISA attestation readiness check")
    parser.add_argument("--specs-dir", default=".kiro/specs", help="Path to specs directory")
    parser.add_argument("--project", default=".", help="Project root directory")
    parser.add_argument("--days", type=int, default=365, help="Git lookback days")
    parser.add_argument("--output", help="Write to file instead of stdout")
    args = parser.parse_args()

    project = Path(args.project)
    graph = scan_specs(args.specs_dir)
    commit_practices = _get_commit_practices(project, args.days)
    pipeline = load_pipeline_variant(project)
    pipeline_ids = pipeline.covered_ids() if pipeline else set()

    lines = ["# CISA SSDF Attestation Readiness", ""]
    lines.append(f"**Project**: {project.resolve().name}")
    lines.append(f"**Generated**: {datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S')}Z")
    lines.append(f"**Attestation Form**: CISA Secure Software Development Attestation (OMB M-22-18)")
    lines.append(f"**Assessment Period**: {args.days} days")
    lines.append("")
    lines.append("---")
    lines.append("")
    lines.append("| Section | Required Practices | SysML | Commits | Overall |")
    lines.append("|---------|-------------------|-------|---------|---------|")

    all_ready = True
    gap_details = []

    for section in ATTESTATION_SECTIONS:
        sysml_ok = all(bool(graph.components_for(p)) for p in section["practices"])
        commits_ok = all(p in commit_practices for p in section["practices"])
        pipeline_ok = all(p in pipeline_ids for p in section["practices"])

        if sysml_ok and (commits_ok or pipeline_ok):
            overall = "✅ Ready"
        elif sysml_ok or commits_ok or pipeline_ok:
            overall = "⚠️ Partial"
            all_ready = False
            missing = []
            for p in section["practices"]:
                dims = []
                if not graph.components_for(p):
                    dims.append("SysML")
                if p not in commit_practices:
                    dims.append("commits")
                if dims:
                    missing.append(f"{p} (missing {', '.join(dims)})")
            gap_details.append((section["title"], missing))
        else:
            overall = "❌ Not Ready"
            all_ready = False
            gap_details.append((section["title"], [f"{p} (no evidence)" for p in section["practices"]]))

        practices_str = ", ".join(section["practices"])
        sysml_str = "✅" if sysml_ok else "❌"
        commits_str = "✅" if commits_ok else "❌"
        lines.append(f"| {section['title']} | {practices_str} | {sysml_str} | {commits_str} | {overall} |")

    lines.append("")
    lines.append("---")
    lines.append("")
    lines.append("## Verdict")
    lines.append("")

    if all_ready:
        lines.append("**Ready to attest**: All sections have evidence across both dimensions (formal model + implementation proof).")
    else:
        lines.append(f"**Not ready to attest**: {len(gap_details)} section(s) have incomplete evidence.")
        lines.append("")
        lines.append("### Required Remediation Before Signing")
        lines.append("")
        for title, gaps in gap_details:
            lines.append(f"**{title}**:")
            for g in gaps:
                lines.append(f"- {g}")
            lines.append("")

    output = "\n".join(lines) + "\n"
    if args.output:
        Path(args.output).write_text(output)
        print(f"Written to {args.output}")
    else:
        print(output)
    return 0


if __name__ == "__main__":
    sys.exit(main())
