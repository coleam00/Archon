#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""Generate SBOM from project dependencies.

Attempts tool-based generation (syft, cyclonedx-py, cyclonedx-npm) with
fallback to manual parsing into CycloneDX 1.5 JSON.
"""

import json
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

DEP_FILES = {
    "requirements.txt": "pypi",
    "Pipfile.lock": "pypi",
    "poetry.lock": "pypi",
    "package.json": "npm",
    "package-lock.json": "npm",
    "pom.xml": "maven",
    "build.gradle": "maven",
    "go.mod": "golang",
}


def parse_args() -> dict:
    args = {"format": "cyclonedx", "output": None, "project": "."}
    i = 1
    while i < len(sys.argv):
        if sys.argv[i] == "--format" and i + 1 < len(sys.argv):
            args["format"] = sys.argv[i + 1]
            i += 2
        elif sys.argv[i] == "--output" and i + 1 < len(sys.argv):
            args["output"] = sys.argv[i + 1]
            i += 2
        elif sys.argv[i] == "--project" and i + 1 < len(sys.argv):
            args["project"] = sys.argv[i + 1]
            i += 2
        elif sys.argv[i] in ("-h", "--help"):
            print("Usage: generate_sbom.py [--project DIR] [--format cyclonedx|spdx] [--output PATH]")
            sys.exit(0)
        else:
            i += 1
    return args


def detect_dep_files(project: Path) -> list[tuple[Path, str]]:
    found = []
    for name, ecosystem in DEP_FILES.items():
        path = project / name
        if path.exists():
            found.append((path, ecosystem))
    return found


def try_syft(project: Path, output: Path, fmt: str) -> bool:
    if not shutil.which("syft"):
        return False
    out_fmt = "cyclonedx-json" if fmt == "cyclonedx" else "spdx-json"
    result = subprocess.run(
        ["syft", str(project), "-o", out_fmt, "--file", str(output)],
        capture_output=True, text=True
    )
    return result.returncode == 0 and output.exists()


def try_cyclonedx_py(project: Path, output: Path) -> bool:
    req = project / "requirements.txt"
    if not req.exists() or not shutil.which("cyclonedx-py"):
        return False
    result = subprocess.run(
        ["cyclonedx-py", "requirements", "-i", str(req), "-o", str(output), "--format", "json"],
        capture_output=True, text=True
    )
    return result.returncode == 0 and output.exists()


def try_cyclonedx_npm(project: Path, output: Path) -> bool:
    pkg = project / "package.json"
    if not pkg.exists() or not shutil.which("npx"):
        return False
    result = subprocess.run(
        ["npx", "@cyclonedx/cyclonedx-npm", "--output-file", str(output)],
        capture_output=True, text=True, cwd=str(project)
    )
    return result.returncode == 0 and output.exists()


def parse_requirements_txt(path: Path) -> list[dict]:
    components = []
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or line.startswith("-"):
            continue
        match = re.match(r"([a-zA-Z0-9_.-]+)\s*(?:==|>=|~=|!=|<=|>|<)\s*([a-zA-Z0-9_.*-]+)", line)
        if match:
            name, version = match.group(1), match.group(2)
            components.append({
                "type": "library", "name": name, "version": version,
                "purl": f"pkg:pypi/{name.lower()}@{version}", "scope": "required"
            })
    return components


def parse_package_json(path: Path) -> list[dict]:
    data = json.loads(path.read_text())
    components = []
    for section in ("dependencies", "devDependencies"):
        scope = "required" if section == "dependencies" else "optional"
        for name, version in data.get(section, {}).items():
            clean_ver = re.sub(r"^[\^~>=<]+", "", version)
            purl_name = name.replace("/", "%2F")
            components.append({
                "type": "library", "name": name, "version": clean_ver,
                "purl": f"pkg:npm/{purl_name}@{clean_ver}", "scope": scope
            })
    return components


def parse_go_mod(path: Path) -> list[dict]:
    components = []
    in_require = False
    for line in path.read_text().splitlines():
        line = line.strip()
        if line == "require (":
            in_require = True
            continue
        if line == ")" and in_require:
            in_require = False
            continue
        if in_require:
            parts = line.split()
            if len(parts) >= 2:
                name, version = parts[0], parts[1]
                components.append({
                    "type": "library", "name": name, "version": version,
                    "purl": f"pkg:golang/{name}@{version}", "scope": "required"
                })
    return components


def fallback_generate(project: Path, dep_files: list[tuple[Path, str]]) -> dict:
    print("Using manual fallback (direct dependencies only, no transitive)", file=sys.stderr)
    components = []
    for path, ecosystem in dep_files:
        if path.name == "requirements.txt":
            components.extend(parse_requirements_txt(path))
        elif path.name == "package.json":
            components.extend(parse_package_json(path))
        elif path.name == "go.mod":
            components.extend(parse_go_mod(path))

    project_name = project.resolve().name
    return {
        "bomFormat": "CycloneDX",
        "specVersion": "1.5",
        "version": 1,
        "metadata": {
            "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "tools": [{"name": "ssdf-development", "version": "1.0"}],
            "component": {"type": "application", "name": project_name, "version": "0.0.0"}
        },
        "components": components,
    }


def validate_cyclonedx(data: dict) -> list[str]:
    warnings = []
    if data.get("bomFormat") != "CycloneDX":
        warnings.append("Missing or incorrect bomFormat")
    if "specVersion" not in data:
        warnings.append("Missing specVersion")
    if "metadata" not in data:
        warnings.append("Missing metadata")
    if "components" not in data:
        warnings.append("Missing components array")
    return warnings


def main() -> None:
    args = parse_args()
    project = Path(args["project"]).resolve()
    dep_files = detect_dep_files(project)

    if not dep_files:
        print("No dependency files found", file=sys.stderr)
        sys.exit(1)

    print(f"Found: {', '.join(p.name for p, _ in dep_files)}", file=sys.stderr)

    output = Path(args["output"]) if args["output"] else None
    tmp_output = output or Path("sbom.json")

    generated = False
    if args["format"] == "cyclonedx":
        generated = try_syft(project, tmp_output, "cyclonedx")
        if not generated:
            generated = try_cyclonedx_py(project, tmp_output)
        if not generated:
            generated = try_cyclonedx_npm(project, tmp_output)

    if generated and tmp_output.exists():
        data = json.loads(tmp_output.read_text())
        method = "tool-based"
    else:
        data = fallback_generate(project, dep_files)
        method = "fallback"

    warnings = validate_cyclonedx(data)
    comp_count = len(data.get("components", []))
    print(f"Method: {method}, Components: {comp_count}", file=sys.stderr)
    for w in warnings:
        print(f"Warning: {w}", file=sys.stderr)

    # Always reformat for readability (tool output may be compact single-line)
    result = json.dumps(data, indent=2, ensure_ascii=False) + "\n"
    if output:
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(result)
        print(f"SBOM written to {output}", file=sys.stderr)
    else:
        print(result)


if __name__ == "__main__":
    main()
