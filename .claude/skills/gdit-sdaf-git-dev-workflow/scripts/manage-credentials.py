#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""Manage git credentials for the git-dev-workflow skill."""

import argparse
import subprocess
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent
sys.path.insert(0, str(SCRIPT_DIR))

from credential_manager import get_backend, test_credentials, git_with_credentials
from skill_config import _read_project_yaml, run_git


def _get_backend_from_args(args):
    config = _read_project_yaml()
    creds_config = dict(config.get("credentials", {}))
    if hasattr(args, "backend") and args.backend:
        creds_config["backend"] = args.backend
    return get_backend(creds_config)


def _parse_host(url):
    """Extract hostname from a URL."""
    return url.replace("https://", "").replace("http://", "").split("/")[0]


def _sync_to_git_credential_store(url, username, token):
    """Write credentials to git's native store so direct git commands authenticate."""
    host = _parse_host(url)

    # Check existing credential helper
    r = subprocess.run(["git", "config", "--global", "credential.helper"],
                       capture_output=True, text=True)
    helper = r.stdout.strip() if r.returncode == 0 else ""

    if helper and helper != "store":
        # User has a custom helper (osxkeychain, manager-core, etc.)
        # Use `git credential approve` to write through their configured helper
        credential_input = f"protocol=https\nhost={host}\nusername={username}\npassword={token}\n\n"
        subprocess.run(["git", "credential", "approve"],
                       input=credential_input, capture_output=True, text=True)
    else:
        # No helper or already using 'store' — configure store and write directly
        if not helper:
            subprocess.run(["git", "config", "--global", "credential.helper", "store"],
                           capture_output=True, text=True)
        _write_git_credentials_file(host, username, token)


def _write_git_credentials_file(host, username, token):
    """Write entry to ~/.git-credentials in git's native format."""
    from urllib.parse import quote
    cred_file = Path.home() / ".git-credentials"
    entry = f"https://{quote(username, safe='')}:{quote(token, safe='')}@{host}"

    # Read existing, replace matching host or append
    lines = cred_file.read_text().splitlines() if cred_file.exists() else []
    new_lines = [line for line in lines if host not in line]
    new_lines.append(entry)

    cred_file.write_text("\n".join(new_lines) + "\n")
    cred_file.chmod(0o600)


def _remove_from_git_credentials(url):
    """Remove matching entry from ~/.git-credentials."""
    host = _parse_host(url)
    cred_file = Path.home() / ".git-credentials"
    if not cred_file.exists():
        return
    lines = cred_file.read_text().splitlines()
    new_lines = [line for line in lines if host not in line]
    if len(new_lines) != len(lines):
        cred_file.write_text("\n".join(new_lines) + "\n" if new_lines else "")
        cred_file.chmod(0o600)


def _check_codecommit_setup(url):
    """Handle CodeCommit remote setup — verify AWS profile and GRC helper."""
    # Parse profile from codecommit:: URL
    profile = None
    try:
        after = url.split("://", 1)[1]
        if "://" in after:
            after = after.split("://", 1)[1]
        if "@" in after:
            profile = after.split("@")[0]
    except (IndexError, ValueError):
        pass

    print(f"CodeCommit remote detected: {url}")
    print(f"AWS profile: {profile or 'default'}\n")

    # Check AWS profile
    cmd = ["aws", "sts", "get-caller-identity"]
    if profile:
        cmd += ["--profile", profile]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode == 0:
        import json as _json
        try:
            arn = _json.loads(r.stdout).get("Arn", "unknown")
            print(f"✅ AWS profile valid — {arn}")
        except Exception:
            print("✅ AWS profile valid")
    else:
        print(f"❌ AWS profile failed: {r.stderr.strip()}")
        print(f"  Run: aws configure{' --profile ' + profile if profile else ''}")
        return

    # Check git-remote-codecommit
    r = subprocess.run(["pip3", "show", "git-remote-codecommit"], capture_output=True, text=True)
    if r.returncode == 0:
        print("✅ git-remote-codecommit installed")
    else:
        print("⚠️  git-remote-codecommit not installed")
        print("  Install: pip install git-remote-codecommit")

    print("\nCodeCommit uses IAM auth via the AWS profile — no token storage needed.")


def _write_credentials_config(creds_config):
    """Write git-remote.credentials section to .kiro/config/project.yaml."""
    _, git_root, _ = run_git("rev-parse --show-toplevel")
    if not git_root:
        print("⚠️  Not in a git repo — cannot write project.yaml", file=sys.stderr)
        return
    p = Path(git_root) / ".kiro" / "config" / "project.yaml"
    if not p.exists():
        print(f"⚠️  {p} not found — create it first via project configuration", file=sys.stderr)
        return

    content = p.read_text()
    # Build the credentials YAML block
    lines = ["  credentials:"]
    for k, v in creds_config.items():
        lines.append(f"    {k}: {v}")
    creds_block = "\n".join(lines)

    # If credentials section already exists, replace it
    if "  credentials:" in content:
        import re
        content = re.sub(
            r"  credentials:\n(?:    .+\n)*",
            creds_block + "\n",
            content
        )
    elif "git-remote:" in content:
        # Append after the last line of git-remote section
        git_remote_lines = []
        result_lines = []
        in_section = False
        inserted = False
        for line in content.splitlines():
            result_lines.append(line)
            if line.startswith("git-remote:"):
                in_section = True
            elif in_section and not line.startswith(" ") and not line.startswith("\t") and line.strip():
                # Left the section — insert before this line
                result_lines.insert(-1, creds_block)
                in_section = False
                inserted = True
        if in_section and not inserted:
            result_lines.append(creds_block)
        content = "\n".join(result_lines)
    else:
        content += f"\ngit-remote:\n{creds_block}\n"

    p.write_text(content)
    print(f"✅ Credentials config written to {p}")


def cmd_setup(args):
    _, url, _ = run_git("remote get-url origin")

    # Secrets Manager backend: collect AWS config and persist to project.yaml
    backend_choice = getattr(args, "backend", None)
    if backend_choice == "secrets-manager":
        # Auto-detect profile and region from CodeCommit remote if available
        detected_profile = None
        detected_region = None
        if url and "codecommit::" in url.lower():
            try:
                detected_region = url.lower().split("codecommit::")[1].split("://")[0]
                after = url.split("://", 1)[1]
                if "://" in after:
                    after = after.split("://", 1)[1]
                if "@" in after:
                    detected_profile = after.split("@")[0]
            except (IndexError, ValueError):
                pass

        profile = getattr(args, "profile", None) or detected_profile
        region = getattr(args, "region", None) or detected_region or "us-east-1"
        secret_name = getattr(args, "secret_name", None) or "gdit-sdaf/git-credentials"

        creds_config = {"backend": "secrets-manager", "secret-name": secret_name, "region": region}
        if profile:
            creds_config["profile"] = profile
        _write_credentials_config(creds_config)

    # Local backend with custom path: persist
    elif backend_choice == "local" and getattr(args, "path", None):
        _write_credentials_config({"backend": "local", "path": args.path})

    # CodeCommit: verify AWS profile + GRC, skip token prompts
    if url and ("codecommit::" in url.lower() or "git-codecommit" in url.lower()) and not backend_choice:
        _check_codecommit_setup(url)
        return

    # HTTPS remotes: store username/token
    if url and url.startswith("https://"):
        host = url.replace("https://", "").split("/")[0]
        base_url = f"https://{host}"
    else:
        base_url = getattr(args, "url", None)
        if not base_url:
            print("❌ --url required (no HTTPS remote detected)")
            sys.exit(1)

    print(f"Configuring credentials for {base_url}")
    username = getattr(args, "username", None)
    token = getattr(args, "token", None)
    if not username or not token:
        print("❌ --username and --token are required")
        sys.exit(1)

    backend = _get_backend_from_args(args)
    backend.set(base_url, {"username": username, "token": token})
    _sync_to_git_credential_store(base_url, username, token)
    print(f"✅ Credentials stored for {base_url}")

    ok, msg = test_credentials(base_url, {"username": username, "token": token})
    print(f"{'✅' if ok else '❌'} Test: {msg}")


def cmd_list(args):
    backend = _get_backend_from_args(args)
    data = backend.load()
    if not data:
        print("No credentials stored")
        return
    for url, creds in data.items():
        username = creds.get("username", "?")
        provider = creds.get("provider", "")
        print(f"  {url}  user={username}  provider={provider or 'auto'}")


def cmd_get(args):
    backend = _get_backend_from_args(args)
    creds = backend.get(args.url)
    if not creds:
        print(f"No credentials for {args.url}")
        sys.exit(1)
    print(f"  url:      {args.url}")
    print(f"  username: {creds.get('username', '?')}")
    print(f"  token:    ****")
    print(f"  provider: {creds.get('provider', 'auto')}")


def cmd_set(args):
    backend = _get_backend_from_args(args)
    creds = {"username": args.username, "token": args.token}
    if args.provider:
        creds["provider"] = args.provider
    backend.set(args.url, creds)
    _sync_to_git_credential_store(args.url, args.username, args.token)
    print(f"✅ Credentials stored for {args.url}")


def cmd_delete(args):
    backend = _get_backend_from_args(args)
    backend.delete(args.url)
    _remove_from_git_credentials(args.url)
    print(f"✅ Credentials deleted for {args.url}")


def cmd_test(args):
    backend = _get_backend_from_args(args)
    creds = backend.get(args.url)
    if not creds:
        print(f"❌ No credentials stored for {args.url}")
        sys.exit(1)
    # Test 1: Provider API validation
    ok, msg = test_credentials(args.url, creds)
    print(f"{'✅' if ok else '❌'} API test: {msg}")
    # Test 2: Git authentication (ls-remote)
    code, out, err = git_with_credentials(["ls-remote", args.url], creds)
    git_ok = code == 0
    print(f"{'✅' if git_ok else '❌'} Git test: {'git ls-remote succeeded' if git_ok else 'git ls-remote failed — ' + err}")
    sys.exit(0 if (ok and git_ok) else 1)


def cmd_migrate(args):
    src_backend = get_backend({"backend": getattr(args, "from")})
    dst_backend = get_backend({"backend": args.to})
    data = src_backend.load()
    if not data:
        print("No credentials to migrate")
        return
    existing = dst_backend.load()
    existing.update(data)
    dst_backend.save(existing)
    print(f"✅ Migrated {len(data)} credential(s) from {getattr(args, 'from')} to {args.to}")


def main():
    parser = argparse.ArgumentParser(description="Manage git credentials")
    parser.add_argument("--backend", help="Override backend (local|secrets-manager)")
    sub = parser.add_subparsers(dest="command", required=True)

    p_setup = sub.add_parser("setup", help="Guided first-run setup")
    p_setup.add_argument("--username", help="Username (non-interactive)")
    p_setup.add_argument("--token", help="Token (non-interactive)")
    p_setup.add_argument("--url", dest="url", help="Remote URL override (non-interactive)")
    p_setup.add_argument("--profile", help="AWS profile (secrets-manager backend)")
    p_setup.add_argument("--region", help="AWS region (secrets-manager backend)")
    p_setup.add_argument("--secret-name", dest="secret_name", help="Secret name (secrets-manager backend)")
    p_setup.add_argument("--path", help="Credential file path (local backend)")
    sub.add_parser("list", help="List stored credentials")

    p_get = sub.add_parser("get", help="Get credentials for URL")
    p_get.add_argument("url")

    p_set = sub.add_parser("set", help="Store credentials")
    p_set.add_argument("url")
    p_set.add_argument("--username", required=True)
    p_set.add_argument("--token", required=True)
    p_set.add_argument("--provider", help="gitlab|github|bitbucket")

    p_del = sub.add_parser("delete", help="Delete credentials")
    p_del.add_argument("url")

    p_test = sub.add_parser("test", help="Validate credentials")
    p_test.add_argument("url")

    p_mig = sub.add_parser("migrate", help="Copy credentials between backends")
    p_mig.add_argument("--from", required=True, dest="from_backend")
    p_mig.add_argument("--to", required=True)

    args = parser.parse_args()
    # Fix migrate's --from attribute name
    if args.command == "migrate":
        setattr(args, "from", args.from_backend)

    {"setup": cmd_setup, "list": cmd_list, "get": cmd_get, "set": cmd_set,
     "delete": cmd_delete, "test": cmd_test, "migrate": cmd_migrate}[args.command](args)


if __name__ == "__main__":
    main()
