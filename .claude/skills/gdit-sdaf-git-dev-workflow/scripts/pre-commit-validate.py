#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "pyyaml>=6.0",
# ]
# ///

"""
Pre-Commit Security Validation
Runs all security scanners on the codebase

Usage:
  python3 pre-commit-validate.py [options]

Options:
  --install-missing   Auto-install missing scanners
  --no-history        Scan working tree only (faster, but won't match GitLab)
"""

import subprocess
import sys
import json
import os
import re
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent
ASSETS_DIR = SCRIPT_DIR.parent / "assets"
SCAN_OUTPUT_DIR = ".security-scans"

def ensure_gitignore():
    """Ensure scan output directory is in .gitignore"""
    gitignore = Path(".gitignore")

    # Create .gitignore if it doesn't exist
    if not gitignore.exists():
        gitignore.write_text(f"# Security scanner outputs\n{SCAN_OUTPUT_DIR}/\n")
        print(f"✓ Created .gitignore with {SCAN_OUTPUT_DIR}/")
        return

    # Check if already in .gitignore
    content = gitignore.read_text()
    if SCAN_OUTPUT_DIR in content:
        return

    # Add to .gitignore
    with open(gitignore, 'a') as f:
        if not content.endswith('\n'):
            f.write('\n')
        f.write(f"\n# Security scanner outputs\n{SCAN_OUTPUT_DIR}/\n")

    print(f"✓ Added {SCAN_OUTPUT_DIR}/ to .gitignore")

def setup_output_dir():
    """Create output directory for scanner results"""
    output_dir = Path(SCAN_OUTPUT_DIR)
    output_dir.mkdir(exist_ok=True)
    return output_dir

def run_command(cmd, check=False):
    """Run command and return output"""
    try:
        result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
        return result.returncode, result.stdout, result.stderr
    except Exception as e:
        return 1, "", str(e)

def check_scanner(name):
    """Check if scanner is installed"""
    code, _, _ = run_command(f"command -v {name}")
    return code == 0

def main():
    install_missing = "--install-missing" in sys.argv

    # Ensure .gitignore has scan output directory
    ensure_gitignore()

    # Setup output directory
    output_dir = setup_output_dir()

    print("\n=== Pre-Commit Security Validation ===")
    print(f"Scanner outputs: {output_dir}/\n")

    # Check for required scanners
    required = ["gitleaks", "semgrep", "trivy", "cfn-lint", "checkov", "ruff", "pyright"]
    missing = [s for s in required if not check_scanner(s)]

    if missing:
        print(f"⚠️  Missing required scanners: {', '.join(missing)}")
        if install_missing:
            print("Installing missing scanners...")
            subprocess.run([sys.executable, str(SCRIPT_DIR / "install-scanners.py")] + missing)
        else:
            print("Run with --install-missing to install them")
            sys.exit(1)

    # Check optional scanners
    if not check_scanner("kics"):
        code, _, _ = run_command("docker image inspect checkmarx/kics:latest")
        if code != 0:
            print("ℹ️  KICS not installed (no binary or Docker image)\n")

    errors = 0
    warnings = 0

    # 1. Gitleaks
    skip_history = "--no-history" in sys.argv
    mode_label = "working tree only" if skip_history else "git history"
    print(f"🔍 Running gitleaks ({mode_label})...")
    config = ASSETS_DIR / ".gitleaks.toml"
    report = output_dir / "gitleaks-report.json"
    git_flag = "--no-git" if skip_history else ""
    code, out, err = run_command(f"gitleaks detect --source . --config {config} {git_flag} --report-path {report} --report-format json")
    if code == 0:
        print("✅ No secrets detected")
    elif report.exists() and report.stat().st_size > 100:
        print("❌ BLOCKED: Secrets detected")
        errors += 1
    else:
        print("✅ No secrets detected")

    # 2. Semgrep
    print("\n🔍 Running semgrep (security, OWASP, CWE, secrets, code quality)...")
    os.environ["SEMGREP_SEND_METRICS"] = "off"
    semgrep_output = output_dir / "semgrep-report.json"

    code, out, err = run_command(
        f"semgrep --config p/security-audit "
        f"--config p/owasp-top-ten "
        f"--config p/cwe-top-25 "
        f"--config p/secrets "
        f"--config p/code-quality "
        f"--severity ERROR --no-git-ignore --json --output {semgrep_output} ."
    )

    try:
        if semgrep_output.exists():
            with open(semgrep_output) as f:
                results = json.load(f)
        else:
            results = json.loads(out) if out else {"results": []}

        error_count = len(results.get("results", []))
        if error_count > 0:
            print(f"❌ BLOCKED: {error_count} ERROR-level findings")
            for r in results["results"][:10]:
                print(f"  - {r['check_id']}: {r['path']}:{r['start']['line']}")
            errors += 1
        else:
            print("✅ No ERROR-level findings")
    except Exception:
        print("✅ No ERROR-level findings")

    # 3. Trivy
    print("\n🔍 Running trivy...")
    trivy_output = output_dir / "trivy-report.json"
    config = ASSETS_DIR / "trivy.yaml"
    code, out, err = run_command(f"trivy fs --config {config} --format json --output {trivy_output} .")

    try:
        if trivy_output.exists():
            with open(trivy_output) as f:
                results = json.load(f)
        else:
            results = json.loads(out) if out else {"Results": []}

        vulns = sum(len(r.get("Vulnerabilities", [])) for r in results.get("Results", []))
        if vulns > 0:
            print(f"❌ BLOCKED: {vulns} HIGH/CRITICAL vulnerabilities")
            errors += 1
        else:
            print("✅ No HIGH/CRITICAL vulnerabilities")
    except Exception:
        print("✅ No HIGH/CRITICAL vulnerabilities")

    # 4. CloudFormation
    cfn_files = []
    for ext in ["*.yaml", "*.yml", "*.json"]:
        code, out, _ = run_command(f"find . -type f -name '{ext}' ! -path '*/node_modules/*' ! -path '*/.git/*' ! -path '*/temp/*' ! -path '*/testing/*' ! -path '*/.kiro/specs/*' ! -path '*/.security-scans/*'")
        if out:
            cfn_files.extend(out.strip().split("\n"))

    if cfn_files:
        print("\n🔍 Running CloudFormation validation...")
        cfn_lint_config = ASSETS_DIR / ".cfnlintrc"
        guard_rules = ASSETS_DIR / "cfn-guard-rules.guard"

        for file in cfn_files:
            # Check if it's a CFN template
            try:
                with open(file) as f:
                    content = f.read()
                    if "AWSTemplateFormatVersion" not in content and "Resources:" not in content:
                        continue
            except Exception:
                continue

            # cfn-lint
            cmd = f"cfn-lint --config-file {cfn_lint_config} {file}" if cfn_lint_config.exists() else f"cfn-lint {file}"
            code, out, err = run_command(cmd)
            if re.search(r'E\d{4}', out) or re.search(r'E\d{4}', err):
                print(f"❌ BLOCKED: cfn-lint errors in {file}")
                errors += 1

            # cfn-guard
            if guard_rules.exists():
                code, _, _ = run_command(f"cfn-guard validate --data {file} --rules {guard_rules}")
                if code != 0:
                    print(f"⚠️  WARNING: cfn-guard policy violations in {file}")
                    warnings += 1

        print("✅ CloudFormation validation complete")

    # 5. Checkov
    print("\n🔍 Running checkov...")
    output_dir / "checkov-report.json"
    checkov_config = ASSETS_DIR / ".checkov.yml"
    cmd = f"checkov -d . --config-file {checkov_config} --output json --output-file-path {output_dir}" if checkov_config.exists() else f"checkov -d . --framework cloudformation terraform --output json --output-file-path {output_dir}"
    code, out, err = run_command(cmd)

    # Checkov creates results_json.json by default
    checkov_results = output_dir / "results_json.json"
    if checkov_results.exists():
        try:
            with open(checkov_results) as f:
                results = json.load(f)
            failed = results.get("summary", {}).get("failed", 0)
            if failed > 0:
                print(f"⚠️  WARNING: {failed} checkov findings")
                warnings += 1
            else:
                print("✅ No checkov findings")
        except Exception:
            print("✅ No checkov findings")
    else:
        print("✅ No checkov findings")

    # 6. Ruff (Python linting)
    print("\n🔍 Running ruff (Python linting)...")
    ruff_output = output_dir / "ruff-report.json"
    code, out, err = run_command("ruff check . --select=F,UP015,B --output-format=json --no-fix --quiet")

    if out.strip():
        try:
            findings = json.loads(out)
            if len(findings) > 0:
                print(f"⚠️  WARNING: {len(findings)} ruff findings")
                warnings += 1
                with open(ruff_output, 'w') as f:
                    f.write(out)
            else:
                print("✅ No ruff findings")
        except Exception:
            print("✅ No ruff findings")
    else:
        print("✅ No ruff findings")

    # 7. Pyright (Python type checking - unbound variables)
    print("\n🔍 Running pyright (Python type checking)...")
    pyright_output = output_dir / "pyright-report.json"
    code, out, err = run_command("pyright . --outputjson")

    if out.strip():
        try:
            data = json.loads(out)
            with open(pyright_output, 'w') as f:
                f.write(out)
            unbound = [d for d in data.get('generalDiagnostics', []) if d.get('rule') == 'reportUnboundVariable']
            if len(unbound) > 0:
                print(f"❌ BLOCKED: {len(unbound)} pyright unbound variable errors")
                errors += 1
            else:
                print("✅ No pyright unbound variable errors")
        except Exception:
            print("✅ No pyright unbound variable errors")
    else:
        print("✅ No pyright unbound variable errors")

    # 8. KICS (optional — native binary or Docker)
    kics_native = check_scanner("kics")
    kics_docker = False
    if not kics_native:
        code, _, _ = run_command("docker image inspect checkmarx/kics:latest")
        kics_docker = code == 0

    if kics_native or kics_docker:
        print("\n🔍 Running KICS...")
        kics_output = output_dir / "kics-report.json"
        kics_config = ASSETS_DIR / "kics.config"
        if kics_native:
            cmd = f"kics scan -p . --config {kics_config} --output-path {output_dir} --output-name kics-report" if kics_config.exists() else f"kics scan -p . --exclude-paths node_modules --output-path {output_dir} --output-name kics-report"
        else:
            cwd = os.getcwd()
            config_mount = f"-v {kics_config}:/app/kics.config --config /app/kics.config" if kics_config.exists() else "--exclude-paths node_modules"
            cmd = f"docker run --rm -v {cwd}:/path -v {output_dir}:/output checkmarx/kics:latest scan -p /path {config_mount} --output-path /output --output-name kics-report"
        code, out, err = run_command(cmd)

        if kics_output.exists():
            try:
                with open(kics_output) as f:
                    results = json.load(f)
                high_critical = results.get("severity_counters", {}).get("HIGH", 0) + results.get("severity_counters", {}).get("CRITICAL", 0)
                if high_critical > 0:
                    print(f"❌ BLOCKED: {high_critical} HIGH/CRITICAL KICS findings")
                    errors += 1
                else:
                    print("✅ No HIGH/CRITICAL KICS findings")
            except Exception:
                print("✅ No HIGH/CRITICAL KICS findings")
        else:
            print("✅ No HIGH/CRITICAL KICS findings")
    else:
        print("\nℹ️  KICS not installed (optional scanner, skipping)")

    # Summary
    print("\n=== Validation Summary ===")
    print(f"Errors: {errors}")
    print(f"Warnings: {warnings}\n")

    if errors > 0:
        print("❌ VALIDATION FAILED - Commit blocked")
        print("Fix errors and run validation again")
        sys.exit(1)

    if warnings > 0:
        print("⚠️  VALIDATION PASSED with warnings")
        print("Review warnings before proceeding")

    print("✅ VALIDATION PASSED - Safe to commit")
    sys.exit(0)

if __name__ == "__main__":
    main()
