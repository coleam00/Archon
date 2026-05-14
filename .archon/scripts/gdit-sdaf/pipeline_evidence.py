"""Pipeline evidence module — reads SSDF pipeline variant for inherited controls.

Loads variant definition from ~/.kiro/config/ssdf-pipeline-variants/ and provides
practice-level inheritance data for the ssdf-auditor skill.
"""
from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field
from pathlib import Path

_VARIANT_ID_RE = re.compile(r"^[a-z]+-[a-z]+-v\d+$")


@dataclass
class PipelinePractice:
    practice_id: str
    evidence: str
    stage: str


@dataclass
class PipelineVariant:
    variant_id: str
    description: str
    practices: list[PipelinePractice] = field(default_factory=list)

    def covers(self, practice_id: str) -> PipelinePractice | None:
        for p in self.practices:
            if p.practice_id == practice_id:
                return p
        return None

    def covered_ids(self) -> set[str]:
        return {p.practice_id for p in self.practices}


def load_pipeline_variant(project_dir: Path | None = None) -> PipelineVariant | None:
    """Load pipeline variant from project.yaml ssdf.pipeline field. Returns None if not configured."""
    root = project_dir or Path(".")
    yaml_path = root / ".kiro" / "config" / "project.yaml"
    if not yaml_path.exists():
        return None

    # Parse ssdf.pipeline from project.yaml
    variant_id = ""
    in_ssdf = False
    for line in yaml_path.read_text().splitlines():
        stripped = line.strip()
        if stripped.startswith("ssdf:"):
            in_ssdf = True
            continue
        if in_ssdf and not line.startswith(" ") and not line.startswith("\t") and stripped:
            break
        if in_ssdf and stripped.startswith("pipeline:"):
            variant_id = stripped.split(":", 1)[1].strip().split("#")[0].strip().strip('"').strip("'")

    if not variant_id:
        return None

    if not _VARIANT_ID_RE.match(variant_id):
        return None

    # Load variant file
    variants_dir = os.environ.get("SSDF_VARIANTS_DIR",
                                   str(Path.home() / ".kiro" / "config" / "ssdf-pipeline-variants"))
    variant_path = Path(variants_dir) / f"{variant_id}.json"
    if not variant_path.exists():
        return None

    try:
        data = json.loads(variant_path.read_text())
    except (json.JSONDecodeError, OSError):
        return None

    practices = [
        PipelinePractice(
            practice_id=p["practice_id"],
            evidence=p.get("evidence", ""),
            stage=p.get("stage", ""),
        )
        for p in data.get("inheritable_practices", [])
    ]

    return PipelineVariant(
        variant_id=data.get("variant_id", variant_id),
        description=data.get("description", ""),
        practices=practices,
    )
