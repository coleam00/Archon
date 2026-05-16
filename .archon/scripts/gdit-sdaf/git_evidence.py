"""Git evidence module — extracts SSDF compliance data from git commit history.

Parses git log for structured commits with Compliance: and Evidence: fields.
Used by ssdf-auditor and ssdf-development skills.
"""
from __future__ import annotations

import re
import subprocess
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path

_PRACTICE_RE = re.compile(r"([A-Z]{2}\.\d+\.\d+)")


@dataclass
class CommitEvidence:
    hash: str
    date: str
    summary: str
    practices: list[str] = field(default_factory=list)
    evidence_tools: list[str] = field(default_factory=list)


def collect_commits(project_dir: Path | None = None, days: int = 365) -> list[CommitEvidence]:
    """Parse git log for commits with Compliance: tags. Returns list of CommitEvidence."""
    cwd = str(project_dir) if project_dir else "."
    sep = "---COMMIT-SEP---"
    fmt = f"%H|%ai|%s%n%b{sep}"
    result = subprocess.run(
        ["git", "log", f"--since={days} days ago", f"--format={fmt}"],
        cwd=cwd, capture_output=True, text=True,
    )
    if result.returncode != 0:
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

        practices = _PRACTICE_RE.findall(compliance_match.group(1))
        tools: list[str] = []
        evidence_match = re.search(r"Evidence:\s*(.+)", body)
        if evidence_match:
            # Extract known tool names from evidence string
            known_tools = {"semgrep", "gitleaks", "trivy", "checkov", "ruff", "pyright",
                           "pytest", "cfn-lint", "cfn-guard", "py_compile", "kics"}
            evidence_text = evidence_match.group(1).lower()
            tools = [t for t in known_tools if t in evidence_text]

        commits.append(CommitEvidence(
            hash=parts[0][:8],
            date=parts[1].split()[0],
            summary=parts[2],
            practices=practices,
            evidence_tools=tools,
        ))
    return commits


def build_practice_index(commits: list[CommitEvidence]) -> dict[str, list[CommitEvidence]]:
    """Group commits by practice ID. Returns {practice_id: [commits]}."""
    index: dict[str, list[CommitEvidence]] = defaultdict(list)
    for c in commits:
        for p in c.practices:
            index[p].append(c)
    return index
