"""Scan evidence module — reads security scan manifest and maps to SSDF practices.

Parses .security-scans/.scan-manifest.json for tool execution evidence.
Used by ssdf-auditor and ssdf-development skills.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

# Scanner → NIST 800-218 practice mapping
SCANNER_PRACTICE_MAP: dict[str, list[str]] = {
    "gitleaks": ["PW.7.2"],
    "semgrep": ["PW.7.2", "PW.4.2"],
    "trivy": ["PW.4.1", "RV.1.1"],
    "checkov": ["PW.9.1"],
    "ruff": ["PW.7.2"],
    "pyright": ["PW.7.2"],
    "cfn-lint": ["PW.9.1"],
    "cfn-guard": ["PW.9.1"],
}


@dataclass
class ScanResult:
    tool: str
    files: list[str] = field(default_factory=list)
    exit_code: int = 0
    timestamp: str = ""
    practices: list[str] = field(default_factory=list)


def read_manifest(project_dir: Path | None = None) -> list[ScanResult] | None:
    """Read .security-scans/.scan-manifest.json. Returns None if not found."""
    root = project_dir or Path(".")
    manifest_path = root / ".security-scans" / ".scan-manifest.json"
    if not manifest_path.exists():
        return None

    try:
        data = json.loads(manifest_path.read_text())
    except (json.JSONDecodeError, OSError):
        return None

    timestamp = data.get("timestamp", "")
    results = []
    for tool_name, tool_data in data.get("tools", {}).items():
        practices = SCANNER_PRACTICE_MAP.get(tool_name, [])
        results.append(ScanResult(
            tool=tool_name,
            files=tool_data.get("files", []),
            exit_code=tool_data.get("exit_code", -1),
            timestamp=timestamp,
            practices=practices,
        ))
    return results


def map_scanners_to_practices(results: list[ScanResult]) -> dict[str, list[ScanResult]]:
    """Group scan results by practice ID. Returns {practice_id: [ScanResult]}."""
    index: dict[str, list[ScanResult]] = {}
    for r in results:
        for p in r.practices:
            index.setdefault(p, []).append(r)
    return index
