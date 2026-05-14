#!/usr/bin/env python3
"""GDIT-SDAF Framework — Prerequisite Checker

Usage: python3 ~/.kiro/scripts/check-prereqs.py
Exit 0 if required tools present, 1 if missing required tools.
"""

import shutil
import subprocess
import sys


def check_tool(name, level, hint):
    """Check if a tool is available. Returns (name, level, found, version)."""
    path = shutil.which(name)
    version = ""
    if path:
        try:
            result = subprocess.run(
                [name, "--version"], capture_output=True, text=True, timeout=10
            )
            version = (result.stdout or result.stderr).strip().split("\n")[0]
        except Exception:
            version = "installed"
    return {"name": name, "level": level, "hint": hint, "found": bool(path), "version": version}


def main():
    required = [
        ("python3", "Install via system package manager"),
    ]
    recommended = [
        ("semgrep", "pip install semgrep"),
        ("gitleaks", "brew install gitleaks (or GitHub releases)"),
        ("trivy", "brew install trivy (or GitHub releases)"),
        ("checkov", "pip install checkov"),
        ("shellcheck", "apt install shellcheck / brew install shellcheck"),
        ("yamllint", "pip install yamllint"),
    ]
    conditional = [
        ("cfn-lint", "pip install cfn-lint (CloudFormation)"),
        ("cfn-guard", "brew install cloudformation-guard (CloudFormation)"),
        ("tfsec", "brew install tfsec (Terraform)"),
        ("kics", "Docker or GitHub releases (optional IaC scanner)"),
    ]

    print("GDIT-SDAF Framework — Prerequisite Check")
    print("====================================\n")

    missing_required = False
    missing_recommended = False

    print("Required:")
    for name, hint in required:
        r = check_tool(name, "required", hint)
        if r["found"]:
            print(f"  ✓ {r['name']:<20s} {r['version']}")
        else:
            print(f"  ✗ {r['name']:<20s} MISSING — {r['hint']}")
            missing_required = True

    print("\nRecommended (core scanning):")
    for name, hint in recommended:
        r = check_tool(name, "recommended", hint)
        if r["found"]:
            print(f"  ✓ {r['name']:<20s} {r['version']}")
        else:
            print(f"  ○ {r['name']:<20s} not found — {r['hint']}")
            missing_recommended = True

    print("\nConditional (cloud-specific):")
    for name, hint in conditional:
        r = check_tool(name, "conditional", hint)
        if r["found"]:
            print(f"  ✓ {r['name']:<20s} {r['version']}")
        else:
            print(f"  ○ {r['name']:<20s} not found (optional) — {r['hint']}")

    print()
    if missing_required:
        print("FAIL: Missing required tools. Install them before proceeding.")
        return 1
    if missing_recommended:
        print("WARNING: Some recommended tools missing. Scans will be skipped for those.")
    print("OK: All required tools present.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
