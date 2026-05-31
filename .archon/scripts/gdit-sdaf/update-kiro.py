#!/usr/bin/env python3
"""Detect installed Kiro IDE and kiro-cli versions, check for updates, and upgrade when behind."""

import json
import os
import platform
import subprocess
import sys
import urllib.request

CLI_INDEX_URL = "https://desktop-release.q.us-east-1.amazonaws.com/index.json"
IDE_UPDATE_URL = "https://prod.download.desktop.kiro.dev"
IDE_PRODUCT_JSON = "/usr/share/kiro/resources/app/product.json"


def run(cmd, capture=True):
    r = subprocess.run(cmd, shell=True, capture_output=capture, text=True)
    return r.stdout.strip() if capture else None, r.returncode


def get_arch():
    m = platform.machine()
    return "x86_64" if m in ("x86_64", "AMD64") else "aarch64" if m == "aarch64" else m


def get_installed_cli_version():
    out, rc = run("kiro-cli --version 2>/dev/null")
    if rc == 0 and out:
        # First line: "kiro-cli X.Y.Z"
        for line in out.splitlines():
            if line.startswith("kiro-cli"):
                return line.split()[-1]
            # Sometimes just the version
            parts = line.strip().split(".")
            if len(parts) == 3 and all(p.isdigit() for p in parts):
                return line.strip()
    return None


def get_installed_ide_version():
    # Try product.json first
    if os.path.exists(IDE_PRODUCT_JSON):
        with open(IDE_PRODUCT_JSON) as f:
            return json.load(f).get("version")
    # Fall back to dpkg
    out, rc = run("dpkg-query -W -f='${Version}' kiro 2>/dev/null")
    if rc == 0 and out:
        # Strip build metadata (e.g., 0.11.131-1775674638 -> 0.11.131)
        return out.split("-")[0]
    return None


def fetch_cli_index():
    req = urllib.request.Request(CLI_INDEX_URL, headers={"User-Agent": "update-kiro/1.0"})
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read())


def get_latest_cli_version(index):
    if index.get("versions"):
        return index["versions"][0]["version"]
    return None


def get_cli_deb_package(index, version, arch):
    for v in index["versions"]:
        if v["version"] == version:
            for p in v["packages"]:
                if (p.get("os") == "linux" and p.get("architecture") == arch
                        and p.get("fileType") == "deb" and p.get("variant") == "full"):
                    return p
    return None


def get_latest_ide_version():
    """Check for latest IDE version via the download page or update API."""
    # Try fetching the kiro.dev download page for version info
    try:
        req = urllib.request.Request("https://kiro.dev", headers={"User-Agent": "update-kiro/1.0"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            html = resp.read().decode()
        # Look for version patterns like "0.XX.YYY" in download links
        import re
        versions = re.findall(r'(?:kiro[_-]?)(\d+\.\d+\.\d+)', html)
        if versions:
            return sorted(versions, key=lambda v: [int(x) for x in v.split(".")])[-1]
    except Exception:
        pass
    # Fall back: try the IDE update API (may require auth)
    try:
        if os.path.exists(IDE_PRODUCT_JSON):
            with open(IDE_PRODUCT_JSON) as f:
                product = json.load(f)
            commit = product.get("commit", "")
            url = f"{IDE_UPDATE_URL}/api/update/linux-deb-x64/stable/{commit}"
            req = urllib.request.Request(url, headers={"User-Agent": "update-kiro/1.0"})
            with urllib.request.urlopen(req, timeout=15) as resp:
                data = json.loads(resp.read())
            return data.get("productVersion") or data.get("version")
    except Exception:
        pass
    return None


def version_tuple(v):
    return tuple(int(x) for x in v.split("."))


def upgrade_cli(index, latest, arch):
    pkg = get_cli_deb_package(index, latest, arch)
    if not pkg:
        print(f"  No .deb package found for {arch}. Try: kiro-cli update -y")
        return False

    download_url = f"{CLI_INDEX_URL.rsplit('/', 1)[0]}/{pkg['download']}"
    tmp = f"/tmp/kiro-cli-{latest}.deb"
    expected_sha = pkg.get("sha256", "")

    print(f"  Downloading kiro-cli {latest} ...")
    print(f"  URL: {download_url}")
    urllib.request.urlretrieve(download_url, tmp)

    # Verify SHA256
    if expected_sha:
        import hashlib
        sha = hashlib.sha256(open(tmp, "rb").read()).hexdigest()
        if sha != expected_sha:
            print(f"  SHA256 MISMATCH! Expected {expected_sha}, got {sha}")
            os.remove(tmp)
            return False
        print(f"  SHA256 verified: {sha[:16]}...")

    print(f"  Installing ...")
    _, rc = run(f"sudo dpkg -i {tmp}", capture=False)
    os.remove(tmp)
    if rc != 0:
        print("  dpkg install failed. Attempting apt fix ...")
        run("sudo apt-get install -f -y", capture=False)
        return False
    return True


def upgrade_ide():
    """Attempt IDE upgrade. Since the update API is restricted, use kiro-cli update or direct .deb."""
    print("  Attempting IDE update via kiro-cli update ...")
    _, rc = run("kiro-cli update -y", capture=False)
    return rc == 0


def main():
    dry_run = "--dry-run" in sys.argv
    force = "--force" in sys.argv
    arch = get_arch()

    print("=" * 60)
    print("Kiro Update Check")
    print("=" * 60)
    print(f"Platform: linux/{arch}")
    print()

    # --- kiro-cli ---
    cli_installed = get_installed_cli_version()
    print(f"kiro-cli installed: {cli_installed or 'not found'}")

    cli_latest = None
    cli_index = None
    try:
        cli_index = fetch_cli_index()
        cli_latest = get_latest_cli_version(cli_index)
        print(f"kiro-cli latest:    {cli_latest or 'unknown'}")
    except Exception as e:
        print(f"kiro-cli latest:    failed to fetch ({e})")

    cli_needs_update = False
    if cli_installed and cli_latest:
        if version_tuple(cli_installed) < version_tuple(cli_latest):
            cli_needs_update = True
            print(f"kiro-cli status:    UPDATE AVAILABLE ({cli_installed} -> {cli_latest})")
        elif force:
            cli_needs_update = True
            print(f"kiro-cli status:    FORCE reinstall ({cli_installed})")
        else:
            print(f"kiro-cli status:    up to date")

    print()

    # --- Kiro IDE ---
    ide_installed = get_installed_ide_version()
    print(f"Kiro IDE installed: {ide_installed or 'not found'}")

    ide_latest = get_latest_ide_version()
    if ide_latest:
        print(f"Kiro IDE latest:    {ide_latest}")
    else:
        print(f"Kiro IDE latest:    unable to determine (update API restricted)")

    ide_needs_update = False
    if ide_installed and ide_latest:
        if version_tuple(ide_installed) < version_tuple(ide_latest):
            ide_needs_update = True
            print(f"Kiro IDE status:    UPDATE AVAILABLE ({ide_installed} -> {ide_latest})")
        elif force:
            ide_needs_update = True
            print(f"Kiro IDE status:    FORCE reinstall ({ide_installed})")
        else:
            print(f"Kiro IDE status:    up to date")
    elif ide_installed and not ide_latest:
        print(f"Kiro IDE status:    cannot check (try: kiro-cli update -y)")

    print()

    if not cli_needs_update and not ide_needs_update:
        if not force:
            print("Everything is up to date.")
            return 0

    if dry_run:
        print("[DRY RUN] Would upgrade the above components. Run without --dry-run to apply.")
        return 0

    # --- Perform upgrades ---
    exit_code = 0

    if cli_needs_update and cli_index:
        print("-" * 40)
        print(f"Upgrading kiro-cli to {cli_latest} ...")
        if upgrade_cli(cli_index, cli_latest, arch):
            new_ver = get_installed_cli_version()
            print(f"  kiro-cli upgraded to {new_ver}")
        else:
            print("  kiro-cli upgrade failed")
            exit_code = 1

    if ide_needs_update:
        print("-" * 40)
        print(f"Upgrading Kiro IDE ...")
        if upgrade_ide():
            new_ver = get_installed_ide_version()
            print(f"  Kiro IDE upgraded to {new_ver}")
        else:
            print("  Kiro IDE upgrade failed (may need manual update)")
            exit_code = 1

    print()
    print("Done.")
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
