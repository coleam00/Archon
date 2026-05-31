"""Credential manager with pluggable backends for git-dev-workflow skill."""

import json
import os
import stat
import subprocess
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent
SKILL_DIR = SCRIPT_DIR.parent
DEFAULT_CRED_PATH = Path.home() / ".gdit-sdaf-secrets" / "git-credentials.json"
LEGACY_PATHS = [
    SKILL_DIR / "config" / "credentials.json",
]


def _run(cmd, **kwargs):
    return subprocess.run(cmd, capture_output=True, text=True, **kwargs)


def mask_tokens(text, creds):
    """Replace any token values in text with '****'."""
    if not text or not creds:
        return text
    for entry in creds.values() if isinstance(creds, dict) else []:
        token = entry.get("token", "") if isinstance(entry, dict) else ""
        if token and token in text:
            text = text.replace(token, "****")
    return text


def git_with_credentials(args, creds):
    """Run any git command with credential helper injection. Returns (code, stdout, stderr)."""
    if not creds or not creds.get("username") or not creds.get("token"):
        result = _run(["git"] + args)
        return result.returncode, result.stdout.strip(), result.stderr.strip()
    helper = f"!f() {{ echo username={creds['username']}; echo password={creds['token']}; }}; f"
    result = _run(["git", "-c", f"credential.helper={helper}"] + args)
    out = mask_tokens(result.stdout.strip(), {"_": creds})
    err = mask_tokens(result.stderr.strip(), {"_": creds})
    return result.returncode, out, err


def push_with_credentials(remote, branch, creds):
    """Push using git credential helper — token never in URL or process table."""
    if not creds or not creds.get("username") or not creds.get("token"):
        result = _run(f"git push -u {remote} {branch}", shell=True)
        return result.returncode, result.stdout.strip(), result.stderr.strip()

    username = creds["username"]
    token = creds["token"]
    helper = f"!f() {{ echo username={username}; echo password={token}; }}; f"
    result = _run(
        ["git", "-c", f"credential.helper={helper}", "push", "-u", remote, branch]
    )
    out = mask_tokens(result.stdout.strip(), {"_": creds})
    err = mask_tokens(result.stderr.strip(), {"_": creds})
    return result.returncode, out, err


def _detect_provider_from_url(url):
    u = url.lower()
    if "gitlab" in u:
        return "gitlab"
    if "github.com" in u:
        return "github"
    if "bitbucket" in u:
        return "bitbucket"
    return "unknown"


def test_credentials(url, creds):
    """Validate credentials against provider API. Returns (ok, message)."""
    provider = creds.get("provider") or _detect_provider_from_url(url)
    token = creds.get("token", "")
    username = creds.get("username", "")
    host = url.replace("https://", "").split("/")[0]

    # If provider unknown but token looks like GitLab PAT, treat as GitLab
    if provider == "unknown" and token.startswith("glpat-"):
        provider = "gitlab"

    if provider == "gitlab":
        r = _run(["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}",
                   "-H", f"PRIVATE-TOKEN: {token}", f"https://{host}/api/v4/user"])
    elif provider == "github":
        r = _run(["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}",
                   "-H", f"Authorization: token {token}", "https://api.github.com/user"])
    elif provider == "bitbucket":
        r = _run(["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}",
                   "-u", f"{username}:{token}", "https://api.bitbucket.org/2.0/user"])
    else:
        # Unknown provider: try GitLab API first (most common self-hosted), fall back to ls-remote
        r = _run(["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}",
                   "-H", f"PRIVATE-TOKEN: {token}", f"https://{host}/api/v4/user"])
        if r.stdout.strip() == "200":
            return True, "credentials valid (detected as GitLab)"
        # Fall back to git ls-remote with a repo URL if available
        helper = f"!f() {{ echo username={username}; echo password={token}; }}; f"
        r = _run(["git", "-c", f"credential.helper={helper}", "ls-remote", url])
        return (r.returncode == 0, "credentials valid" if r.returncode == 0 else "ls-remote failed")

    code = r.stdout.strip()
    if code == "200":
        return True, "credentials valid"
    if code in ("401", "403"):
        return False, f"authentication failed (HTTP {code})"
    return False, f"unexpected response (HTTP {code})"


class LocalFileBackend:
    def __init__(self, config):
        self._path = Path(config.get("path", str(DEFAULT_CRED_PATH))).expanduser()
        self._legacy_paths = list(LEGACY_PATHS)
        # Add project-relative legacy path
        r = _run("git rev-parse --show-toplevel", shell=True)
        if r.returncode == 0:
            self._legacy_paths.append(
                Path(r.stdout.strip()).parent / ".gdit-sdaf-secrets" / "gitlab-tokens.json"
            )

    def _resolve_path(self):
        if self._path.exists():
            return self._path, False
        for p in self._legacy_paths:
            if p.exists():
                print(f"⚠️  Using legacy credential file {p} — consider migrating to {DEFAULT_CRED_PATH}", file=sys.stderr)
                return p, True
        return self._path, False

    def load(self):
        path, _ = self._resolve_path()
        if not path.exists():
            return {}
        try:
            return json.loads(path.read_text())
        except (json.JSONDecodeError, OSError):
            return {}

    def save(self, data):
        self._path.parent.mkdir(parents=True, exist_ok=True)
        os.chmod(str(self._path.parent), stat.S_IRWXU)  # 700
        self._path.write_text(json.dumps(data, indent=2) + "\n")
        os.chmod(str(self._path), stat.S_IRUSR | stat.S_IWUSR)  # 600

    def get(self, url):
        return self.load().get(url)

    def set(self, url, creds):
        data = self.load()
        data[url] = creds
        self.save(data)

    def delete(self, url):
        data = self.load()
        data.pop(url, None)
        self.save(data)

    def test(self, url):
        creds = self.get(url)
        if not creds:
            return False, f"no credentials stored for {url}"
        return test_credentials(url, creds)


class SecretsManagerBackend:
    def __init__(self, config):
        self._secret_name = config.get("secret-name", "gdit-sdaf/git-credentials")
        self._region = config.get("region")
        self._profile = config.get("profile")

    def _aws_cmd(self, *args):
        cmd = ["aws", "secretsmanager"] + list(args)
        if self._region:
            cmd += ["--region", self._region]
        if self._profile:
            cmd += ["--profile", self._profile]
        return cmd

    def load(self):
        r = _run(self._aws_cmd("get-secret-value", "--secret-id", self._secret_name))
        if r.returncode != 0:
            if "ResourceNotFoundException" in r.stderr:
                return {}
            print(f"⚠️  Secrets Manager error: {r.stderr.strip()}", file=sys.stderr)
            return {}
        try:
            return json.loads(json.loads(r.stdout)["SecretString"])
        except (json.JSONDecodeError, KeyError):
            return {}

    def save(self, data):
        secret_str = json.dumps(data)
        # Try update first
        r = _run(self._aws_cmd("put-secret-value", "--secret-id", self._secret_name,
                                "--secret-string", secret_str))
        if r.returncode != 0 and "ResourceNotFoundException" in r.stderr:
            # Create new secret
            r = _run(self._aws_cmd("create-secret", "--name", self._secret_name,
                                    "--secret-string", secret_str,
                                    "--tags", "Key=gdit-sdaf:managed,Value=true"))
            if r.returncode != 0:
                print(f"❌ Failed to create secret: {r.stderr.strip()}", file=sys.stderr)

    def get(self, url):
        return self.load().get(url)

    def set(self, url, creds):
        data = self.load()
        data[url] = creds
        self.save(data)

    def delete(self, url):
        data = self.load()
        data.pop(url, None)
        self.save(data)

    def test(self, url):
        creds = self.get(url)
        if not creds:
            return False, f"no credentials stored for {url}"
        return test_credentials(url, creds)


def get_backend(config):
    """Factory: return the configured backend instance."""
    backend = config.get("backend", "local")
    if backend == "secrets-manager":
        return SecretsManagerBackend(config)
    return LocalFileBackend(config)
