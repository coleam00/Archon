#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12"
# ///
"""Validate SSDF compliance documentation for completeness and consistency."""

import sys
import re
from pathlib import Path

# Optional: SysML ComplianceGraph parser for satisfy-relationship checks
try:
    sys.path.insert(0, str(Path.home() / ".kiro" / "scripts"))
    from sysml_graph import scan_specs as scan_compliance_graphs
    _HAS_SYSML_GRAPH = True
except ImportError:
    _HAS_SYSML_GRAPH = False

FAMILIES = {
    "PO": {"name": "PREPARE-ORGANIZATION", "practices": ["PO.1","PO.2","PO.3","PO.4","PO.5"]},
    "PS": {"name": "PROTECT-SOFTWARE", "practices": ["PS.1","PS.2","PS.3"]},
    "PW": {"name": "PRODUCE-WELL-SECURED-SOFTWARE", "practices": ["PW.1","PW.2","PW.4","PW.5","PW.6","PW.7","PW.8","PW.9"]},
    "RV": {"name": "RESPOND-VULNERABILITIES", "practices": ["RV.1","RV.2","RV.3"]},
}

SUB_PRACTICES = {
    "PO": ["PO.1.1","PO.1.2","PO.1.3","PO.2.1","PO.2.2","PO.2.3","PO.3.1","PO.3.2","PO.3.3","PO.4.1","PO.4.2","PO.5.1","PO.5.2"],
    "PS": ["PS.1.1","PS.2.1","PS.3.1","PS.3.2"],
    "PW": ["PW.1.1","PW.1.2","PW.1.3","PW.2.1","PW.4.1","PW.4.2","PW.4.4","PW.5.1","PW.6.1","PW.6.2","PW.7.1","PW.7.2","PW.8.1","PW.8.2","PW.9.1","PW.9.2"],
    "RV": ["RV.1.1","RV.1.2","RV.1.3","RV.2.1","RV.2.2","RV.3.1","RV.3.2","RV.3.3","RV.3.4"],
}

# T2 (Organization-Deferred) sub-practices — org processes outside pipeline scope
T2_SUB_PRACTICES = {"PO.1.3","PO.2.1","PO.2.2","PO.2.3","PO.5.2","RV.1.3","RV.3.4"}


def find_compliance_dir(start_path="."):
    candidate = Path(start_path) / "docs" / "compliance-by-family"
    return candidate if candidate.is_dir() else None


def validate_mapping_doc(filepath, family_code):
    errors, warnings = [], []
    content = filepath.read_text()

    t1_count, t2_count = 0, 0
    for sp in SUB_PRACTICES.get(family_code, []):
        if not re.search(rf"###\s+{re.escape(sp)}", content):
            errors.append(f"Missing sub-practice section: {sp}")
        elif sp in T2_SUB_PRACTICES:
            t2_count += 1
            if not re.search(rf"{re.escape(sp)}.*Organization-Deferred", content, re.DOTALL):
                warnings.append(f"{sp} is T2 but missing Organization-Deferred marker")
        else:
            t1_count += 1

    if not re.findall(r"\*\*Gaps\*\*:", content):
        warnings.append("No **Gaps**: sections found")

    if "Coverage Summary" not in content:
        warnings.append("Missing Coverage Summary table")

    return errors, warnings


def validate_gap_remediation(filepath, family_code, compliance_dir):
    errors, warnings = [], []
    content = filepath.read_text()

    if "Gap Inventory" not in content:
        errors.append("Missing Gap Inventory table")
    if "Prioritized Remediation Roadmap" not in content:
        warnings.append("Missing Prioritized Remediation Roadmap")
    if "Expected Coverage After Remediation" not in content:
        warnings.append("Missing Expected Coverage table")
    if "Attestation" not in content:
        warnings.append("Missing Attestation section")

    family_dir = compliance_dir / family_code
    shared_dir = compliance_dir / "SHARED"
    for match in re.finditer(r"Create `([^`]+)`", content):
        ref_path = match.group(1)
        basename = Path(ref_path).name
        # Check family dir, then SHARED/, then other family dirs
        if (family_dir / basename).exists():
            continue
        if shared_dir.is_dir() and (shared_dir / basename).exists():
            continue
        # Check if path references another family (e.g., PW/RISK-REGISTER.md)
        if (compliance_dir / ref_path.replace("docs/compliance-by-family/", "")).exists():
            continue
        warnings.append(f"Referenced artifact not yet created: {basename}")

    return errors, warnings


def validate_compliance_graph(compliance_dir, mapping_files):
    """Check that practices marked Implemented have satisfy relationships in ComplianceGraph blocks."""
    warnings = []
    if not _HAS_SYSML_GRAPH:
        return warnings

    specs_dir = Path(compliance_dir).parents[1] / ".kiro" / "specs"
    if not specs_dir.is_dir():
        return warnings

    graph = scan_compliance_graphs(str(specs_dir))
    if not graph.satisfy:
        return warnings  # No ComplianceGraph blocks found — skip silently

    for family_code, info in FAMILIES.items():
        mapping_file = compliance_dir / f"{family_code}-{info['name']}.md"
        if not mapping_file.exists():
            continue
        content = mapping_file.read_text()
        for sp in SUB_PRACTICES.get(family_code, []):
            if sp in T2_SUB_PRACTICES:
                continue
            # Check if sub-practice is marked as Implemented
            pattern = rf"###\s+{re.escape(sp)}.*?(?=###|\Z)"
            section = re.search(pattern, content, re.DOTALL)
            if not section:
                continue
            section_text = section.group(0)
            if "IMPLEMENTED" in section_text.upper() and "NOT IMPLEMENTED" not in section_text.upper():
                if not graph.components_for(sp):
                    warnings.append(f"{sp} marked Implemented but has no satisfy relationship in ComplianceGraph")

    return warnings


def main():
    start_path = sys.argv[1] if len(sys.argv) > 1 else "."
    compliance_dir = find_compliance_dir(start_path)

    if not compliance_dir:
        print("❌ Could not find compliance-by-family/ directory")
        print("   Expected: docs/compliance-by-family/")
        sys.exit(1)

    print(f"Validating: {compliance_dir}\n")
    total_errors, total_warnings = 0, 0

    # Validate profile reference
    profile_id_file = compliance_dir / ".profile-id"
    if profile_id_file.exists():
        profile_id = profile_id_file.read_text().strip()
        profile_dir = Path(__file__).parent.parent / "assets" / "pipeline-profiles"
        profile_file = profile_dir / f"{profile_id}.yaml"
        if profile_file.exists():
            print(f"📋 Pipeline profile: {profile_id} ✅")
        else:
            print(f"📋 Pipeline profile: {profile_id} ❌ (not found in library)")
            total_errors += 1
    else:
        print("📋 .profile-id: NOT FOUND (run select-profile first)")
        total_warnings += 1

    print()

    # Validate each family
    for code, info in FAMILIES.items():
        mapping_file = compliance_dir / f"{code}-{info['name']}.md"
        gap_file = compliance_dir / code / "GAP-REMEDIATION.md"

        print(f"{'='*50}")
        print(f"Family: {code} — {info['name']}")
        print(f"{'='*50}")

        if mapping_file.exists():
            errors, warnings = validate_mapping_doc(mapping_file, code)
            print(f"  Mapping: {len(errors)} errors, {len(warnings)} warnings")
            for e in errors:
                print(f"    ❌ {e}")
            for w in warnings:
                print(f"    ⚠️  {w}")
            total_errors += len(errors)
            total_warnings += len(warnings)
        else:
            print(f"  Mapping: NOT FOUND ({mapping_file.name})")

        if gap_file.exists():
            errors, warnings = validate_gap_remediation(gap_file, code, compliance_dir)
            print(f"  Gap Remediation: {len(errors)} errors, {len(warnings)} warnings")
            for e in errors:
                print(f"    ❌ {e}")
            for w in warnings:
                print(f"    ⚠️  {w}")
            total_errors += len(errors)
            total_warnings += len(warnings)
        else:
            print("  Gap Remediation: NOT FOUND")

        family_dir = compliance_dir / code
        if family_dir.is_dir():
            artifacts = [f.name for f in family_dir.iterdir() if f.name != "GAP-REMEDIATION.md" and f.suffix == ".md"]
            if artifacts:
                print(f"  Artifacts: {len(artifacts)} found — {', '.join(sorted(artifacts))}")
            else:
                print("  Artifacts: none scaffolded yet")
        print()

    print(f"{'='*50}")
    print(f"SUMMARY: {total_errors} errors, {total_warnings} warnings")

    # ComplianceGraph consistency check
    graph_warnings = validate_compliance_graph(compliance_dir, FAMILIES)
    if graph_warnings:
        print(f"\n📐 SysML ComplianceGraph consistency: {len(graph_warnings)} warnings")
        for w in graph_warnings:
            print(f"    ⚠️  {w}")
        total_warnings += len(graph_warnings)

    # Report shared artifacts
    shared_dir = compliance_dir / "SHARED"
    if shared_dir.is_dir():
        shared_artifacts = [f.name for f in shared_dir.iterdir() if f.suffix == ".md"]
        if shared_artifacts:
            print(f"  Shared artifacts: {len(shared_artifacts)} — {', '.join(sorted(shared_artifacts))}")

    if total_errors == 0:
        print("✅ All checks passed")
    else:
        print("❌ Fix errors before proceeding")
    sys.exit(1 if total_errors > 0 else 0)


if __name__ == "__main__":
    main()
