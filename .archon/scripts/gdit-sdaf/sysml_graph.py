# /// script
# requires-python = ">=3.12"
# ///
"""SysML ComplianceGraph block parser — extracts satisfy/verify/org-ref mappings."""

from __future__ import annotations

import os
import re
import sys
from dataclasses import dataclass, field


@dataclass
class ComplianceGraph:
    satisfy: dict[str, list[str]] = field(default_factory=dict)
    verify: dict[str, list[str]] = field(default_factory=dict)
    org_refs: dict[str, list[str]] = field(default_factory=dict)
    sources: dict[str, str] = field(default_factory=dict)

    def components_for(self, practice_id: str) -> list[str]:
        return self.satisfy.get(practice_id, [])

    def tests_for(self, practice_id: str) -> list[str]:
        return self.verify.get(practice_id, [])

    def org_policies_for(self, practice_id: str) -> list[str]:
        return self.org_refs.get(practice_id, [])

    def coverage_report(self) -> dict[str, dict[str, object]]:
        all_ids = sorted(set(list(self.satisfy) + list(self.verify) + list(self.org_refs)))
        return {
            pid: {
                "components": self.components_for(pid),
                "tests": self.tests_for(pid),
                "org_policies": self.org_policies_for(pid),
                "source": self.sources.get(pid, ""),
            }
            for pid in all_ids
        }


def _extract_compliance_block(content: str) -> str | None:
    """Find 'package ComplianceGraph {' and extract the full block via brace counting."""
    m = re.search(r"package\s+ComplianceGraph\s*\{", content)
    if not m:
        return None
    start = m.end()
    depth = 1
    i = start
    while i < len(content) and depth > 0:
        if content[i] == "{":
            depth += 1
        elif content[i] == "}":
            depth -= 1
        i += 1
    return content[start : i - 1]


_NIST_ID_RE = re.compile(r"([A-Z]{2}\.\d+\.\d+)")


def _parse_doc_string(doc: str) -> tuple[str | None, list[str]]:
    """Parse 'NIST 800-218 XX.N.N | org refs' -> (practice_id, [org_refs])."""
    if "|" not in doc:
        return None, []
    left, right = doc.split("|", 1)
    m = _NIST_ID_RE.search(left)
    if not m:
        return None, []
    practice_id = m.group(1)
    org_refs = [r.strip() for r in right.split(",") if r.strip()]
    return practice_id, org_refs


def parse_compliance_graph(path: str) -> ComplianceGraph:
    """Parse a single model.sysml file and return its ComplianceGraph."""
    graph = ComplianceGraph()
    try:
        with open(path, encoding="utf-8") as f:
            content = f.read()
    except (OSError, UnicodeDecodeError) as exc:
        print(f"sysml_graph: warning: cannot read {path}: {exc}", file=sys.stderr)
        return graph

    block = _extract_compliance_block(content)
    if block is None:
        return graph

    # Step 1: Extract requirement defs and their doc strings -> map def_name -> (practice_id, org_refs)
    req_map: dict[str, str] = {}  # def_name -> practice_id
    for m in re.finditer(
        r"requirement\s+def\s+(\w+)\s*\{[^}]*doc\s*/\*\s*(.*?)\s*\*/",
        block,
        re.DOTALL,
    ):
        def_name = m.group(1)
        doc_text = m.group(2).strip()
        practice_id, org_list = _parse_doc_string(doc_text)
        if practice_id is None:
            print(
                f"sysml_graph: warning: malformed doc string for {def_name} in {path}",
                file=sys.stderr,
            )
            continue
        req_map[def_name] = practice_id
        if org_list:
            graph.org_refs.setdefault(practice_id, []).extend(org_list)
        graph.sources.setdefault(practice_id, path)

    # Step 2: Extract part satisfy relationships
    for m in re.finditer(
        r"part\s+(?:def\s+)?(\w+)\s*\{([^}]*)\}",
        block,
    ):
        component = m.group(1)
        body = m.group(2)
        for sm in re.finditer(r"satisfy\s+requirement\s+(\w+)\s*;", body):
            req_name = sm.group(1)
            pid = req_map.get(req_name)
            if pid:
                graph.satisfy.setdefault(pid, []).append(component)

    # Step 3: Extract verification verify relationships
    for m in re.finditer(
        r"verification\s+(\w+)\s*\{\s*verify\s+requirement\s+(\w+)\s*;\s*subject\s*:\s*(\w+)\s*;",
        block,
    ):
        test_name, req_name = m.group(1), m.group(2)
        pid = req_map.get(req_name)
        if pid:
            graph.verify.setdefault(pid, []).append(test_name)

    return graph


def _merge(target: ComplianceGraph, source: ComplianceGraph) -> None:
    """Merge source graph into target, extending lists and keeping first source."""
    for pid, comps in source.satisfy.items():
        target.satisfy.setdefault(pid, []).extend(comps)
    for pid, tests in source.verify.items():
        target.verify.setdefault(pid, []).extend(tests)
    for pid, refs in source.org_refs.items():
        target.org_refs.setdefault(pid, []).extend(refs)
    for pid, src in source.sources.items():
        target.sources.setdefault(pid, src)


def scan_specs(specs_dir: str) -> ComplianceGraph:
    """Walk specs_dir for model.sysml files, parse and merge all ComplianceGraph blocks."""
    merged = ComplianceGraph()
    if not os.path.isdir(specs_dir):
        print(f"sysml_graph: warning: directory not found: {specs_dir}", file=sys.stderr)
        return merged
    for root, _dirs, files in os.walk(specs_dir):
        for fname in files:
            if fname == "model.sysml":
                _merge(merged, parse_compliance_graph(os.path.join(root, fname)))
    return merged
