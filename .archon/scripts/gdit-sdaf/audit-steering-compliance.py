#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""Post-task steering compliance audit.

Checks whether steering rules were followed after task completion.

Usage:
    python3 ~/.kiro/scripts/audit-steering-compliance.py .kiro/specs/<feature>/
"""

import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

try:
    _scripts_dir = str(Path.home() / ".kiro" / "scripts")
    if _scripts_dir not in sys.path:
        sys.path.insert(0, _scripts_dir)
    from sysml_graph import parse_compliance_graph as _parse_cg  # type: ignore[import-not-found]
    _HAS_SYSML_PARSER = True
except ImportError:
    _HAS_SYSML_PARSER = False

    def _parse_cg(_path: str):  # type: ignore[misc]  # noqa: ARG001
        """Stub when sysml_graph is not installed."""
        return None

SCAN_RECENCY_SECONDS = 1800  # 30 minutes
VALIDATE_SPEC = Path.home() / ".kiro/scripts/validate-spec.py"

DEFAULT_SCANNER_FILE_MAP: dict[str, list[str]] = {
    "ruff": [".py"],
    "pyright": [".py"],
    "py_compile": [".py"],
    "semgrep": [".py", ".js", ".ts", ".jsx", ".tsx", ".java", ".go", ".rb", ".rs", ".cs"],
    "gitleaks": ["*"],
    "trivy": [".py", ".yaml", ".yml", ".json", ".tf", "Dockerfile"],
    "checkov": [".yaml", ".yml", ".json", ".tf", ".bicep"],
    "cfn-lint": [".yaml", ".yml", ".json"],
    "cfn-guard": [".yaml", ".yml", ".json"],
    "tfsec": [".tf"],
    "kics": [".yaml", ".yml", ".json", ".tf", ".bicep", "Dockerfile"],
    "ansible-lint": [".yaml", ".yml"],
    "spotbugs": [".java"],
    "pmd": [".java"],
    "spotless": [".java"],
    "dependency-check": ["pom.xml", ".gradle"],
    "dotnet-format": [".cs", ".fs"],
    "dotnet-build": [".cs", ".csproj"],
}


def check_git_checkpoint(project_dir: Path) -> tuple[str, str]:
    """Check most recent commit has structured format with Compliance + Evidence."""
    result = subprocess.run(
        ["git", "log", "-1", "--format=%H%n%s%n%b"],
        cwd=project_dir, capture_output=True, text=True,
    )
    if result.returncode != 0:
        return "SKIP", "not a git repository"

    lines = result.stdout.strip()
    if not lines:
        return "FAIL", "no commits found"

    parts = lines.split("\n", 2)
    sha = parts[0][:7] if parts else "unknown"
    body = parts[2] if len(parts) > 2 else ""

    has_compliance = "Compliance:" in body
    has_evidence = "Evidence:" in body

    if has_compliance and has_evidence:
        # Validate sub-practice level tags (XX.N.N not XX.N)
        import re
        comp_line = [l for l in body.split("\n") if l.startswith("Compliance:")]
        if comp_line:
            tags = comp_line[0].replace("Compliance:", "").strip()
            general_tags = re.findall(r'\b([A-Z]{2}\.\d+)\b(?!\.\d)', tags)
            if general_tags:
                return "FAIL", f"commit {sha} uses practice-level tags ({', '.join(general_tags)}) — use sub-practice (e.g., PW.1.1 not PW.1)"
        return "PASS", f"commit {sha} has Compliance + Evidence fields"
    missing = []
    if not has_compliance:
        missing.append("Compliance:")
    if not has_evidence:
        missing.append("Evidence:")
    return "FAIL", f"commit {sha} missing {', '.join(missing)}"


def check_spec_validation(spec_dir: Path) -> tuple[str, str]:
    """Run validate-spec.py on the spec directory."""
    if not spec_dir.exists():
        return "SKIP", "spec directory not found"
    if not VALIDATE_SPEC.exists():
        return "SKIP", "validate-spec.py not found"

    result = subprocess.run(
        [sys.executable, str(VALIDATE_SPEC), str(spec_dir)],
        capture_output=True, text=True,
    )
    if result.returncode == 0:
        return "PASS", "validate-spec.py passed all gates"
    return "FAIL", "validate-spec.py reported failures"


def _get_committed_files(project_dir: Path) -> set[str]:
    """Return set of file paths modified in the most recent commit."""
    result = subprocess.run(
        ["git", "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"],
        cwd=project_dir, capture_output=True, text=True,
    )
    if result.returncode != 0:
        return set()
    files = {f.strip() for f in result.stdout.strip().splitlines() if f.strip()}
    if not files:
        # Initial commit: diff-tree with no parent returns empty; use ls-tree instead
        result = subprocess.run(
            ["git", "diff-tree", "--root", "--no-commit-id", "--name-only", "-r", "HEAD"],
            cwd=project_dir, capture_output=True, text=True,
        )
        files = {f.strip() for f in result.stdout.strip().splitlines() if f.strip()}
    return files


def write_scan_manifest(
    project_dir: Path, files: list[str], tool: str, exit_code: int, *, reset: bool = False,
) -> Path:
    """Write or update .security-scans/.scan-manifest.json.

    Args:
        project_dir: Project root directory.
        files: List of repo-relative file paths targeted by the scan.
        tool: Scanner name (e.g., "ruff", "gitleaks").
        exit_code: Tool exit code.
        reset: If True, overwrite the manifest (first tool in cycle).
    """
    scans_dir = project_dir / ".security-scans"
    scans_dir.mkdir(exist_ok=True)
    manifest_path = scans_dir / ".scan-manifest.json"

    if reset or not manifest_path.exists():
        manifest: dict = {"timestamp": "", "files_targeted": [], "tools": {}}
    else:
        try:
            manifest = json.loads(manifest_path.read_text())
        except (json.JSONDecodeError, OSError):
            manifest = {"timestamp": "", "files_targeted": [], "tools": {}}

    from datetime import datetime, timezone
    manifest["timestamp"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")
    existing = set(manifest.get("files_targeted", []))
    existing.update(files)
    manifest["files_targeted"] = sorted(existing)
    manifest["tools"][tool] = {"files": sorted(files), "exit_code": exit_code}

    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    return manifest_path


def _file_matches_pattern(filename: str, pattern: str) -> bool:
    """Check if a filename matches a scanner file pattern."""
    if pattern == "*":
        return True
    if pattern.startswith("."):
        return filename.endswith(pattern) or Path(filename).suffix == pattern
    # Exact filename match (e.g., Dockerfile, pom.xml)
    return Path(filename).name == pattern


def check_security_scans(
    project_dir: Path,
    recency: int = SCAN_RECENCY_SECONDS,
    scanner_map: dict[str, list[str]] | None = None,
    enabled_scanners: list[str] | None = None,
) -> tuple[str, str]:
    """Check scan manifest covers files modified in the most recent commit."""
    scans_dir = project_dir / ".security-scans"
    if not scans_dir.exists():
        return "SKIP", ".security-scans/ directory not found"

    manifest_path = scans_dir / ".scan-manifest.json"
    if not manifest_path.exists():
        return "FAIL", ".scan-manifest.json not found"

    # Check staleness: manifest mtime OR any scan report file updated within recency window
    manifest_age = time.time() - manifest_path.stat().st_mtime
    if manifest_age >= recency:
        # Fallback: check if any scan report file was updated recently
        report_files = [f for f in scans_dir.iterdir() if f.name.endswith("-report.json")]
        newest_report = min((time.time() - f.stat().st_mtime for f in report_files), default=float("inf"))
        if newest_report >= recency:
            return "FAIL", ".scan-manifest.json is stale"

    try:
        manifest = json.loads(manifest_path.read_text())
    except (json.JSONDecodeError, OSError):
        return "FAIL", ".scan-manifest.json unreadable"

    modified = _get_committed_files(project_dir)
    if not modified:
        return "SKIP", "no files in most recent commit"

    targeted = set(manifest.get("files_targeted", []))
    tools_ran = manifest.get("tools", {})
    effective_map = scanner_map or DEFAULT_SCANNER_FILE_MAP

    # Filter map by enabled-scanners if provided
    if enabled_scanners:
        effective_map = {k: v for k, v in effective_map.items() if k in enabled_scanners}

    # Determine scannable files: any file matching at least one scanner pattern
    all_patterns = {p for patterns in effective_map.values() for p in patterns}
    scannable = {f for f in modified if any(_file_matches_pattern(f, p) for p in all_patterns)}

    if not scannable:
        return "PASS", f"no scannable files in commit ({len(modified)} file(s) modified)"

    uncovered = scannable - targeted
    if uncovered:
        return "FAIL", (
            f"{len(uncovered)}/{len(scannable)} modified file(s) not in manifest: "
            f"{', '.join(sorted(uncovered)[:3])}"
        )

    # Check at least one relevant scanner ran per file type
    for f in scannable:
        relevant = [s for s, pats in effective_map.items()
                     if any(_file_matches_pattern(f, p) for p in pats)]
        if relevant and not any(s in tools_ran for s in relevant):
            return "FAIL", f"no relevant scanner ran for {f} (expected one of: {', '.join(relevant[:3])})"

    return "PASS", (
        f"{len(scannable)}/{len(scannable)} modified file(s) covered, "
        f"{len(tools_ran)} tool(s) in manifest"
    )


def _read_project_yaml(project_dir: Path) -> dict:
    """Read project.yaml and return parsed workflow config."""
    yaml_path = project_dir / ".kiro" / "config" / "project.yaml"
    if not yaml_path.exists():
        return {}
    text = yaml_path.read_text()
    config: dict = {}
    audit: dict = {}
    security: dict = {}
    sysml: dict = {}
    scanner_file_map: dict[str, list[str]] = {}
    in_audit = False
    in_validation_tools = False
    in_test_patterns = False
    in_security = False
    in_scanner_map = False
    in_sysml = False
    current_vt_key = ""
    current_sfm_key = ""
    validation_tools: dict[str, list[str]] = {}
    test_patterns: list[str] = []

    for line in text.split("\n"):
        stripped = line.strip()

        if stripped.startswith("testing:"):
            config["testing"] = stripped.split(":", 1)[1].strip().split("#")[0].strip()
            in_audit = False
            in_validation_tools = False
            in_test_patterns = False
            in_security = False
            in_scanner_map = False
            in_sysml = False
        elif stripped.startswith("frameworks:"):
            val = stripped.split(":", 1)[1].strip().split("#")[0].strip()
            if val.startswith("[") and val.endswith("]"):
                config["frameworks"] = [v.strip() for v in val[1:-1].split(",") if v.strip()]
        elif stripped.startswith("framework:"):
            config["framework"] = stripped.split(":", 1)[1].strip().split("#")[0].strip()
        elif stripped.startswith("audit:"):
            in_audit = True
            in_validation_tools = False
            in_test_patterns = False
            in_security = False
            in_scanner_map = False
            in_sysml = False
        elif not line.startswith(" ") and not line.startswith("\t") and stripped.startswith("security:"):
            in_security = True
            in_audit = False
            in_validation_tools = False
            in_test_patterns = False
            in_scanner_map = False
            in_sysml = False
        elif not line.startswith(" ") and not line.startswith("\t") and stripped.startswith("sysml:"):
            in_sysml = True
            in_audit = False
            in_validation_tools = False
            in_test_patterns = False
            in_security = False
            in_scanner_map = False
        elif in_sysml and ":" in stripped and not stripped.startswith("-"):
            key, val = stripped.split(":", 1)
            val = val.strip().split("#")[0].strip().lower()
            if val in ("true", "false"):
                sysml[key.strip()] = val == "true"
            elif val:
                sysml[key.strip()] = val
        elif in_security and stripped.startswith("scanner-file-mapping:"):
            in_scanner_map = True
        elif in_security and stripped.startswith("enabled-scanners:"):
            val = stripped.split(":", 1)[1].strip().split("#")[0].strip()
            if val.startswith("[") and val.endswith("]"):
                security["enabled-scanners"] = [
                    v.strip() for v in val[1:-1].split(",") if v.strip()
                ]
        elif in_scanner_map and stripped.startswith("- ") and current_sfm_key:
            scanner_file_map.setdefault(current_sfm_key, []).append(
                stripped[2:].strip()
            )
        elif in_scanner_map and ":" in stripped and not stripped.startswith("-"):
            key = stripped.split(":", 1)[0].strip()
            val = stripped.split(":", 1)[1].strip().split("#")[0].strip()
            if val.startswith("[") and val.endswith("]"):
                scanner_file_map[key] = [
                    v.strip().strip('"').strip("'") for v in val[1:-1].split(",") if v.strip()
                ]
                current_sfm_key = ""
            else:
                current_sfm_key = key
        elif in_security and not in_scanner_map and ":" in stripped and not stripped.startswith("-"):
            pass  # other security keys (semgrep, trivy, log-retention) — not needed by audit
        elif in_sysml and (line.startswith(" ") or line.startswith("\t")) and ":" in stripped and not stripped.startswith("-"):
            key, val = stripped.split(":", 1)
            val = val.strip().split("#")[0].strip().lower()
            if val in ("true", "false"):
                sysml[key.strip()] = val == "true"
            elif val:
                sysml[key.strip()] = val
        elif in_audit and stripped.startswith("validation-tools:"):
            in_validation_tools = True
            in_test_patterns = False
        elif in_audit and stripped.startswith("test-evidence-patterns:"):
            in_test_patterns = True
            in_validation_tools = False
        elif in_validation_tools and stripped.startswith("- ") and current_vt_key:
            validation_tools.setdefault(current_vt_key, []).append(
                stripped[2:].strip()
            )
        elif in_validation_tools and ":" in stripped and not stripped.startswith("-"):
            key = stripped.split(":", 1)[0].strip()
            val = stripped.split(":", 1)[1].strip().split("#")[0].strip()
            if val.startswith("[") and val.endswith("]"):
                validation_tools[key] = [
                    v.strip() for v in val[1:-1].split(",") if v.strip()
                ]
                current_vt_key = ""
            else:
                current_vt_key = key
        elif in_test_patterns and stripped.startswith("- "):
            test_patterns.append(stripped[2:].strip())
        elif in_audit and ":" in stripped and not stripped.startswith("-"):
            key, val = stripped.split(":", 1)
            val = val.strip().split("#")[0].strip().lower()
            if val in ("true", "false"):
                audit[key.strip()] = val == "true"
            elif val.isdigit():
                audit[key.strip()] = int(val)
            in_validation_tools = False
            in_test_patterns = False
        elif not line.startswith(" ") and not line.startswith("\t") and stripped:
            in_audit = False
            in_validation_tools = False
            in_test_patterns = False
            in_security = False
            in_scanner_map = False
            in_sysml = False

    if validation_tools:
        audit["validation-tools"] = validation_tools
    if test_patterns:
        audit["test-evidence-patterns"] = test_patterns
    if audit:
        config["audit"] = audit
    if scanner_file_map:
        security["scanner-file-mapping"] = scanner_file_map
    if security:
        config["security"] = security
    if sysml:
        config["sysml"] = sysml
    return config


def check_test_execution(project_dir: Path) -> tuple[str, str]:
    """Check test framework name appears in most recent commit evidence."""
    config = _read_project_yaml(project_dir)
    testing = config.get("testing", "off")
    if testing == "off":
        return "SKIP", "testing mode is off"

    # Support both 'framework' (string) and 'frameworks' (list)
    frameworks: list[str] = config.get("frameworks", [])
    if not frameworks:
        single = config.get("framework", "")
        frameworks = [single] if single else []
    if not frameworks:
        return "SKIP", "no test framework configured"

    result = subprocess.run(
        ["git", "log", "-1", "--format=%b"],
        cwd=project_dir, capture_output=True, text=True,
    )
    if result.returncode != 0:
        return "SKIP", "not a git repository"

    body = result.stdout
    for fw in frameworks:
        if fw in body:
            return "PASS", f'"{fw}" found in commit evidence'
    return "FAIL", f'none of {frameworks} found in commit evidence'


def check_value_tracking(spec_dir: Path) -> tuple[str, str]:
    """Check tasks.md effort table has Complete timestamp for latest task."""
    tasks_path = spec_dir / "tasks.md"
    if not tasks_path.exists():
        return "SKIP", "tasks.md not found"

    text = tasks_path.read_text()

    # Find effort table rows (lines starting with | that have Task/number)
    table_rows = []
    header_cols = 0
    for line in text.split("\n"):
        stripped = line.strip()
        if stripped.startswith("| Task"):
            header_cols = len([c for c in stripped.split("|") if c.strip()])
        elif stripped.startswith("|") and not stripped.startswith("|--") and header_cols:
            # Preserve empty cells by splitting with fixed column count
            raw = stripped.split("|")
            # raw[0] is empty (before first |), raw[-1] may be empty (after last |)
            cells = [c.strip() for c in raw[1:-1]] if len(raw) > 2 else []
            if cells and re.match(r"^\d+$", cells[0]):
                # Pad to header column count
                while len(cells) < header_cols:
                    cells.append("")
                table_rows.append(cells)

    if not table_rows:
        return "SKIP", "no effort table in tasks.md"

    # Check last task row for Complete column (last cell)
    last_row = table_rows[-1]
    complete_val = last_row[-1] if last_row else ""
    if complete_val.strip():
        return "PASS", "Complete timestamp populated"
    return "FAIL", "Complete timestamp empty in effort table"


AGENT_CONFIG = Path.home() / ".kiro/agents/gdit-sdaf.json"

LANG_TOOL_MAP: dict[str, list[str]] = {
    "lang-python.md": ["ruff", "pyright", "semgrep", "gitleaks", "trivy", "py_compile"],
    "lang-java-springboot.md": ["spotbugs", "pmd", "gitleaks", "spotless", "dependency-check"],
    "lang-dotnet.md": ["dotnet-format", "semgrep", "gitleaks", "trivy", "dotnet-build"],
}


def check_language_validation(project_dir: Path, custom_tools: dict[str, list[str]] | None = None) -> tuple[str, str]:
    """Check commit evidence contains language-specific validation tool names."""
    if not AGENT_CONFIG.exists():
        return "SKIP", "agent config not found"

    try:
        config = json.loads(AGENT_CONFIG.read_text())
    except (json.JSONDecodeError, OSError):
        return "SKIP", "agent config unreadable"

    resources = config.get("resources", [])
    lang_files = [
        r.rsplit("/", 1)[-1] for r in resources if "lang-" in r and r.endswith(".md")
    ]
    if not lang_files:
        return "SKIP", "no lang-*.md in agent config"

    # Build effective tool map: config overrides take precedence
    effective_map = dict(LANG_TOOL_MAP)
    if custom_tools:
        for key, tools in custom_tools.items():
            # Map short names to steering filenames
            fname = f"lang-{key}.md" if not key.endswith(".md") else key
            if fname == "lang-java.md":
                fname = "lang-java-springboot.md"
            effective_map[fname] = tools

    result = subprocess.run(
        ["git", "log", "-1", "--format=%b"],
        cwd=project_dir, capture_output=True, text=True,
    )
    if result.returncode != 0:
        return "SKIP", "not a git repository"

    body = result.stdout.lower()

    for lang_file in lang_files:
        tools = effective_map.get(lang_file)
        if tools is None:
            return "SKIP", f"{lang_file} not in tool map"
        matched = [t for t in tools if t in body]
        if matched:
            return "PASS", f'"{matched[0]}" found in commit evidence ({lang_file})'
    return "FAIL", f"no validation tool names in commit evidence for {', '.join(lang_files)}"


TEST_EVIDENCE_PATTERNS = [
    "passed", "failed", "assertions", "tests", "test suite", "coverage",
    "pytest", "junit", "jest", "mocha", "rspec", "go test", "cargo test",
    "unittest", "nunit", "xunit", "vitest", "cypress", "playwright",
    "mstest", "dotnet test",
]


def check_test_evidence(project_dir: Path, extra_patterns: list[str] | None = None) -> tuple[str, str]:
    """Check commit evidence contains any common test-related pattern."""
    config = _read_project_yaml(project_dir)
    if config.get("testing", "disable") == "disable":
        return "SKIP", "testing mode is disable"

    result = subprocess.run(
        ["git", "log", "-1", "--format=%b"],
        cwd=project_dir, capture_output=True, text=True,
    )
    if result.returncode != 0:
        return "SKIP", "not a git repository"

    patterns = list(TEST_EVIDENCE_PATTERNS)
    if extra_patterns:
        patterns.extend(p for p in extra_patterns if p not in patterns)

    body = result.stdout.lower()
    for pattern in patterns:
        if pattern in body:
            return "PASS", f'"{pattern}" found in commit evidence'
    return "FAIL", "no test evidence patterns in commit evidence"


def check_spec_completion(spec_dir: Path) -> tuple[bool, int, int]:
    """Check if all tasks in the spec are complete.

    Returns (all_complete, done_count, total_count).
    Parses subtask checkboxes: - [x] = done, - [ ] = not done.
    Only counts lines under ### Task headers (ignores metadata bullets).
    """
    tasks_path = spec_dir / "tasks.md"
    if not tasks_path.exists():
        return False, 0, 0

    text = tasks_path.read_text()
    in_task = False
    done = 0
    total = 0

    for line in text.split("\n"):
        stripped = line.strip()
        if re.match(r"^#{2,3}\s+Task\s+\d+", stripped):
            in_task = True
            continue
        if in_task and stripped.startswith("- ["):
            total += 1
            if stripped.startswith("- [x]") or stripped.startswith("- [X]"):
                done += 1

    if total == 0:
        return False, 0, 0
    return done == total, done, total


def check_sysml_compliance(
    project_dir: Path, spec_dir: Path, config: dict,
) -> tuple[str, str]:
    """Check commit Compliance: tags vs ComplianceGraph satisfy relationships."""
    if not _HAS_SYSML_PARSER:
        return "SKIP", "sysml_graph parser not available"

    sysml_cfg = config.get("sysml", {})
    if not sysml_cfg.get("enabled", False):
        return "SKIP", "sysml.enabled is false"

    model_path = spec_dir / "model.sysml"
    if not model_path.exists():
        return "SKIP", "model.sysml not found"

    graph = _parse_cg(str(model_path))
    if graph is None or not graph.satisfy:
        return "SKIP", "no ComplianceGraph block or no satisfy relationships"

    # Extract Compliance: tags from most recent commit
    result = subprocess.run(
        ["git", "log", "-1", "--format=%b"],
        cwd=project_dir, capture_output=True, text=True,
    )
    if result.returncode != 0:
        return "SKIP", "not a git repository"

    commit_tags: set[str] = set()
    for line in result.stdout.splitlines():
        if line.strip().startswith("Compliance:"):
            raw = line.split(":", 1)[1]
            for tag in re.split(r"[,;]+", raw):
                tag = tag.strip()
                if tag:
                    # Normalize: "NIST 800-218 PW.1.1" -> "PW.1.1"
                    m = re.search(r"([A-Z]{2}\.\d+\.\d+)", tag)
                    if m:
                        commit_tags.add(m.group(1))

    if not commit_tags:
        return "SKIP", "no Compliance: tags in most recent commit"

    graph_practices = set(graph.satisfy.keys())
    issues: list[str] = []
    worst = "PASS"

    # Tags in commit but not in ComplianceGraph -> ADVISORY
    extra = commit_tags - graph_practices
    if extra:
        worst = "ADVISORY"
        issues.append(f"commit tags not in graph: {', '.join(sorted(extra))}")

    # Practices in graph not tagged in commit -> WARN
    missing = graph_practices - commit_tags
    if missing:
        worst = "WARN"
        issues.append(f"graph practices not in commit: {', '.join(sorted(missing))}")

    if not issues:
        return "PASS", f"commit tags match graph ({len(commit_tags)} practice(s))"
    return worst, "; ".join(issues)


CHECKS = [
    ("git checkpoint", lambda proj, spec, cfg: check_git_checkpoint(proj)),
    ("spec validation", lambda proj, spec, cfg: check_spec_validation(spec)),
    ("security scans", lambda proj, spec, cfg: check_security_scans(
        proj, cfg.get("scan-recency-seconds", SCAN_RECENCY_SECONDS),
        cfg.get("scanner-file-mapping"), cfg.get("enabled-scanners"))),
    ("test execution", lambda proj, spec, cfg: check_test_execution(proj)),
    ("value tracking", lambda proj, spec, cfg: check_value_tracking(spec)),
    ("language validation", lambda proj, spec, cfg: check_language_validation(
        proj, cfg.get("validation-tools"))),
    ("test evidence", lambda proj, spec, cfg: check_test_evidence(
        proj, cfg.get("test-evidence-patterns"))),
    ("sysml compliance", lambda proj, spec, cfg: check_sysml_compliance(proj, spec, cfg)),
    ("graphql schema validation", lambda proj, spec, cfg: check_graphql_schema(
        proj, cfg)),
    ("design system", lambda proj, spec, cfg: check_design_system(proj, spec)),
    ("ssdf evidence", lambda proj, spec, cfg: check_ssdf_evidence(proj)),
]

def check_graphql_schema(project_dir: Path, cfg: dict) -> tuple[str, str]:
    """Run ~/.kiro/scripts/validate-graphql-schema.py if graphql-schema-validation is enabled.

    Reads paths from project.yaml:
        graphql:
          cfn-template: infrastructure/cloudformation/15-cardverse-unified-api-v3.yml
          service-file: frontend/src/services/graphqlService.js
    """
    script = Path.home() / ".kiro" / "scripts" / "validate-graphql-schema.py"
    if not script.exists():
        return "SKIP", "validate-graphql-schema.py not found"

    # Read graphql config from project.yaml
    yaml_path = project_dir / ".kiro" / "config" / "project.yaml"
    cfn_template = ""
    service_file = ""
    if yaml_path.exists():
        in_block = False
        for line in yaml_path.read_text().splitlines():
            stripped = line.strip()
            if stripped.startswith("graphql:"):
                in_block = True
                continue
            if in_block:
                if not line.startswith(" ") and not line.startswith("\t") and stripped:
                    break
                if stripped.startswith("cfn-template:"):
                    cfn_template = stripped.split(":", 1)[1].strip().split("#")[0].strip()
                elif stripped.startswith("service-file:"):
                    service_file = stripped.split(":", 1)[1].strip().split("#")[0].strip()

    if not cfn_template or not service_file:
        return "SKIP", "graphql.cfn-template and graphql.service-file not configured in project.yaml"

    env = {**dict(os.environ), "GRAPHQL_CFN_TEMPLATE": cfn_template, "GRAPHQL_SERVICE_FILE": service_file}
    result = subprocess.run(
        [sys.executable, str(script)],
        cwd=project_dir, capture_output=True, text=True, env=env,
    )
    output = result.stdout.strip()
    if result.returncode == 0:
        summary = next((ln.strip() for ln in output.splitlines() if "checked" in ln.lower()), "passed")
        return "PASS", summary
    match = re.search(r"BLOCKED\s*—\s*(\d+)\s+undefined", output)
    count = match.group(1) if match else "unknown"
    return "FAIL", f"{count} undefined field(s) in GraphQL queries"


STATUS_ICONS = {
    "PASS": "✅ PASS ",
    "FAIL": "❌ FAIL ",
    "SKIP": "⏭️  SKIP",
    "WARN": "⚠️  WARN",
    "ADVISORY": "ℹ️  ADVS",
}


def check_design_system(project_dir: Path, spec_dir: Path) -> tuple[str, str]:
    """Advisory check: if design-system enabled and spec has frontend files, verify DESIGN.md was consulted."""
    yaml_path = project_dir / ".kiro" / "config" / "project.yaml"
    if not yaml_path.exists():
        return "SKIP", "project.yaml not found"

    text = yaml_path.read_text()
    enabled = False
    in_section = False
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("design-system:"):
            in_section = True
            continue
        if in_section and not line.startswith(" ") and not line.startswith("\t") and stripped:
            break
        if in_section and stripped.startswith("enabled:"):
            val = stripped.split(":", 1)[1].strip().split("#")[0].strip().lower()
            enabled = val == "true"

    if not enabled:
        return "SKIP", "design-system.enabled is false"

    # Check if tasks.md references frontend files
    tasks_path = spec_dir / "tasks.md"
    if not tasks_path.exists():
        return "SKIP", "tasks.md not found"

    frontend_exts = (".jsx", ".tsx", ".vue", ".svelte", ".css", ".scss", ".html", ".astro")
    tasks_text = tasks_path.read_text()
    has_frontend = any(ext in tasks_text for ext in frontend_exts)
    if not has_frontend:
        has_frontend = bool(re.search(r"(?:frontend|UI\b|component|React|CSS)", tasks_text, re.IGNORECASE))

    if not has_frontend:
        return "SKIP", "no frontend file references in tasks.md"

    # Check commit evidence for DESIGN.md consultation
    result = subprocess.run(
        ["git", "log", "-1", "--format=%s%n%b"],
        cwd=project_dir, capture_output=True, text=True,
    )
    if result.returncode != 0:
        return "SKIP", "not a git repository"

    body = result.stdout.lower()
    if "design.md" in body or "design token" in body or "design system" in body:
        return "PASS", "DESIGN.md consultation evidence in commit"

    # Resolve DESIGN.md path for reporting
    paths_checked = "config path, .kiro/config/DESIGN.md, ~/.kiro/config/DESIGN.md"
    return "ADVISORY", f"frontend spec but no DESIGN.md evidence in commit (checked: {paths_checked})"


def check_ssdf_evidence(project_dir: Path) -> tuple[str, str]:
    """Auto-run SSDF evidence collection when stale (>staleness-days)."""
    yaml_path = project_dir / ".kiro" / "config" / "project.yaml"
    if not yaml_path.exists():
        return "SKIP", "project.yaml not found"

    text = yaml_path.read_text()
    last_run = ""
    staleness_days = 14
    in_section = False

    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("ssdf:"):
            in_section = True
            continue
        if in_section and not line.startswith(" ") and not line.startswith("\t") and stripped:
            break
        if in_section:
            if stripped.startswith("last-evidence-collection:"):
                val = stripped.split(":", 1)[1].strip().split("#")[0].strip().strip('"').strip("'")
                last_run = val
            elif stripped.startswith("staleness-days:"):
                val = stripped.split(":", 1)[1].strip().split("#")[0].strip()
                if val.isdigit():
                    staleness_days = int(val)

    # Determine staleness
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc)
    is_stale = True
    days_since = None

    if last_run:
        try:
            # Parse ISO 8601 timestamp (with or without timezone)
            ts = last_run.replace("Z", "+00:00")
            if "+" not in ts and len(ts) <= 19:
                ts += "+00:00"
            last_dt = datetime.fromisoformat(ts)
            days_since = (now - last_dt).days
            is_stale = days_since >= staleness_days
        except (ValueError, TypeError):
            is_stale = True  # unparseable = stale

    if not is_stale:
        return "PASS", f"SSDF evidence collected {days_since} day(s) ago (threshold: {staleness_days})"

    # Auto-run collect_evidence.py
    script = Path.home() / ".kiro" / "skills" / "ssdf-development" / "scripts" / "collect_evidence.py"
    if not script.exists():
        return "WARN", "ssdf-development skill not installed (collect_evidence.py not found)"

    output_path = project_dir / "docs" / "compliance-by-family" / "EVIDENCE-REPORT.md"
    output_path.parent.mkdir(parents=True, exist_ok=True)

    result = subprocess.run(
        [sys.executable, str(script), "--days", "365", "--output", str(output_path)],
        cwd=project_dir, capture_output=True, text=True,
    )

    if result.returncode != 0:
        err = result.stderr.strip()[:100] if result.stderr else "unknown error"
        return "WARN", f"collect_evidence.py failed (exit {result.returncode}): {err}"

    # Update timestamp in project.yaml
    new_ts = now.strftime("%Y-%m-%dT%H:%M:%S")
    _update_ssdf_timestamp(yaml_path, new_ts)

    return "PASS", f"SSDF evidence auto-collected (was stale), timestamp updated to {new_ts}"


def _update_ssdf_timestamp(yaml_path: Path, timestamp: str) -> None:
    """Update ssdf.last-evidence-collection in project.yaml, preserving formatting."""
    lines = yaml_path.read_text().splitlines(keepends=True)
    in_section = False
    key_found = False
    section_end = -1

    for i, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith("ssdf:"):
            in_section = True
            section_end = i
            continue
        if in_section and not line.startswith(" ") and not line.startswith("\t") and stripped:
            break
        if in_section:
            section_end = i
            if stripped.startswith("last-evidence-collection:"):
                # Replace value in-place
                prefix = line.split("last-evidence-collection:")[0]
                lines[i] = f"{prefix}last-evidence-collection: \"{timestamp}\"\n"
                key_found = True
                break

    if not key_found and in_section:
        # Insert key after section header
        insert_at = section_end + 1
        lines.insert(insert_at, f"  last-evidence-collection: \"{timestamp}\"\n")
    elif not in_section:
        # Append section at end
        lines.append(f"\nssdf:\n  last-evidence-collection: \"{timestamp}\"\n  staleness-days: 14\n")

    # Atomic write
    tmp = yaml_path.with_suffix(".yaml.tmp")
    tmp.write_text("".join(lines))
    tmp.rename(yaml_path)


def main():
    if len(sys.argv) < 2:
        print(f"Usage: {sys.argv[0]} <spec-directory>", file=sys.stderr)
        sys.exit(2)

    spec_dir = Path(sys.argv[1]).resolve()
    project_dir = Path.cwd()

    config = _read_project_yaml(project_dir)
    audit_config = config.get("audit", {})
    security_config = config.get("security", {})
    if "scanner-file-mapping" in security_config:
        audit_config["scanner-file-mapping"] = security_config["scanner-file-mapping"]
    if "enabled-scanners" in security_config:
        audit_config["enabled-scanners"] = security_config["enabled-scanners"]
    sysml_config = config.get("sysml", {})
    if sysml_config:
        audit_config["sysml"] = sysml_config

    results = []
    for name, check_fn in CHECKS:
        key = name.replace(" ", "-")
        if not audit_config.get(key, True):
            results.append((name, "SKIP", "disabled in project.yaml"))
            continue
        status, msg = check_fn(project_dir, spec_dir, audit_config)
        results.append((name, status, msg))

    # Output
    print("── Steering Compliance Audit ──────────────────")
    for name, status, msg in results:
        icon = STATUS_ICONS.get(status, status)
        print(f"{icon} {name} — {msg}")

    passed = sum(1 for _, s, _ in results if s == "PASS")
    failed = sum(1 for _, s, _ in results if s == "FAIL")
    warned = sum(1 for _, s, _ in results if s in ("WARN", "ADVISORY"))
    total = passed + failed + warned

    if failed == 0:
        print(f"── Audit: {passed}/{total} passed ──────────────────────")
        # Check if all tasks in spec are complete — trigger verification
        all_done, done_count, total_tasks = check_spec_completion(spec_dir)
        if all_done and total_tasks > 0:
            print(f"── SPEC COMPLETE: {done_count}/{total_tasks} subtasks done ──")
            print("── ACTION: Run two-layer verification and generate VERIFICATION.md ──")
    else:
        print(f"── Audit: {passed}/{total} passed — {failed} failure(s) ─────")

    sys.exit(1 if failed > 0 else 0)


if __name__ == "__main__":
    main()
