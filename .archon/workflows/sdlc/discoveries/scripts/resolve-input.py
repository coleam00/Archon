"""Normalize discovery sidecars and pin the source and optional GitHub identity."""

import hashlib
import json
import os
import subprocess
import sys
from urllib.parse import urlsplit

MISSING_SEAM_MESSAGE = (
    "resolve-input: run_id resolution is unsupported. "
    "archon workflow get <id> --json exposes output_root and "
    "leave_behind.artifactFiles, but not a canonical absolute artifacts_dir. "
    "Supply discovery_artifact directly; this workflow does not guess storage paths."
)


def fail(message):
    print(message, file=sys.stderr)
    sys.exit(1)


def load_discoveries(path):
    try:
        with open(path, encoding="utf-8") as f:
            records = json.load(f)
    except (OSError, ValueError) as err:
        fail(f"resolve-input: could not read discovery_artifact as JSON ({err}).")
    if not isinstance(records, list) or any(not isinstance(r, dict) for r in records):
        fail("resolve-input: discovery_artifact must be a JSON array of discovery objects.")
    entries = []
    keys = set()
    for index, record in enumerate(records):
        title, claim = record.get("title"), record.get("claim")
        evidence = record.get("evidence", [])
        sources = record.get("source_nodes", [record["source_node"]] if "source_node" in record else [])
        if (not isinstance(title, str) or not title.strip()
                or not isinstance(claim, str) or not claim.strip()
                or not isinstance(evidence, list) or any(not isinstance(e, str) for e in evidence)
                or not isinstance(sources, list) or any(not isinstance(s, str) for s in sources)):
            fail(f"resolve-input: item {index} needs a title, claim, and string arrays for evidence and sources.")
        key = " ".join(title.casefold().split())
        if key in keys:
            fail(f"resolve-input: duplicate discovery key at item {index}; consolidate repeated input first.")
        keys.add(key)
        entries.append({
            "item_index": index, "title": title, "claim": claim, "evidence": evidence,
            "relation": record.get("relation", "unspecified"), "source_nodes": sources,
            "key": key,
        })
    return entries


def probe_forge():
    # Only GitHub.com is identified automatically. Other forges need their owning
    # adapter; an arbitrary host is not evidence that the gh CLI applies to it.
    result = subprocess.run(["git", "remote", "get-url", "origin"], capture_output=True, text=True)
    if result.returncode != 0:
        return {"available": False, "host": "", "path": "", "reason": "no origin configured"}
    remote = result.stdout.strip()
    if remote.startswith("git@github.com:"):
        remote = "https://github.com/" + remote[len("git@github.com:"):]
    try:
        url = urlsplit(remote)
        path = url.path.strip("/").removesuffix(".git")
        parts = path.split("/")
        if (url.hostname != "github.com" or url.scheme not in ("https", "ssh")
                or url.query or url.fragment or url.port is not None
                or len(parts) != 2 or any(not part or part in (".", "..") for part in parts)
                or any(not (c.isalnum() or c in "-_./") for c in path)):
            return {"available": False, "host": "", "path": "", "reason": "origin is not a supported GitHub repository"}
    except ValueError:
        return {"available": False, "host": "", "path": "", "reason": "origin identity is invalid"}
    forge = {"available": False, "host": "github.com", "path": path, "reason": ""}
    try:
        probe = subprocess.run(
            ["gh", "repo", "view", f"github.com/{path}", "--json", "nameWithOwner"],
            capture_output=True, text=True, timeout=15,
        )
    except (OSError, subprocess.TimeoutExpired) as err:
        forge["reason"] = f"GitHub CLI unavailable ({type(err).__name__})"
        return forge
    if probe.returncode != 0:
        forge["reason"] = f"GitHub repository read failed (exit {probe.returncode})"
        return forge
    try:
        identity = json.loads(probe.stdout)["nameWithOwner"]
    except (ValueError, KeyError, TypeError):
        fail("resolve-input: GitHub repository probe returned malformed identity.")
    if not isinstance(identity, str) or identity.casefold() != path.casefold():
        fail("resolve-input: GitHub repository probe returned a different identity.")
    forge["available"] = True
    return forge


def main():
    sys.stdout.reconfigure(encoding="utf-8", newline="\n")
    sys.stderr.reconfigure(encoding="utf-8", newline="\n")
    artifact = os.environ.get("INPUTS_DISCOVERY_ARTIFACT", "").strip()
    if os.environ.get("INPUTS_RUN_ID", "").strip():
        fail(MISSING_SEAM_MESSAGE)
    if not artifact:
        fail("resolve-input: supply discovery_artifact.")
    entries = load_discoveries(artifact)
    head = subprocess.run(["git", "rev-parse", "--verify", "HEAD"], capture_output=True, text=True)
    if head.returncode != 0:
        fail("resolve-input: current repository has no readable HEAD.")
    forge = probe_forge()
    identity = f"{forge['host']}/{forge['path']}".casefold() if forge["host"] else None
    for entry in entries:
        entry["marker"] = (
            hashlib.sha256(f"{identity}:{entry.pop('key')}".encode()).hexdigest()
            if identity else None
        )
        entry.pop("key", None)
    out = os.path.join(os.environ["ARTIFACTS_DIR"], "discoveries")
    os.makedirs(out, exist_ok=True)
    with open(os.path.join(out, "normalized.json"), "w", encoding="utf-8") as f:
        json.dump(entries, f, indent=2)
    context = {"revision": head.stdout.strip(), "forge": forge}
    with open(os.path.join(out, "context.json"), "w", encoding="utf-8") as f:
        json.dump(context, f, indent=2)
    print(json.dumps({"count": len(entries), "forge_available": forge["available"],
                      "forge_host": forge["host"], "forge_path": forge["path"]}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
