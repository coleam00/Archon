"""Shared config loader for git-dev-workflow scripts"""

import json
import subprocess
from pathlib import Path

DEFAULT_CONFIG = {
    "default_branch": "main",
    "sync_strategy": "rebase"
}

def run_git(cmd):
    """Run git command"""
    result = subprocess.run(f"git {cmd}", shell=True, capture_output=True, text=True)
    return result.returncode, result.stdout.strip(), result.stderr.strip()

def get_remote_for_branch(branch=None):
    """Get the remote that tracks the given branch (or current branch).
    
    If the branch tracks a URL instead of a remote name (legacy config),
    resolves it to the correct remote name and repairs the branch config.
    """
    if not branch:
        _, branch, _ = run_git("rev-parse --abbrev-ref HEAD")

    code, remote, _ = run_git(f"config --get branch.{branch}.remote")
    if code == 0 and remote:
        if "://" not in remote:
            return remote
        # Legacy: branch tracks a URL instead of a remote name
        resolved = _resolve_remote_name(remote)
        if resolved:
            print(f"⚠️  Branch '{branch}' tracks a URL instead of remote name — repairing to '{resolved}'")
            run_git(f"config branch.{branch}.remote {resolved}")
            return resolved

    code, remotes, _ = run_git("remote")
    if "origin" in remotes.split("\n"):
        return "origin"
    if remotes:
        return remotes.split("\n")[0]
    return "origin"

def detect_provider(remote_name=None, provider_override=None):
    """Detect git provider from remote URL. Returns (provider, metadata).
    
    Providers: codecommit, gitlab, github, bitbucket, unknown
    Metadata always includes 'url'. CodeCommit adds 'profile', 'repo_name', 'region'.
    If provider_override is set, skips auto-detection and uses that provider.
    """
    if not remote_name:
        remote_name = get_remote_for_branch()

    code, remote_url, _ = run_git(f"remote get-url {remote_name}")
    if code != 0:
        return provider_override or "unknown", {"url": ""}

    if provider_override:
        return provider_override, {"url": remote_url}

    url = remote_url.lower()
    meta = {"url": remote_url}

    if "codecommit::" in url or "git-codecommit" in url:
        if "codecommit::" in url:
            try:
                after_slashes = remote_url.split("://", 1)[1]
                if "://" in after_slashes:
                    after_slashes = after_slashes.split("://", 1)[1]
                if "@" in after_slashes:
                    meta["profile"] = after_slashes.split("@")[0]
                    meta["repo_name"] = after_slashes.split("@")[1]
                else:
                    meta["repo_name"] = after_slashes
            except (IndexError, ValueError):
                pass
            try:
                meta["region"] = url.split("codecommit::")[1].split("://")[0]
            except (IndexError, ValueError):
                meta["region"] = None
        elif "git-codecommit" in url:
            try:
                meta["region"] = url.split("git-codecommit.")[1].split(".")[0]
                meta["repo_name"] = url.rstrip("/").rsplit("/", 1)[-1]
            except (IndexError, ValueError):
                pass
        return "codecommit", meta

    if "github.com" in url:
        return "github", meta
    if "gitlab" in url:
        return "gitlab", meta
    if "bitbucket" in url:
        return "bitbucket", meta

    # Check credentials file for self-hosted GitLab instances
    if remote_url.startswith("https://"):
        host = remote_url.replace("https://", "").split("/")[0]
        base_url = f"https://{host}"
        creds = load_credentials()
        if base_url in creds:
            # Credentials file exists for this host — check if token looks like GitLab
            token = creds[base_url].get("token", "")
            if token.startswith("glpat-"):
                return "gitlab", meta

    return "unknown", meta

def load_credentials():
    """Load git credentials from configured backend."""
    from credential_manager import get_backend
    config = _read_project_yaml()
    creds_config = config.get("credentials", {})
    backend = get_backend(creds_config)
    return backend.load()

def get_authenticated_remote(remote_name=None):
    """Get remote name for authenticated operations.
    
    - CodeCommit: returns remote name (credential helper handles auth via protocol)
    - HTTPS with stored credentials: returns remote name (callers should use push_with_credentials)
    - Others: returns remote name (relies on git credential store)
    
    Note: Tokens are never embedded in URLs. Use push_with_credentials() for push operations.
    """
    if not remote_name:
        remote_name = get_remote_for_branch()
    return remote_name

def _read_project_yaml():
    """Read git-remote config from project's .kiro/config/project.yaml"""
    code, git_root, _ = run_git("rev-parse --show-toplevel")
    if code != 0:
        return {}
    p = Path(git_root) / ".kiro" / "config" / "project.yaml"
    if not p.exists():
        return {}
    try:
        data = {}
        in_section = None
        for line in p.read_text().splitlines():
            stripped = line.strip()
            if stripped.startswith("git-remote:"):
                in_section = "git-remote"
                continue
            if stripped.startswith("credentials:") and in_section == "git-remote":
                in_section = "credentials"
                continue
            if in_section and not line.startswith(" ") and not line.startswith("\t"):
                break
            if in_section == "credentials" and ":" in stripped:
                indent = len(line) - len(line.lstrip())
                if indent >= 4:
                    k, v = stripped.split(":", 1)
                    v = v.strip().strip('"').strip("'")
                    if v and not v.startswith("#"):
                        data.setdefault("credentials", {})[k.strip()] = v.split("#")[0].strip()
                    continue
            if in_section == "git-remote" and ":" in stripped:
                k, v = stripped.split(":", 1)
                v = v.strip().strip('"').strip("'")
                if v and not v.startswith("#"):
                    data[k.strip()] = v.split("#")[0].strip()
        return data
    except Exception:
        return {}


def ensure_project_yaml_remote():
    """Detect git remote info and write git-remote section to project.yaml if missing.
    
    Returns the detected config dict, or {} if nothing was written.
    """
    proj = _read_project_yaml()
    if proj.get("name"):
        return proj  # already configured

    code, git_root, _ = run_git("rev-parse --show-toplevel")
    if code != 0:
        return {}
    p = Path(git_root) / ".kiro" / "config" / "project.yaml"

    # Detect remote and provider
    remote_name = get_remote_for_branch()
    provider, meta = detect_provider(remote_name)
    code, _, _ = run_git(f"symbolic-ref refs/remotes/{remote_name}/HEAD")
    default_branch = "main"
    for candidate in ("main", "master"):
        c, _, _ = run_git(f"rev-parse --verify {remote_name}/{candidate}")
        if c == 0:
            default_branch = candidate
            break

    block = (
        f"\ngit-remote:\n"
        f"  name: {remote_name}              # preferred remote name\n"
        f"  provider: {provider}      # {' | '.join(['codecommit', 'gitlab', 'github', 'bitbucket'])}\n"
        f"  default-branch: {default_branch}      # target branch for MR/PR\n"
    )

    if p.exists():
        content = p.read_text()
        if "git-remote:" in content:
            return proj  # section exists but name might be missing — don't overwrite
        content = content.rstrip("\n") + "\n" + block
    else:
        p.parent.mkdir(parents=True, exist_ok=True)
        content = "# Project-level GDIT Framework settings (checked into version control)\n" + block

    p.write_text(content)
    print(f"✅ Auto-configured git-remote in project.yaml (remote: {remote_name}, provider: {provider}, branch: {default_branch})")
    return {"name": remote_name, "provider": provider, "default-branch": default_branch}


def load_config(remote_override=None):
    """Load config, merging CLI override > project.yaml > skill config > auto-detect"""
    config_path = Path(__file__).parent.parent / "config" / "config.json"
    try:
        with open(config_path) as f:
            file_config = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        file_config = {}

    config = {**DEFAULT_CONFIG, **file_config}

    proj = _read_project_yaml()
    if proj.get("default-branch"):
        config["default_branch"] = proj["default-branch"]
    if proj.get("provider"):
        config["provider_override"] = proj["provider"]

    if remote_override:
        resolved = _resolve_remote_name(remote_override)
        config["remote_name"] = resolved or get_remote_for_branch()
    elif proj.get("name"):
        resolved = _resolve_remote_name(proj["name"])
        config["remote_name"] = resolved or get_remote_for_branch()
    elif "remote_name" not in file_config:
        config["remote_name"] = get_remote_for_branch()

    return config


def _resolve_remote_name(value):
    """If value is a URL, find the git remote that uses it. Returns name or None."""
    if "://" not in value:
        return value
    code, remotes, _ = run_git("remote")
    if code != 0 or not remotes:
        return None
    norm_value = _strip_url_credentials(value)
    for name in remotes.splitlines():
        _, url, _ = run_git(f"remote get-url {name}")
        if _strip_url_credentials(url) == norm_value:
            return name
    return None


def _strip_url_credentials(url):
    """Remove user:pass@ from an HTTPS URL for comparison."""
    if not url.startswith("https://"):
        return url
    if "@" in url:
        rest = url.split("://", 1)[1].split("@", 1)[-1]
        return f"https://{rest}"
    return url
