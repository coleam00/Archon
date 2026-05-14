# /// script
# requires-python = ">=3.12"
# ///
"""SysML Compliance Validator — detects missing, stale, orphaned correlations in ComplianceGraph blocks."""

from __future__ import annotations

import os
import re
import sys
from dataclasses import dataclass

# Import parser from same directory
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import sysml_graph  # noqa: E402


@dataclass
class Finding:
    severity: str  # 'WARN' or 'ADVISORY'
    message: str


@dataclass
class _CatalogRow:
    practice_ids: list[str]
    keywords: list[str]
    corporate_policy: str


_NIST_ID_RE = re.compile(r"[A-Z]{2}\.\d+\.\d+")

# T2 Organization-Deferred sub-practices — cannot be satisfied by code artifacts.
# See ~/.kiro/skills/ssdf-compliance-mapping/references/SUB-PRACTICE-TIERS.md
_T2_EXCLUDED: set[str] = {"PO.1.3", "PO.2.1", "PO.2.2", "PO.2.3", "PO.5.2", "RV.1.3", "RV.3.4"}


def _parse_catalog(catalog_path: str) -> tuple[list[_CatalogRow], list[_CatalogRow]]:
    """Parse the compliance pattern catalog markdown. Returns (t1_rows, t2_rows)."""
    try:
        with open(catalog_path, encoding="utf-8") as f:
            content = f.read()
    except OSError:
        return [], []

    t1_rows: list[_CatalogRow] = []
    t2_rows: list[_CatalogRow] = []

    # Split into sections by ## headers
    sections = re.split(r"^## ", content, flags=re.MULTILINE)

    for section in sections:
        lines = section.strip().splitlines()
        if not lines:
            continue
        header = lines[0].strip()
        is_t2 = "T2" in header or "Organization-Deferred" in header

        # Find table rows (skip header and separator)
        in_table = False
        for line in lines:
            stripped = line.strip()
            if not stripped.startswith("|"):
                in_table = False
                continue
            cells = [c.strip() for c in stripped.split("|")]
            # Remove empty first/last from leading/trailing |
            cells = [c for c in cells if c]
            if not cells:
                continue
            # Skip separator rows
            if all(set(c) <= {"-", ":"} for c in cells):
                in_table = True
                continue
            # Skip header rows (check for "Pattern" or "Sub-Practice")
            if cells[0] in ("Pattern", "Sub-Practice"):
                in_table = True
                continue
            if not in_table:
                continue

            if is_t2 and len(cells) >= 3:
                # T2: Sub-Practice | NIST 800-218 | Corporate Policy
                ids = _NIST_ID_RE.findall(cells[1])
                if ids:
                    t2_rows.append(_CatalogRow(
                        practice_ids=ids,
                        keywords=[],
                        corporate_policy=cells[2] if len(cells) > 2 else "",
                    ))
            elif not is_t2 and len(cells) >= 5:
                # T1: Pattern | NIST 800-218 | NIST 800-171 | Corporate Policy | Trigger Keywords
                ids = _NIST_ID_RE.findall(cells[1])
                raw_keywords = cells[4]
                keywords = [
                    k.strip().strip("`")
                    for k in raw_keywords.split(",")
                    if k.strip().strip("`")
                ]
                if ids and keywords:
                    t1_rows.append(_CatalogRow(
                        practice_ids=ids,
                        keywords=keywords,
                        corporate_policy=cells[3],
                    ))

    return t1_rows, t2_rows


def _read_design(spec_dir: str) -> str:
    """Read design.md content, return empty string if missing."""
    path = os.path.join(spec_dir, "design.md")
    try:
        with open(path, encoding="utf-8") as f:
            return f.read()
    except OSError:
        return ""


def _read_compliance_block_raw(spec_dir: str) -> str:
    """Read the raw ComplianceGraph block text from model.sysml."""
    path = os.path.join(spec_dir, "model.sysml")
    try:
        with open(path, encoding="utf-8") as f:
            content = f.read()
    except OSError:
        return ""
    m = re.search(r"package\s+ComplianceGraph\s*\{", content)
    if not m:
        return ""
    start = m.start()
    depth = 0
    i = m.end()
    depth = 1
    while i < len(content) and depth > 0:
        if content[i] == "{":
            depth += 1
        elif content[i] == "}":
            depth -= 1
        i += 1
    return content[start:i]


def _detect_missing(
    t1_rows: list[_CatalogRow],
    design_content: str,
    graph: sysml_graph.ComplianceGraph,
) -> list[Finding]:
    """Pattern Detection: keyword in design.md but no satisfy in ComplianceGraph -> WARN."""
    findings: list[Finding] = []
    design_lower = design_content.lower()
    satisfied_ids = set(graph.satisfy.keys())

    for row in t1_rows:
        matched = any(kw.lower() in design_lower for kw in row.keywords)
        if not matched:
            continue
        for pid in row.practice_ids:
            if pid in _T2_EXCLUDED:
                continue
            if pid not in satisfied_ids:
                findings.append(Finding(
                    severity="WARN",
                    message=f"LIKELY MISSING: design.md references pattern for {pid} but no satisfy in ComplianceGraph",
                ))
    return findings


def _detect_orphans(
    t1_rows: list[_CatalogRow],
    design_content: str,
    graph: sysml_graph.ComplianceGraph,
) -> list[Finding]:
    """Orphan Detection: satisfy in ComplianceGraph but no keyword in design.md -> ADVISORY."""
    findings: list[Finding] = []
    design_lower = design_content.lower()

    # Build practice_id -> keywords lookup from catalog
    pid_keywords: dict[str, list[str]] = {}
    for row in t1_rows:
        for pid in row.practice_ids:
            pid_keywords.setdefault(pid, []).extend(row.keywords)

    for pid in graph.satisfy:
        keywords = pid_keywords.get(pid, [])
        if not keywords:
            # Practice not in catalog — can't check, skip
            continue
        if not any(kw.lower() in design_lower for kw in keywords):
            findings.append(Finding(
                severity="ADVISORY",
                message=f"POSSIBLY STALE: ComplianceGraph has satisfy for {pid} but no matching keyword in design.md",
            ))
    return findings


def _detect_coverage_gaps(
    graph: sysml_graph.ComplianceGraph,
    all_specs_dir: str,
) -> list[Finding]:
    """Coverage Gap Detection: practice loses last satisfier across all specs -> WARN."""
    findings: list[Finding] = []
    full_graph = sysml_graph.scan_specs(all_specs_dir)

    for pid in sorted(full_graph.satisfy):
        if not full_graph.satisfy[pid]:
            findings.append(Finding(
                severity="WARN",
                message=f"COVERAGE GAP: {pid} has no satisfiers across any spec",
            ))
    return findings


def _validate_doc_strings(block_raw: str) -> list[Finding]:
    """Doc String Format Validation: check strict format -> ADVISORY if malformed."""
    findings: list[Finding] = []
    for m in re.finditer(
        r"requirement\s+def\s+(\w+)\s*\{[^}]*doc\s*/\*\s*(.*?)\s*\*/",
        block_raw,
        re.DOTALL,
    ):
        name = m.group(1)
        doc = m.group(2).strip()
        if not doc.startswith("NIST 800-218"):
            findings.append(Finding(
                severity="ADVISORY",
                message=f"Doc string for {name} does not start with 'NIST 800-218'",
            ))
            continue
        if "|" not in doc:
            findings.append(Finding(
                severity="ADVISORY",
                message=f"Doc string for {name} missing '|' separator",
            ))
            continue
        right = doc.split("|", 1)[1].strip()
        if not right:
            findings.append(Finding(
                severity="ADVISORY",
                message=f"Doc string for {name} has no content after '|' separator",
            ))
    return findings


def _check_corporate_policy(
    t1_rows: list[_CatalogRow],
    graph: sysml_graph.ComplianceGraph,
    block_raw: str,
) -> list[Finding]:
    """Corporate Policy Coverage: T1 practice with corp policy but no org ref in doc string -> ADVISORY."""
    findings: list[Finding] = []

    # Build set of practice IDs that have corporate policy in catalog
    pids_with_policy: set[str] = set()
    for row in t1_rows:
        if row.corporate_policy.strip():
            for pid in row.practice_ids:
                pids_with_policy.add(pid)

    # Extract doc strings from block, check org ref presence
    req_docs: dict[str, str] = {}
    for m in re.finditer(
        r"requirement\s+def\s+(\w+)\s*\{[^}]*doc\s*/\*\s*(.*?)\s*\*/",
        block_raw,
        re.DOTALL,
    ):
        req_docs[m.group(1)] = m.group(2).strip()

    # Map requirement def names to practice IDs via NIST ID extraction
    for name, doc in req_docs.items():
        ids = _NIST_ID_RE.findall(doc.split("|", 1)[0] if "|" in doc else doc)
        for pid in ids:
            if pid not in pids_with_policy:
                continue
            if pid not in graph.satisfy:
                continue
            if "|" not in doc:
                findings.append(Finding(
                    severity="ADVISORY",
                    message=f"Corporate policy expected for {pid} (requirement def {name}) but no '|' separator in doc string",
                ))
            else:
                right = doc.split("|", 1)[1].strip()
                if not right:
                    findings.append(Finding(
                        severity="ADVISORY",
                        message=f"Corporate policy expected for {pid} (requirement def {name}) but empty after '|'",
                    ))
    return findings


def validate_sysml_compliance(
    spec_dir: str,
    catalog_path: str,
    all_specs_dir: str | None = None,
) -> list[Finding]:
    """Validate ComplianceGraph block against design.md and compliance pattern catalog.

    Returns list of findings (WARN or ADVISORY). Returns empty list if no
    ComplianceGraph block exists or catalog is missing.
    """
    # Parse catalog
    t1_rows, _t2_rows = _parse_catalog(catalog_path)
    if not t1_rows:
        return []

    # Parse ComplianceGraph from this spec's model.sysml
    model_path = os.path.join(spec_dir, "model.sysml")
    graph = sysml_graph.parse_compliance_graph(model_path)

    # If no satisfy relationships, no ComplianceGraph block was found
    block_raw = _read_compliance_block_raw(spec_dir)
    if not block_raw:
        return []

    design_content = _read_design(spec_dir)
    findings: list[Finding] = []

    # 1. Pattern Detection (LIKELY MISSING)
    findings.extend(_detect_missing(t1_rows, design_content, graph))

    # 2. Orphan Detection (POSSIBLY STALE)
    findings.extend(_detect_orphans(t1_rows, design_content, graph))

    # 3. Coverage Gap Detection (cross-spec)
    if all_specs_dir:
        findings.extend(_detect_coverage_gaps(graph, all_specs_dir))

    # 4. Doc String Format Validation
    findings.extend(_validate_doc_strings(block_raw))

    # 5. Corporate Policy Coverage
    findings.extend(_check_corporate_policy(t1_rows, graph, block_raw))

    return findings
