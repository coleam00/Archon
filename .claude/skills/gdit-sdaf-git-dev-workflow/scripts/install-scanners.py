#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///

"""
Install Security Scanners
Installs all required security scanning tools using Python-native methods
"""

import subprocess
import sys
import platform
import urllib.request
import tarfile
import zipfile
import os

def run_command(cmd):
    """Run command and return success"""
    try:
        result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
        return result.returncode == 0
    except Exception:
        return False

def install_gitleaks():
    print("📦 Installing gitleaks...")
    system = platform.system().lower()
    arch = platform.machine().lower()

    # Map architecture
    if arch in ["x86_64", "amd64"]:
        arch = "x64"
    elif arch in ["aarch64", "arm64"]:
        arch = "arm64"

    # Download appropriate binary
    if system == "linux":
        url = f"https://github.com/gitleaks/gitleaks/releases/latest/download/gitleaks_linux_{arch}.tar.gz"
    elif system == "darwin":
        url = f"https://github.com/gitleaks/gitleaks/releases/latest/download/gitleaks_darwin_{arch}.tar.gz"
    elif system == "windows":
        url = f"https://github.com/gitleaks/gitleaks/releases/latest/download/gitleaks_windows_{arch}.zip"
    else:
        print(f"⚠️  Unsupported platform: {system}")
        return False

    try:
        tmp_file = f"/tmp/gitleaks.{'zip' if system == 'windows' else 'tar.gz'}"
        urllib.request.urlretrieve(url, tmp_file)

        if system == "windows":
            with zipfile.ZipFile(tmp_file, 'r') as z:
                z.extract("gitleaks.exe", "/usr/local/bin")
        else:
            with tarfile.open(tmp_file, 'r:gz') as t:
                t.extract("gitleaks", "/usr/local/bin")
            os.chmod("/usr/local/bin/gitleaks", 0o755)

        print("✅ gitleaks installed")
        return True
    except Exception as e:
        print(f"⚠️  gitleaks installation failed: {e}")
        return False

def install_semgrep():
    print("📦 Installing semgrep...")
    if run_command(f"{sys.executable} -m pip install --user semgrep"):
        print("✅ semgrep installed")
        return True
    print("⚠️  semgrep installation failed")
    return False

def install_trivy():
    print("📦 Installing trivy...")
    system = platform.system().lower()
    arch = platform.machine().lower()

    if arch in ["x86_64", "amd64"]:
        arch = "64bit"
    elif arch in ["aarch64", "arm64"]:
        arch = "ARM64"

    if system == "linux":
        url = f"https://github.com/aquasecurity/trivy/releases/latest/download/trivy_{arch}.tar.gz"
    elif system == "darwin":
        url = f"https://github.com/aquasecurity/trivy/releases/latest/download/trivy_macOS-{arch}.tar.gz"
    elif system == "windows":
        url = f"https://github.com/aquasecurity/trivy/releases/latest/download/trivy_{arch}.zip"
    else:
        print(f"⚠️  Unsupported platform: {system}")
        return False

    try:
        tmp_file = f"/tmp/trivy.{'zip' if system == 'windows' else 'tar.gz'}"
        urllib.request.urlretrieve(url, tmp_file)

        if system == "windows":
            with zipfile.ZipFile(tmp_file, 'r') as z:
                z.extract("trivy.exe", "/usr/local/bin")
        else:
            with tarfile.open(tmp_file, 'r:gz') as t:
                t.extract("trivy", "/usr/local/bin")
            os.chmod("/usr/local/bin/trivy", 0o755)

        print("✅ trivy installed")
        return True
    except Exception as e:
        print(f"⚠️  trivy installation failed: {e}")
        return False

def install_cfn_lint():
    print("📦 Installing cfn-lint...")
    if run_command(f"{sys.executable} -m pip install --user cfn-lint"):
        print("✅ cfn-lint installed")
        return True
    print("⚠️  cfn-lint installation failed")
    return False

def install_cfn_guard():
    print("📦 Installing cfn-guard...")
    # Try cargo first
    if run_command("command -v cargo") and run_command("cargo install cfn-guard"):
        print("✅ cfn-guard installed")
        return True

    # Download binary
    system = platform.system().lower()
    if system == "linux":
        url = "https://github.com/aws-cloudformation/cloudformation-guard/releases/latest/download/cfn-guard-v3-ubuntu-latest.tar.gz"
    elif system == "darwin":
        url = "https://github.com/aws-cloudformation/cloudformation-guard/releases/latest/download/cfn-guard-v3-macos-latest.tar.gz"
    else:
        print("⚠️  cfn-guard binary not available for Windows, install via cargo")
        return False

    try:
        tmp_file = "/tmp/cfn-guard.tar.gz"
        urllib.request.urlretrieve(url, tmp_file)
        with tarfile.open(tmp_file, 'r:gz') as t:
            t.extractall("/usr/local/bin")
        os.chmod("/usr/local/bin/cfn-guard", 0o755)
        print("✅ cfn-guard installed")
        return True
    except Exception as e:
        print(f"⚠️  cfn-guard installation failed: {e}")
        return False

def install_checkov():
    print("📦 Installing checkov...")
    if run_command(f"{sys.executable} -m pip install --user checkov"):
        print("✅ checkov installed")
        return True
    print("⚠️  checkov installation failed")
    return False

def install_ruff():
    print("📦 Installing ruff...")
    if run_command(f"{sys.executable} -m pip install --user ruff"):
        print("✅ ruff installed")
        return True
    print("⚠️  ruff installation failed")
    return False

def install_pyright():
    print("📦 Installing pyright...")
    if run_command(f"{sys.executable} -m pip install --user pyright"):
        print("✅ pyright installed")
        return True
    print("⚠️  pyright installation failed")
    return False

def install_kics():
    print("📦 Installing KICS...")
    system = platform.system().lower()
    arch = platform.machine().lower()

    if arch in ["x86_64", "amd64"]:
        arch = "x64"
    elif arch in ["aarch64", "arm64"]:
        arch = "arm64"

    if system == "linux":
        url = f"https://github.com/Checkmarx/kics/releases/latest/download/kics_{arch}_linux"
    elif system == "darwin":
        url = f"https://github.com/Checkmarx/kics/releases/latest/download/kics_{arch}_darwin"
    elif system == "windows":
        url = f"https://github.com/Checkmarx/kics/releases/latest/download/kics_{arch}_windows.exe"
    else:
        print(f"⚠️  Unsupported platform: {system}")
        return False

    try:
        binary_name = "kics.exe" if system == "windows" else "kics"
        dest = f"/usr/local/bin/{binary_name}"
        urllib.request.urlretrieve(url, dest)
        if system != "windows":
            os.chmod(dest, 0o755)
        print("✅ KICS installed")
        return True
    except Exception as e:
        print(f"⚠️  KICS installation failed (optional scanner): {e}")
        return False

def main():
    print("=== Installing Security Scanners ===\n")

    installers = {
        "gitleaks": install_gitleaks,
        "semgrep": install_semgrep,
        "trivy": install_trivy,
        "cfn-lint": install_cfn_lint,
        "cfn-guard": install_cfn_guard,
        "checkov": install_checkov,
        "ruff": install_ruff,
        "pyright": install_pyright,
        "kics": install_kics,
    }

    # Install specific scanners or all
    if len(sys.argv) > 1:
        for scanner in sys.argv[1:]:
            if scanner in installers:
                installers[scanner]()
            else:
                print(f"Unknown scanner: {scanner}")
    else:
        # Install all
        for scanner, installer in installers.items():
            if run_command(f"command -v {scanner}"):
                print(f"✓ {scanner} already installed")
            else:
                if scanner == "kics":
                    installer()  # Optional, don't fail
                else:
                    installer()

    print("\n✅ Scanner installation complete")

if __name__ == "__main__":
    main()
