#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""Validate spec readiness for implementation against development-workflow.md quality gates.

Usage:
    python3 ~/.kiro/scripts/validate-spec.py .kiro/specs/<spec-name>   # Validate one spec
    python3 ~/.kiro/scripts/validate-spec.py --all                      # Validate all specs
    python3 ~/.kiro/scripts/validate-spec.py --verify .kiro/specs/<spec-name>  # Validate + verify implementation
    python3 ~/.kiro/scripts/validate-spec.py                            # Interactive menu (terminal)
                                                                # or list specs (AI/non-TTY)

Modes:
    Direct path   — Validates the specified spec directory. Use from AI or terminal.
    --all         — Validates every spec under .kiro/specs/ sequentially.
    Interactive   — When run with no args from a terminal (TTY), presents a numbered
                    menu of specs for the user to select.
    Non-TTY       — When run with no args under AI control (no TTY/stdin), lists all
                    specs with status and prints usage hints so the AI can call back
                    with a specific path.

Checks:
    1. All three spec files exist (requirements.md, design.md, tasks.md)
    2. All requirements have acceptance criteria
    3. Design has correctness properties for each workflow/component
    4. Design 'Implemented by' references exist and point to valid task numbers
    5. All requirements covered by tasks (bidirectional: REQ↔tasks, REQ↔design)
    6. All tasks reference requirements via Addresses
    7. All tasks reference design sections, and anchors resolve to actual headings
    8. Testing readiness based on project.yaml testing mode

Exit codes:
    0 — All quality gates passed
    1 — One or more failures
    2 — Usage error or no selection made
"""

import re
import sys
from pathlib import Path

# Conditional import: SysML compliance validator (advisory checks)
_sysml_validator = None
try:
    _scripts_dir = str(Path.home() / ".kiro" / "scripts")
    if Path(_scripts_dir, "sysml_validator.py").exists():
        sys.path.insert(0, _scripts_dir)
        import sysml_validator as _sysml_validator  # type: ignore[no-redef]
        sys.path.pop(0)
except Exception:
    _sysml_validator = None  # silently skip if import fails

PASS = "✅"
FAIL = "❌"
WARN = "⚠️"
INFO = "ℹ️"

REMEDIATION = {
    "LIKELY MISSING": "→ Add satisfy requirement for this practice in ComplianceGraph block",
    "POSSIBLY STALE": "→ Add matching keyword to design.md or remove the satisfy from ComplianceGraph",
    "Corporate policy expected": "→ Add org standard reference after '|' in the requirement def doc string",
    "COVERAGE GAP": "→ Add satisfy relationship for this practice in another spec's ComplianceGraph",
    "MISSING acceptance criteria": "→ Add **Acceptance Criteria:** under the REQ section",
    "MISSING": "→ Create the file in the spec directory",
    "No REQ-N sections": "→ Add ## REQ-1: or ## Requirement 1: sections to requirements.md",
    "No correctness properties": "→ Add **Correctness Properties:** sections to design.md",
    "No 'Implemented by'": "→ Add **Implemented by**: Task N to design sections",
    "does not exist in tasks.md": "→ Add ### Task N: to tasks.md or fix the Implemented by reference",
    "has no implementing task": "→ Add **Addresses**: {id} to a task in tasks.md",
    "has no Addresses": "→ Add **Addresses**: REQ-N, or **Reqs**: REQ-N, or (REQ-N) in the task header",
    "does not exist in requirements": "→ Remove the REQ reference from design or add it to requirements.md",
    "not referenced in any design": "→ Add (REQ-N) to a ## or ### section header, or **Addresses**: REQ-N in the section body",
    "has no Design reference": "→ Add **Design**: design.md#section to the task",
    "heading not found": "→ Fix the anchor to match an actual ## or ### heading in design.md",
    "No test-config": "→ Add test-config section to .kiro/config/project.yaml",
    "not found — expected before": "→ Create the test file before implementation (test-driven mode)",
    "No action def": "→ Add action def or state def to model behavioral logic beyond Markdown prose",
    "No satisfy relationships": "→ Add satisfy relationship linking design elements to requirements",
    "No verify relationships": "→ Add verification def with verify relationship for V&V traceability",
    "no NIST/SSDF/FedRAMP": "→ Add compliance requirement defs with NIST 800-218/800-171 references",
}


def add_hint(detail: str) -> str:
    """Append remediation hint to a failure/warning detail string."""
    for pattern, hint in REMEDIATION.items():
        if pattern in detail:
            return f"{detail} ({hint})"
    return detail


def find_project_root(spec_path: Path) -> Path | None:
    """Walk up from spec path to find project root (contains .kiro/)."""
    current = spec_path.resolve()
    while current != current.parent:
        if (current / ".kiro").is_dir():
            return current
        current = current.parent
    return None


def load_testing_config(project_root: Path) -> dict:
    """Parse project.yaml for testing mode. Minimal YAML parser — no deps."""
    config_path = project_root / ".kiro" / "config" / "project.yaml"
    if not config_path.exists():
        return {"testing": "unknown", "test_config": []}

    text = config_path.read_text()
    testing = "disable"
    test_config = []

    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("testing:"):
            val = stripped.split(":", 1)[1].strip().split("#")[0].strip()
            # Normalize common synonyms to canonical values
            if val in ("off", "disabled"):
                val = "disable"
            testing = val

        if stripped.startswith("framework:"):
            val = stripped.split(":", 1)[1].strip()
            test_config.append({"framework": val})

        if stripped.startswith("directory:"):
            val = stripped.split(":", 1)[1].strip()
            if test_config:
                test_config[-1]["directory"] = val

        if stripped.startswith("naming:"):
            val = stripped.split(":", 1)[1].strip()
            if test_config:
                test_config[-1]["naming"] = val

    return {"testing": testing, "test_config": test_config}


def load_sysml_config(project_root: Path) -> dict:
    """Parse project.yaml for sysml settings. Minimal YAML parser — no deps."""
    config_path = project_root / ".kiro" / "config" / "project.yaml"
    if not config_path.exists():
        return {"enabled": False, "scope": "behavioral"}

    text = config_path.read_text()
    enabled = False
    scope = "behavioral"
    in_sysml = False

    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("sysml:"):
            in_sysml = True
            continue
        if in_sysml and not line.startswith(" ") and not line.startswith("\t") and stripped:
            break
        if in_sysml:
            if stripped.startswith("enabled:"):
                val = stripped.split(":", 1)[1].strip().split("#")[0].strip().lower()
                enabled = val == "true"
            elif stripped.startswith("scope:"):
                scope = stripped.split(":", 1)[1].strip().split("#")[0].strip()

    return {"enabled": enabled, "scope": scope}


def load_waf_config(project_root: Path) -> dict:
    """Parse project.yaml for well-architected settings."""
    config_path = project_root / ".kiro" / "config" / "project.yaml"
    if not config_path.exists():
        return {"enabled": True}
    text = config_path.read_text()
    enabled = True
    in_section = False
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("well-architected:"):
            in_section = True
            continue
        if in_section and not line.startswith(" ") and not line.startswith("\t") and stripped:
            break
        if in_section and stripped.startswith("enabled:"):
            val = stripped.split(":", 1)[1].strip().split("#")[0].strip().lower()
            enabled = val != "false"
    return {"enabled": enabled}


def load_finops_config(project_root: Path) -> dict:
    """Parse project.yaml for finops settings."""
    config_path = project_root / ".kiro" / "config" / "project.yaml"
    if not config_path.exists():
        return {"enabled": True}
    text = config_path.read_text()
    enabled = True
    in_section = False
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("finops:"):
            in_section = True
            continue
        if in_section and not line.startswith(" ") and not line.startswith("\t") and stripped:
            break
        if in_section and stripped.startswith("enabled:"):
            val = stripped.split(":", 1)[1].strip().split("#")[0].strip().lower()
            enabled = val != "false"
    return {"enabled": enabled}


def load_design_system_config(project_root: Path) -> dict:
    """Parse project.yaml for design-system settings."""
    config_path = project_root / ".kiro" / "config" / "project.yaml"
    if not config_path.exists():
        return {"enabled": False, "path": "DESIGN.md", "lint_on_frontend": True, "export_format": "none"}
    text = config_path.read_text()
    enabled = False
    path = "DESIGN.md"
    lint_on_frontend = True
    export_format = "none"
    in_section = False
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("design-system:"):
            in_section = True
            continue
        if in_section and not line.startswith(" ") and not line.startswith("\t") and stripped:
            break
        if in_section:
            if stripped.startswith("enabled:"):
                val = stripped.split(":", 1)[1].strip().split("#")[0].strip().lower()
                enabled = val == "true"
            elif stripped.startswith("path:"):
                val = stripped.split(":", 1)[1].strip().split("#")[0].strip()
                if val:
                    path = val
            elif stripped.startswith("lint-on-frontend:"):
                val = stripped.split(":", 1)[1].strip().split("#")[0].strip().lower()
                lint_on_frontend = val != "false"
            elif stripped.startswith("export-format:"):
                val = stripped.split(":", 1)[1].strip().split("#")[0].strip().lower()
                if val in ("css-tailwind", "json-tailwind", "dtcg", "none"):
                    export_format = val
    return {"enabled": enabled, "path": path, "lint_on_frontend": lint_on_frontend, "export_format": export_format}


def resolve_design_md(project_root: Path, config: dict) -> Path | None:
    """Resolve DESIGN.md using priority chain: config path > local .kiro/config/ > global ~/.kiro/config/."""
    # Priority 1: explicit path in project.yaml
    if config.get("path"):
        candidate = project_root / config["path"]
        if candidate.exists():
            return candidate
    # Priority 2: local .kiro/config/
    local = project_root / ".kiro" / "config" / "DESIGN.md"
    if local.exists():
        return local
    # Priority 3: global ~/.kiro/config/
    global_path = Path.home() / ".kiro" / "config" / "DESIGN.md"
    if global_path.exists():
        return global_path
    return None


def check_sysml(spec_path: Path, sysml_config: dict) -> list[tuple[str, str, str]]:
    """Validate model.sysml when sysml is enabled. Returns list of (status, label, detail)."""
    results = []
    sysml_path = spec_path / "model.sysml"

    if not sysml_path.exists():
        results.append((FAIL, "SysML model", "model.sysml MISSING"))
        return results

    results.append((PASS, "SysML model", "model.sysml exists"))
    text = sysml_path.read_text()

    # Check: file adds value beyond Markdown — must have behavioral model OR constraint
    has_behavior = bool(re.search(r"\b(action\s+def|state\s+def)\b", text))
    has_constraint = bool(re.search(r"\bconstraint\s+def\b", text))
    if has_behavior or has_constraint:
        parts = []
        if has_behavior:
            parts.append("behavioral model")
        if has_constraint:
            parts.append("constraint")
        results.append((PASS, "SysML value-add", f"Contains {' and '.join(parts)} (beyond Markdown)"))
    else:
        results.append((FAIL, "SysML value-add", "No action def, state def, or constraint def — model must add value beyond Markdown"))

    # Check: at least one satisfy relationship
    has_satisfy = bool(re.search(r"\bsatisfy\b", text))
    if has_satisfy:
        results.append((PASS, "SysML traceability", "satisfy relationships present"))
    else:
        results.append((FAIL, "SysML traceability", "No satisfy relationships — model must trace to requirements"))

    # Check: verify relationships (advisory)
    has_verify = bool(re.search(r"\bverify\b", text))
    if has_verify:
        results.append((PASS, "SysML verification", "verify relationships present"))
    else:
        results.append((WARN, "SysML verification", "No verify relationships — consider adding V&V traceability"))

    # Check: compliance mapping when scope requires it
    scope = sysml_config.get("scope", "traceability")
    if scope in ("compliance", "both"):
        has_compliance = bool(re.search(r"(?:NIST|SSDF|FedRAMP|800-218|800-171)", text))
        if has_compliance:
            results.append((PASS, "SysML compliance", "Compliance control references present"))
        else:
            results.append((FAIL, "SysML compliance", "scope includes compliance but no NIST/SSDF/FedRAMP references found"))

    return results


def check_waf_assessment(design_text: str) -> list[tuple[str, str, str]]:
    """WARN when design.md has infrastructure resources but no WAF assessment table."""
    results: list[tuple[str, str, str]] = []
    has_infra = bool(re.search(
        r"(?:Infrastructure\s+Resources|Resource\s+Type|AWS::|CloudFormation|Terraform|CDK)",
        design_text, re.IGNORECASE,
    ))
    if not has_infra:
        return results
    has_waf = bool(re.search(r"\*\*Well-Architected Assessment[:\*]", design_text))
    if has_waf:
        results.append((PASS, "WAF assessment", "Well-Architected Assessment present in design"))
    else:
        results.append((WARN, "WAF assessment", "design.md has infrastructure resources but no **Well-Architected Assessment:** table"))
    return results


def check_cost_profile(design_text: str) -> list[tuple[str, str, str]]:
    """WARN when design.md has infrastructure resources but no Cost Profile table."""
    results: list[tuple[str, str, str]] = []
    has_infra = bool(re.search(
        r"(?:Infrastructure\s+Resources|Resource\s+Type|AWS::|CloudFormation|Terraform|CDK)",
        design_text, re.IGNORECASE,
    ))
    if not has_infra:
        return results
    has_cost = bool(re.search(r"\*\*Cost Profile[:\*]", design_text))
    if has_cost:
        results.append((PASS, "Cost profile", "Cost Profile present in design"))
    else:
        results.append((WARN, "Cost profile", "design.md has infrastructure resources but no **Cost Profile:** table"))
    return results


def check_design_system(design_text: str, project_root: Path) -> list[tuple[str, str, str]]:
    """WARN when design.md references frontend/UI but no DESIGN.md is found via resolution order."""
    results: list[tuple[str, str, str]] = []
    has_frontend = bool(re.search(
        r"(?:frontend|UI\b|component|React|Vue|Svelte|CSS|Tailwind|design.token|DESIGN\.md)",
        design_text, re.IGNORECASE,
    ))
    if not has_frontend:
        return results
    config = load_design_system_config(project_root)
    resolved = resolve_design_md(project_root, config)
    if resolved:
        results.append((PASS, "Design system", f"DESIGN.md found: {resolved}"))
    else:
        results.append((WARN, "Design system", "design.md references frontend/UI but no DESIGN.md found (checked: config path, .kiro/config/DESIGN.md, ~/.kiro/config/DESIGN.md)"))
    return results


def extract_req_ids(text: str) -> list[str]:
    """Extract requirement IDs like REQ-1, REQ-2, or Requirement 1 from text. Normalizes to REQ-N."""
    explicit = set(re.findall(r"REQ-\d+", text))
    long_form = {f"REQ-{m}" for m in re.findall(r"Requirement\s+(\d+)", text)}
    return sorted(explicit | long_form)


def extract_acceptance_criteria_sections(text: str) -> dict[str, bool]:
    """Check each REQ has acceptance criteria. Supports heading-based and table-based formats."""
    results = {}
    req_pattern = re.compile(r"##\s+(?:REQ-(\d+)|Requirement\s+(\d+)):")
    ac_pattern = re.compile(r"(?:\*\*Acceptance Criteria[:\*]|###\s+Acceptance Criteria)", re.IGNORECASE)

    # Try heading-based sections first
    sections = re.split(r"(?=##\s+(?:REQ-\d+|Requirement\s+\d+))", text)
    for section in sections:
        match = req_pattern.search(section)
        if match:
            num = match.group(1) or match.group(2)
            req_id = f"REQ-{num}"
            has_ac = bool(ac_pattern.search(section))
            results[req_id] = has_ac

    # Fallback: table rows like | REQ-N | description | criteria |
    if not results:
        for match in re.finditer(r"^\|[^|]*?(REQ-(\d+))[^|]*\|([^|]*)\|([^|]*)\|", text, re.MULTILINE):
            req_id = f"REQ-{match.group(2)}"
            third_col = match.group(4).strip()
            results[req_id] = len(third_col) > 0

    return results


def extract_correctness_properties(text: str) -> int:
    """Count correctness property sections in design."""
    return len(re.findall(r"\*\*Correctness Properties[:\*]", text, re.IGNORECASE))


def _split_task_sections(text: str) -> list[tuple[str, str]]:
    """Split tasks.md into (task_id, section_text) tuples. Detects formats:
    - ## Task N: / ### Task N: Description
    - ### N. Description (REQ-N)
    - - [x] **Task N**: Description (REQ-N)
    """
    results: list[tuple[str, str]] = []

    # Format 1: ## Task N: or ### Task N:
    fmt1 = re.compile(r"#{2,3}\s+Task\s+(\d+)[:\s]")
    # Format 2: ## N. Description or ### N. Description
    fmt2 = re.compile(r"#{2,3}\s+(\d+)\.\s+")
    # Format 3: - [x] **Task N**: or - [ ] **Task N**:
    fmt3 = re.compile(r"^-\s+\[[ x]\]\s+\*\*Task\s+(\d+)\*\*:", re.MULTILINE)

    # Try heading-based formats first (## Task N: / ### Task N: and ### N.)
    heading_pattern = re.compile(r"(?=#{2,3}\s+(?:Task\s+\d+[:\s]|\d+\.\s+))")
    sections = heading_pattern.split(text)
    for section in sections:
        m = fmt1.search(section[:80]) or fmt2.search(section[:80])
        if m:
            results.append((f"Task {m.group(1)}", section))

    # Fallback: inline list items (- [x] **Task N**:)
    if not results:
        for m in fmt3.finditer(text):
            start = m.start()
            next_m = fmt3.search(text, m.end())
            end = next_m.start() if next_m else len(text)
            results.append((f"Task {m.group(1)}", text[start:end]))

    return results


def extract_task_addresses(text: str) -> dict[str, list[str]]:
    """Extract task numbers and which REQs they address. Supports multiple formats."""
    results = {}
    addr_pattern = re.compile(r"^\s*-?\s*\*\*Addresses\*\*:\s*(.+)", re.MULTILINE)
    reqs_pattern = re.compile(r"^\s*-?\s*\*\*Reqs\*\*:\s*(.+)", re.MULTILINE)

    for task_id, section in _split_task_sections(text):
        # Priority 1: **Addresses**: line
        addr_match = addr_pattern.search(section)
        if addr_match:
            results[task_id] = extract_req_ids(addr_match.group(1))
            continue
        # Priority 2: **Reqs**: line
        reqs_match = reqs_pattern.search(section)
        if reqs_match:
            results[task_id] = extract_req_ids(reqs_match.group(1))
            continue
        # Priority 3: non-bold Reqs: or Addresses: (legacy format)
        nb_pattern = re.compile(r"^\s*-?\s*(?:Reqs|Addresses):\s*(.+)", re.MULTILINE)
        nb_match = nb_pattern.search(section)
        if nb_match:
            reqs = extract_req_ids(nb_match.group(1))
            if reqs:
                results[task_id] = reqs
                continue
        # Priority 4: (REQ-N) in the first line (header or inline)
        first_line = section.split("\n", 1)[0]
        paren_reqs = re.findall(r"REQ-\d+", first_line)
        results[task_id] = sorted(set(paren_reqs)) if paren_reqs else []

    return results


def extract_design_refs(text: str) -> dict[str, bool]:
    """Check tasks have Design: cross-references."""
    results = {}
    design_pattern = re.compile(r"\*\*Design\*\*:")
    for task_id, section in _split_task_sections(text):
        results[task_id] = bool(design_pattern.search(section))
    return results


def extract_implemented_by(text: str) -> int:
    """Count 'Implemented by' references in design. Accepts flexible bold/colon placement."""
    # Match: **Implemented by**: Task N, **Implemented by: Task N**, **Implemented by** Task N
    return len(re.findall(r"\*\*Implemented by\b", text, re.IGNORECASE))


def extract_implemented_by_task_ids(text: str) -> set[int]:
    """Extract all Task N numbers from Implemented by lines in design."""
    ids: set[int] = set()
    for match in re.finditer(r"\*\*Implemented by\*?\*?:?\s*(.+)", text, re.IGNORECASE):
        ids.update(int(n) for n in re.findall(r"Task[s]?\s+(\d+)", match.group(1)))
    return ids


def extract_design_section_reqs(text: str) -> dict[str, list[str]]:
    """Extract REQ-N references from design section headers (## and ### lines).
    Also detects body-level **Addresses**: and **Implements**: REQ references."""
    results: dict[str, list[str]] = {}

    # Split into sections by ## or ### headings
    section_pattern = re.compile(r"^(#{2,3})\s+(.+)$", re.MULTILINE)
    matches = list(section_pattern.finditer(text))

    for i, match in enumerate(matches):
        header = match.group(0).strip()
        # Get section body (text between this heading and the next)
        start = match.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        body = text[start:end]

        reqs: set[str] = set()
        # Check heading for (REQ-N) parenthetical
        reqs.update(extract_req_ids(header))
        # Check body for **Addresses**: or **Implements**: lines
        for body_match in re.finditer(r"\*\*(?:Addresses|Implements)\*\*:\s*(.+)", body):
            reqs.update(extract_req_ids(body_match.group(1)))

        if reqs:
            results[header] = sorted(reqs)

    return results


def extract_design_headings_as_anchors(text: str) -> set[str]:
    """Extract all ## and ### headings from design.md, converted to anchor format.

    Returns both full anchors and prefix-friendly forms so abbreviated task
    references like 'step-1' match 'step-1-framework-overview-...'."""
    anchors: set[str] = set()
    for match in re.finditer(r"^#{2,3}\s+(.+)$", text, re.MULTILINE):
        heading = match.group(1).strip()
        anchor = re.sub(r"[^a-z0-9\s-]", "", heading.lower())
        anchor = re.sub(r"\s+", "-", anchor.strip())
        anchor = re.sub(r"-+", "-", anchor).strip("-")
        anchors.add(anchor)
    return anchors


def extract_task_design_anchors(text: str) -> dict[str, str]:
    """Extract design.md#anchor references from task Design lines."""
    results: dict[str, str] = {}
    anchor_pattern = re.compile(r"\*\*Design\*\*:\s*design\.md#(\S+)")
    for task_id, section in _split_task_sections(text):
        anchor_match = anchor_pattern.search(section)
        if anchor_match:
            results[task_id] = anchor_match.group(1)
    return results


def extract_task_numbers(text: str) -> set[int]:
    """Extract all task numbers from tasks.md. Supports all task header formats."""
    return {int(tid.split()[1]) for tid, _ in _split_task_sections(text)}


def check_test_readiness(
    project_root: Path,
    spec_path: Path,
    req_text: str,
    design_text: str,
    testing_config: dict,
) -> list[tuple[str, str, str]]:
    """Check testing readiness based on project testing mode."""
    results = []
    mode = testing_config["testing"]

    if mode == "disable":
        results.append((PASS, "Testing mode", "disable — no test validation required"))
        return results

    if mode == "unknown":
        results.append((WARN, "Testing mode", "project.yaml not found — cannot validate testing"))
        return results

    results.append((PASS, "Testing mode", f"{mode}"))

    # Both test-after and test-driven need acceptance criteria (checked elsewhere)
    # and correctness properties (checked elsewhere) since tests derive from them.

    # Check test-config exists
    if not testing_config["test_config"]:
        results.append((FAIL, "Test config", "No test-config in project.yaml — framework/directory/naming undefined"))
        return results

    for tc in testing_config["test_config"]:
        framework = tc.get("framework", "unknown")
        directory = tc.get("directory", "tests/")
        naming = tc.get("naming", "")
        results.append((PASS, "Test framework", f"{framework} → {directory} ({naming})"))

    # For test-driven: check if test files exist for this spec
    if mode == "test-driven":
        spec_name = spec_path.name
        for tc in testing_config["test_config"]:
            test_dir = project_root / tc.get("directory", "tests/")
            naming = tc.get("naming", "test_{module}.py")

            # Derive expected test filename from spec folder name
            module_name = spec_name.replace("-", "_")
            expected_name = naming.replace("{module}", module_name).replace("{feature}", module_name)
            expected_path = test_dir / expected_name

            if expected_path.exists():
                results.append((PASS, "Test file", f"{expected_path.relative_to(project_root)} exists"))
            else:
                # Check if any test file references this spec
                test_files = list(test_dir.glob("*")) if test_dir.exists() else []
                matching = [f for f in test_files if module_name in f.name]
                if matching:
                    results.append((PASS, "Test file", f"Found: {matching[0].relative_to(project_root)}"))
                else:
                    results.append((WARN, "Test file", f"test-driven mode but {expected_path.relative_to(project_root)} not found — expected before implementation"))

    elif mode == "test-after":
        results.append((PASS, "Test timing", "test-after — tests generated post-implementation"))

    # Check that acceptance criteria exist (tests derive from them)
    ac_count = len(extract_acceptance_criteria_sections(req_text))
    if ac_count == 0:
        results.append((FAIL, "Test derivation", "No acceptance criteria found — tests cannot be derived (per steering: each criterion → test assertion)"))
    else:
        results.append((PASS, "Test derivation source", f"{ac_count} acceptance criteria sections (→ functional tests)"))

    # Check correctness properties exist (tests derive from them)
    cp_count = extract_correctness_properties(design_text)
    if cp_count == 0:
        results.append((FAIL, "Test derivation", "No correctness properties in design — unit tests cannot be derived (per steering: each property → unit assertion)"))
    else:
        results.append((PASS, "Test derivation source", f"{cp_count} correctness property sections (→ unit tests)"))

    return results


def validate_spec(spec_dir: str, json_mode: bool = False) -> tuple[int, list[tuple[str, str, str]], int]:
    """Run all validation checks. Returns (exit_code, results, failures)."""
    spec_path = Path(spec_dir).resolve()
    results: list[tuple[str, str, str]] = []
    failures = 0

    # --- Check 1: Files exist ---
    req_path = spec_path / "requirements.md"
    design_path = spec_path / "design.md"
    tasks_path = spec_path / "tasks.md"

    required_files: list[tuple[str, Path]] = [
        ("requirements.md", req_path), ("design.md", design_path), ("tasks.md", tasks_path),
    ]

    # Include model.sysml when sysml is enabled in project.yaml
    project_root = find_project_root(spec_path)
    sysml_config = load_sysml_config(project_root) if project_root else {"enabled": False, "scope": "behavioral"}
    if sysml_config["enabled"]:
        required_files.append(("model.sysml", spec_path / "model.sysml"))

    for name, path in required_files:
        if path.exists():
            results.append((PASS, "File exists", name))
        else:
            results.append((FAIL, "File exists", f"{name} MISSING"))
            failures += 1

    if failures > 0:
        if not json_mode:
            print_results(spec_path.name, results, failures)
        return 1, results, failures

    req_text = req_path.read_text()
    design_text = design_path.read_text()
    tasks_text = tasks_path.read_text()

    # --- Check 2: Requirements have acceptance criteria ---
    ac_map = extract_acceptance_criteria_sections(req_text)
    if not ac_map:
        results.append((FAIL, "Requirements", "No REQ-N sections found"))
        failures += 1
    else:
        for req_id, has_ac in sorted(ac_map.items()):
            if has_ac:
                results.append((PASS, "Acceptance criteria", f"{req_id}"))
            else:
                results.append((FAIL, "Acceptance criteria", f"{req_id} — MISSING acceptance criteria"))
                failures += 1

    # --- Check 3: Design has correctness properties ---
    cp_count = extract_correctness_properties(design_text)
    if cp_count > 0:
        results.append((PASS, "Correctness properties", f"{cp_count} sections in design"))
    else:
        results.append((FAIL, "Correctness properties", "No correctness properties found in design"))
        failures += 1

    # --- Check 4: Design has Implemented by references ---
    impl_count = extract_implemented_by(design_text)
    if impl_count > 0:
        results.append((PASS, "Design → Tasks", f"{impl_count} 'Implemented by' references"))
    else:
        results.append((WARN, "Design → Tasks", "No 'Implemented by' references in design"))

    # --- Check 4a: Implemented by Task N numbers match actual tasks ---
    impl_task_ids = extract_implemented_by_task_ids(design_text)
    actual_task_ids = extract_task_numbers(tasks_text)
    phantom_tasks = impl_task_ids - actual_task_ids
    if phantom_tasks:
        for t in sorted(phantom_tasks):
            results.append((FAIL, "Design → Tasks", f"'Implemented by' references Task {t} which does not exist in tasks.md"))
            failures += 1
    elif impl_task_ids:
        results.append((PASS, "Design → Tasks", f"All {len(impl_task_ids)} referenced task numbers exist"))

    # --- Check 5: All REQs covered by tasks ---
    all_reqs = set(extract_req_ids(req_text))
    task_addresses = extract_task_addresses(tasks_text)
    covered_reqs: set[str] = set()
    for reqs in task_addresses.values():
        covered_reqs.update(reqs)

    uncovered = all_reqs - covered_reqs
    if uncovered:
        for req in sorted(uncovered):
            results.append((FAIL, "REQ coverage", f"{req} has no implementing task"))
            failures += 1
    else:
        results.append((PASS, "REQ coverage", f"All {len(all_reqs)} requirements covered by tasks"))

    # --- Check 5a: Design sections reference valid REQ IDs ---
    design_section_reqs = extract_design_section_reqs(design_text)
    all_design_reqs: set[str] = set()
    for reqs in design_section_reqs.values():
        all_design_reqs.update(reqs)
    invalid_design_reqs = all_design_reqs - all_reqs
    if invalid_design_reqs:
        for req in sorted(invalid_design_reqs):
            results.append((FAIL, "Design → REQ", f"Design references {req} which does not exist in requirements.md"))
            failures += 1
    elif all_design_reqs:
        results.append((PASS, "Design → REQ", f"All {len(all_design_reqs)} design REQ references are valid"))

    # --- Check 5b: Every REQ is referenced by at least one design section ---
    reqs_in_design = all_design_reqs
    reqs_missing_from_design = all_reqs - reqs_in_design
    if reqs_missing_from_design:
        for req in sorted(reqs_missing_from_design):
            results.append((WARN, "REQ → Design", f"{req} not referenced in any design section header"))
    else:
        results.append((PASS, "REQ → Design", f"All {len(all_reqs)} requirements referenced in design"))

    # --- Check 6: Tasks have Addresses references ---
    tasks_without_addr = [t for t, reqs in task_addresses.items() if not reqs]
    if tasks_without_addr:
        for task in tasks_without_addr:
            results.append((FAIL, "Task → REQ", f"{task} has no Addresses reference (no REQ traceability found)"))
            failures += 1
    else:
        results.append((PASS, "Task → REQ", f"All {len(task_addresses)} tasks reference requirements"))

    # --- Check 7: Tasks have Design references ---
    design_refs = extract_design_refs(tasks_text)
    tasks_without_design = [t for t, has in design_refs.items() if not has]
    if tasks_without_design:
        for task in tasks_without_design:
            results.append((WARN, "Task → Design", f"{task} has no Design reference"))
    else:
        results.append((PASS, "Task → Design", f"All {len(design_refs)} tasks reference design sections"))

    # --- Check 7a: Task Design anchors resolve to actual design headings ---
    task_anchors = extract_task_design_anchors(tasks_text)
    design_anchors = extract_design_headings_as_anchors(design_text)
    broken_anchors: dict[str, str] = {}
    for task, anchor in task_anchors.items():
        # Normalize task anchor same way as heading anchors (strip special chars)
        norm = re.sub(r"[^a-z0-9\s-]", "", anchor.lower())
        norm = re.sub(r"-+", "-", norm).strip("-")
        if norm not in design_anchors and not any(da.startswith(norm) for da in design_anchors):
            broken_anchors[task] = anchor
    if broken_anchors:
        for task, anchor in sorted(broken_anchors.items()):
            results.append((WARN, "Task → Design", f"{task} references design.md#{anchor} — heading not found"))
    elif task_anchors:
        results.append((PASS, "Task → Design", f"All {len(task_anchors)} design anchors resolve to headings"))

    # --- Check 8: Testing readiness ---
    if project_root:
        testing_config = load_testing_config(project_root)
        test_results = check_test_readiness(project_root, spec_path, req_text, design_text, testing_config)
        for status, label, detail in test_results:
            results.append((status, label, detail))
            if status == FAIL:
                failures += 1
    else:
        results.append((WARN, "Testing", "Could not find project root (.kiro/) — skipping test validation"))

    # --- Check 9: SysML model (when enabled) ---
    # Existence already checked in Check 1; here we validate content only.
    if project_root and sysml_config["enabled"] and (spec_path / "model.sysml").exists():
        sysml_results = check_sysml(spec_path, sysml_config)
        for status, label, detail in sysml_results:
            if status == PASS and label == "SysML model" and "exists" in detail:
                continue  # Skip redundant existence pass — already reported in Check 1
            results.append((status, label, detail))
            if status == FAIL:
                failures += 1

    # --- Check 9a: SysML compliance validation (advisory only) ---
    compliance_findings: list = []
    if (
        _sysml_validator
        and project_root
        and sysml_config["enabled"]
        and (spec_path / "model.sysml").exists()
    ):
        catalog_path = Path.home() / ".kiro" / "steering" / "compliance-pattern-catalog.md"
        if catalog_path.exists():
            all_specs_dir = str(project_root / ".kiro" / "specs")
            try:
                compliance_findings = _sysml_validator.validate_sysml_compliance(
                    str(spec_path), str(catalog_path), all_specs_dir
                )
            except Exception:
                compliance_findings = []
            for finding in compliance_findings:
                icon = WARN if finding.severity == "WARN" else INFO
                results.append((icon, "SysML compliance", add_hint(finding.message)))

    # --- Check 10: WAF assessment (advisory, when enabled) ---
    waf_config = load_waf_config(project_root) if project_root else {"enabled": True}
    if waf_config["enabled"]:
        for status, label, detail in check_waf_assessment(design_text):
            results.append((status, label, detail))

    # --- Check 11: Cost profile (advisory, when enabled) ---
    finops_config = load_finops_config(project_root) if project_root else {"enabled": True}
    if finops_config["enabled"]:
        for status, label, detail in check_cost_profile(design_text):
            results.append((status, label, detail))

    # --- Check 12: Design system (advisory, when enabled) ---
    design_system_config = load_design_system_config(project_root) if project_root else {"enabled": False}
    if design_system_config["enabled"]:
        for status, label, detail in check_design_system(design_text, project_root):
            results.append((status, label, detail))

    if not json_mode:
        print_results(spec_path.name, results, failures)
    exit_code = 0 if failures == 0 else 1
    return exit_code, results, failures


def extract_task_completion(tasks_text: str) -> dict[str, tuple[int, int]]:
    """Parse [x]/[ ] checkboxes per task section. Returns task → (done, total)."""
    results: dict[str, tuple[int, int]] = {}
    check_pattern = re.compile(r"^- \[([ x])\]", re.MULTILINE)
    for task_id, section in _split_task_sections(tasks_text):
        checks = check_pattern.findall(section)
        done = sum(1 for c in checks if c == "x")
        results[task_id] = (done, len(checks))
    return results


def extract_task_file_refs(tasks_text: str) -> dict[str, list[str]]:
    """Extract backtick-quoted file paths from completed task subtask lines."""
    results: dict[str, list[str]] = {}
    file_pattern = re.compile(r"`([^`\s]+/[^`\s]+)`")
    skip_prefixes = ("python3 ", "pip ", "npm ", "git ", "docker ", "aws ", "terraform ")
    for task_id, section in _split_task_sections(tasks_text):
        files: list[str] = []
        for line in section.splitlines():
            if not line.strip().startswith("- [x]"):
                continue
            for fp in file_pattern.findall(line):
                if fp.startswith("~") or any(fp.startswith(p) for p in skip_prefixes):
                    continue
                files.append(fp)
        if files:
            results[task_id] = files
    return results


def extract_completed_tasks_from_summary(tasks_text: str) -> set[str]:
    """Extract task IDs marked [x] in the summary table."""
    completed: set[str] = set()
    for match in re.finditer(r"\|\s*(\d+)\s*\|[^|]+\|[^|]+\|\s*\[x\]\s*\|", tasks_text):
        completed.add(f"Task {match.group(1)}")
    return completed


def extract_effort_fields(tasks_text: str) -> dict[str, dict[str, str]]:
    """Extract effort metric table values per task. Supports both per-task vertical
    metric tables and horizontal summary tables at the top of tasks.md."""
    results: dict[str, dict[str, str]] = {}

    # Try summary table first: header row with metric columns, data rows with task numbers
    header_match = re.search(r"^\|([^|]*Task[^|]*(?:\|[^|]*)*)\|", tasks_text, re.MULTILINE | re.IGNORECASE)
    if header_match:
        header_line = header_match.group(0)
        cols = [c.strip() for c in header_line.strip("|").split("|")]
        col_lower = [c.lower() for c in cols]
        actual_idx = next((i for i, c in enumerate(col_lower) if "ai-assisted actual" in c), None)
        complete_idx = next((i for i, c in enumerate(col_lower) if c in ("complete", "complete ")), None)

        if actual_idx is not None or complete_idx is not None:
            # Parse data rows after header (skip separator row)
            lines = tasks_text[header_match.end():].splitlines()
            for line in lines:
                line = line.strip()
                if not line.startswith("|"):
                    continue
                if re.match(r"^\|[\s\-:|]+\|$", line):
                    continue  # separator row
                cells = [c.strip() for c in line.strip("|").split("|")]
                # First cell should be a task number
                task_num = re.match(r"(\d+)", cells[0].strip()) if cells else None
                if not task_num:
                    continue
                if cells[0].strip().lower() in ("total", "totals"):
                    continue
                task_id = f"Task {task_num.group(1)}"
                fields: dict[str, str] = {}
                if actual_idx is not None and actual_idx < len(cells):
                    fields["AI-Assisted Actual"] = cells[actual_idx].strip()
                if complete_idx is not None and complete_idx < len(cells):
                    fields["Complete"] = cells[complete_idx].strip()
                if fields:
                    results[task_id] = fields

    if results:
        return results

    # Fallback: per-task vertical metric tables
    field_pattern = re.compile(r"\|\s*(AI-Assisted Actual|Complete)\s*\|\s*(.*?)\s*\|")
    for task_id, section in _split_task_sections(tasks_text):
        fields: dict[str, str] = {}
        for fm in field_pattern.finditer(section):
            fields[fm.group(1)] = fm.group(2).strip()
        if fields:
            results[task_id] = fields
    return results


def collect_git_compliance_tags(project_root: Path) -> set[str]:
    """Extract SSDF practice IDs from recent git Compliance: lines."""
    import subprocess
    result = subprocess.run(
        ["git", "log", "--since=365 days ago", "--format=%B---COMMIT-SEP---"],
        capture_output=True, text=True, cwd=project_root,
    )
    if result.returncode != 0:
        return set()
    tags: set[str] = set()
    for block in result.stdout.split("---COMMIT-SEP---"):
        m = re.search(r"Compliance:\s*(.+)", block)
        if m:
            tags.update(p.strip() for p in m.group(1).split(","))
    return tags


def verify_implementation(spec_dir: str) -> int:
    """Run implementation verification checks. Returns 0 if pass, 1 if failures."""
    spec_path = Path(spec_dir).resolve()
    project_root = find_project_root(spec_path)
    results: list[tuple[str, str, str]] = []
    failures = 0

    tasks_text = (spec_path / "tasks.md").read_text()
    design_text = (spec_path / "design.md").read_text()

    # --- Check 9: Task completion status ---
    completion = extract_task_completion(tasks_text)
    total_done = sum(d for d, _ in completion.values())
    total_items = sum(t for _, t in completion.values())
    pct = (total_done / total_items * 100) if total_items else 0
    results.append((PASS if pct == 100 else WARN, "Task completion", f"{total_done}/{total_items} subtasks done ({pct:.0f}%)"))
    for task, (done, total) in sorted(completion.items()):
        if total > 0 and done < total:
            results.append((WARN, "Task completion", f"{task}: {done}/{total} subtasks done"))

    # --- Check 10: Referenced file existence ---
    if project_root:
        completed_summary = extract_completed_tasks_from_summary(tasks_text)
        file_refs = extract_task_file_refs(tasks_text)
        checked = 0
        for task, files in sorted(file_refs.items()):
            if task not in completed_summary:
                continue
            for f in files:
                checked += 1
                path = project_root / f
                if path.exists():
                    results.append((PASS, "File exists", f"{task}: `{f}`"))
                else:
                    results.append((WARN, "File missing", f"{task}: `{f}` not found"))
        if checked == 0:
            results.append((PASS, "File refs", "No file references in completed tasks"))

    # --- Check 11: Effort tracking completeness ---
    completed_summary = extract_completed_tasks_from_summary(tasks_text)
    effort = extract_effort_fields(tasks_text)
    for task in sorted(completed_summary):
        fields = effort.get(task, {})
        if not fields:
            continue  # No metric table — skip (pre-dates value tracking)
        actual = fields.get("AI-Assisted Actual", "")
        complete = fields.get("Complete", "")
        if not actual:
            results.append((WARN, "Effort tracking", f"{task}: AI-Assisted Actual not populated"))
        if not complete:
            results.append((WARN, "Effort tracking", f"{task}: Complete timestamp not populated"))
        if actual and complete:
            results.append((PASS, "Effort tracking", f"{task}: actuals recorded"))

    # --- Check 12: Compliance tag coverage ---
    if project_root:
        spec_practices = set(re.findall(r"[A-Z]{2}\.\d+\.\d+", design_text + tasks_text))
        if spec_practices:
            git_tags = collect_git_compliance_tags(project_root)
            covered = spec_practices & git_tags
            uncovered = spec_practices - git_tags
            if uncovered:
                results.append((WARN, "Compliance tags", f"{len(uncovered)} practices without commit evidence: {', '.join(sorted(uncovered))}"))
            if covered:
                results.append((PASS, "Compliance tags", f"{len(covered)}/{len(spec_practices)} practices have commit evidence"))

    # --- Check 13: SysML compliance validation (advisory only) ---
    sysml_config = load_sysml_config(project_root) if project_root else {"enabled": False, "scope": "behavioral"}
    if (
        _sysml_validator
        and project_root
        and sysml_config["enabled"]
        and (spec_path / "model.sysml").exists()
    ):
        catalog_path = Path.home() / ".kiro" / "steering" / "compliance-pattern-catalog.md"
        if catalog_path.exists():
            all_specs_dir = str(project_root / ".kiro" / "specs")
            try:
                findings = _sysml_validator.validate_sysml_compliance(
                    str(spec_path), str(catalog_path), all_specs_dir
                )
            except Exception:
                findings = []
            for finding in findings:
                icon = WARN if finding.severity == "WARN" else INFO
                results.append((icon, "SysML compliance", add_hint(finding.message)))

    print_verify_results(spec_path.name, results, failures)
    return 0 if failures == 0 else 1


def print_verify_results(spec_name: str, results: list[tuple[str, str, str]], failures: int) -> None:
    """Print implementation verification results."""
    print(f"\n{'=' * 60}")
    print(f"Implementation Verification: {spec_name}")
    print(f"{'=' * 60}\n")

    for status, category, detail in results:
        print(f"  {status} {category}: {detail}")

    print(f"\n{'─' * 60}")
    if failures == 0:
        print(f"  {PASS} IMPLEMENTATION VERIFIED — all checks passed")
    else:
        print(f"  {FAIL} IMPLEMENTATION GAPS — {failures} issue(s)")
    print(f"{'─' * 60}\n")


def print_results(spec_name: str, results: list[tuple[str, str, str]], failures: int) -> None:
    """Print validation results."""
    print(f"\n{'=' * 60}")
    print(f"Spec Validation: {spec_name}")
    print(f"{'=' * 60}\n")

    current_category = ""
    for status, category, detail in results:
        if category != current_category:
            current_category = category
        out = add_hint(detail) if status in (FAIL, WARN) and category != "SysML compliance" else detail
        print(f"  {status} {category}: {out}")

    print(f"\n{'─' * 60}")
    if failures == 0:
        print(f"  {PASS} READY FOR IMPLEMENTATION — all quality gates passed")
    else:
        print(f"  {FAIL} NOT READY — {failures} failure(s) must be resolved")
    print(f"{'─' * 60}\n")


def to_json(spec_stats: list[dict]) -> str:
    """Serialize spec stats to JSON."""
    import json
    output = {
        "specs": spec_stats,
        "summary": {
            "total": len(spec_stats),
            "passed": sum(1 for s in spec_stats if s["failures"] == 0),
            "failed": sum(1 for s in spec_stats if s["failures"] > 0),
        },
    }
    return json.dumps(output, indent=2)


def print_portfolio_summary(spec_stats: list[dict]) -> None:
    """Print portfolio-level summary table sorted by status."""
    if not spec_stats:
        return
    # Sort: failures first, then warnings-only, then passing
    def sort_key(s: dict) -> tuple:
        if s["failures"] > 0:
            return (0, s["name"])
        if s["warnings"] > 0:
            return (1, s["name"])
        return (2, s["name"])
    spec_stats.sort(key=sort_key)

    print(f"\n{'=' * 75}")
    print("Portfolio Summary")
    print(f"{'=' * 75}\n")
    print(f"  {'Spec':<40} {'Status':<10} {'Tasks':<10} Issues")
    print(f"  {'─'*40} {'─'*10} {'─'*10} {'─'*15}")
    for s in spec_stats:
        status = f"{FAIL} FAIL" if s["failures"] > 0 else f"{PASS} PASS"
        tasks = f"{s['tasks_done']}/{s['tasks_total']}" if s["tasks_total"] > 0 else "—"
        issues = f"{s['failures']} fail, {s['warnings']} warn"
        print(f"  {s['name']:<40} {status:<10} {tasks:<10} {issues}")

    passed = sum(1 for s in spec_stats if s["failures"] == 0)
    print(f"\n  Summary: {passed}/{len(spec_stats)} specs passed")
    print(f"{'=' * 75}\n")


def find_specs(project_root: Path) -> list[Path]:
    """Find all spec directories under .kiro/specs/."""
    specs_dir = project_root / ".kiro" / "specs"
    if not specs_dir.is_dir():
        return []
    results = []
    for d in sorted(specs_dir.iterdir()):
        if d.is_dir() and (d / "requirements.md").exists():
            results.append(d)
        # Check one-time subdirectories
        if d.is_dir() and d.name == "one-time":
            for sub in sorted(d.iterdir()):
                if sub.is_dir() and (sub / "requirements.md").exists():
                    results.append(sub)
    return results


def interactive_select(project_root: Path) -> Path | None:
    """Present numbered list of specs for user selection."""
    specs = find_specs(project_root)
    if not specs:
        print("No specs found in .kiro/specs/")
        return None

    specs_base = project_root / ".kiro" / "specs"
    print(f"\nSpecs in {specs_base.relative_to(project_root)}:\n")
    for i, spec in enumerate(specs, 1):
        rel = spec.relative_to(specs_base)
        # Read status from requirements.md first line area
        req_text = (spec / "requirements.md").read_text()
        status_match = re.search(r"\*\*Status\*\*:\s*(\S+)", req_text)
        status = status_match.group(1) if status_match else "—"
        has_tasks = (spec / "tasks.md").exists()
        has_design = (spec / "design.md").exists()
        files = "r/d/t" if (has_design and has_tasks) else f"r{'d' if has_design else '-'}{'t' if has_tasks else '-'}"
        print(f"  {i:2}. {rel}  [{status}] ({files})")

    print()
    try:
        choice = input("Select spec number (or q to quit): ").strip()
    except (EOFError, KeyboardInterrupt):
        # No interactive input available (AI control) — list specs and exit
        print("No interactive input available. Usage:")
        print("  python3 ~/.kiro/scripts/validate-spec.py .kiro/specs/<spec-name>")
        print("  python3 ~/.kiro/scripts/validate-spec.py --all")
        return None

    if choice.lower() == "q":
        return None
    try:
        idx = int(choice) - 1
        if 0 <= idx < len(specs):
            return specs[idx]
    except ValueError:
        pass

    print(f"Invalid selection: {choice}")
    return None


def list_specs_summary(project_root: Path) -> int:
    """List all specs with one-line status. For AI to pick which to validate."""
    specs = find_specs(project_root)
    if not specs:
        print("No specs found in .kiro/specs/")
        return 2
    specs_base = project_root / ".kiro" / "specs"
    print(f"\nSpecs in {specs_base.relative_to(project_root)}:\n")
    print(f"  {'#':>3}  {'Spec':<45} {'Status':<20} Files")
    print(f"  {'─'*3}  {'─'*45} {'─'*20} {'─'*5}")
    for i, spec in enumerate(specs, 1):
        rel = spec.relative_to(specs_base)
        req_text = (spec / "requirements.md").read_text()
        status_match = re.search(r"\*\*Status\*\*:\s*(\S+)", req_text)
        status = status_match.group(1) if status_match else "—"
        has_tasks = (spec / "tasks.md").exists()
        has_design = (spec / "design.md").exists()
        files = "r/d/t" if (has_design and has_tasks) else f"r{'d' if has_design else '-'}{'t' if has_tasks else '-'}"
        print(f"  {i:3}. {str(rel):<45} [{status}]{'':>{18-len(status)}} ({files})")
    print("\nTo validate a specific spec:")
    print("  python3 ~/.kiro/scripts/validate-spec.py .kiro/specs/<spec-name>")
    print("To validate all specs:")
    print("  python3 ~/.kiro/scripts/validate-spec.py --all\n")
    return 0


def main() -> None:
    project_root = find_project_root(Path.cwd() / ".kiro" / "specs")
    if not project_root:
        project_root = Path.cwd()

    # Parse flags
    verify = "--verify" in sys.argv
    json_mode = "--json" in sys.argv
    all_mode = "--all" in sys.argv
    args = [a for a in sys.argv[1:] if a not in ("--verify", "--json", "--all")]

    def build_stat(name: str, path: str, results: list, failures: int, completion: dict | None = None) -> dict:
        done = sum(d for d, _ in (completion or {}).values())
        total = sum(t for _, t in (completion or {}).values())
        return {
            "name": name, "path": path, "status": "FAIL" if failures > 0 else "PASS",
            "failures": failures,
            "warnings": sum(1 for s, _, _ in results if s == WARN),
            "tasks_done": done, "tasks_total": total,
            "results": [{"status": s, "category": c, "detail": d} for s, c, d in results],
        }

    # Batch mode
    if all_mode:
        specs = find_specs(project_root)
        if not specs:
            print("No specs found in .kiro/specs/", file=sys.stderr)
            sys.exit(2)
        all_stats: list[dict] = []
        any_failure = False
        for spec in specs:
            exit_code, results, failures = validate_spec(str(spec), json_mode=json_mode)
            completion = None
            if exit_code == 0 and verify:
                tasks_text = (spec / "tasks.md").read_text()
                completion = extract_task_completion(tasks_text)
                vr = verify_implementation(str(spec))
                if vr != 0:
                    exit_code = 1
            elif exit_code == 0:
                tasks_text = (spec / "tasks.md").read_text()
                completion = extract_task_completion(tasks_text)
            if exit_code != 0:
                any_failure = True
            specs_base = project_root / ".kiro" / "specs"
            rel = str(spec.relative_to(specs_base)) if spec.is_relative_to(specs_base) else spec.name
            all_stats.append(build_stat(rel, str(spec), results, failures, completion))
        if json_mode:
            print(to_json(all_stats))
        else:
            print_portfolio_summary(all_stats)
        sys.exit(1 if any_failure else 0)

    # Single spec path
    if args:
        spec_dir = args[0]
        if not Path(spec_dir).is_dir():
            print(f"Error: {spec_dir} is not a directory", file=sys.stderr)
            sys.exit(2)
        exit_code, results, failures = validate_spec(spec_dir, json_mode=json_mode)
        if exit_code == 0 and verify:
            verify_implementation(spec_dir)
        if json_mode:
            completion = extract_task_completion(Path(spec_dir).resolve().joinpath("tasks.md").read_text()) if Path(spec_dir).resolve().joinpath("tasks.md").exists() else {}
            print(to_json([build_stat(Path(spec_dir).name, spec_dir, results, failures, completion)]))
        sys.exit(exit_code)

    # No args, no TTY → list specs
    if not sys.stdin.isatty():
        sys.exit(list_specs_summary(project_root))

    # TTY → interactive menu
    spec = interactive_select(project_root)
    if spec is None:
        sys.exit(2)
    exit_code, results, failures = validate_spec(str(spec), json_mode=json_mode)
    if exit_code == 0 and verify:
        verify_implementation(str(spec))
    sys.exit(exit_code)


if __name__ == "__main__":
    main()
