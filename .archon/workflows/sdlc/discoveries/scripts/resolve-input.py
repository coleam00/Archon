"""Normalize discovery sidecars and pin the source and optional GitHub identity."""

import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path, PureWindowsPath
from urllib.parse import urlsplit

TERMINAL_STATUSES = ("completed", "failed", "cancelled")


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
    return records


def normalize(records):
    entries = {}
    for index, record in enumerate(records):
        title, claim = record.get("title"), record.get("claim")
        evidence = record.get("evidence", [])
        # Existing review producers emit either prose or individual evidence strings.
        if isinstance(evidence, str):
            evidence = [evidence]
        sources = record.get("source_nodes", [record["source_node"]] if "source_node" in record else [])
        if (not isinstance(title, str) or not title.strip()
                or not isinstance(claim, str) or not claim.strip()
                or not isinstance(evidence, list) or any(not isinstance(e, str) for e in evidence)
                or not isinstance(sources, list) or any(not isinstance(s, str) for s in sources)):
            fail(f"resolve-input: item {index} needs a title, claim, and string arrays for evidence and sources.")
        # This is exact normalized identity, not semantic deduplication. Evidence
        # preserves case because source paths and command results can be case-sensitive.
        key = json.dumps([" ".join(title.casefold().split()), " ".join(claim.split()),
                          sorted(set(" ".join(e.split()) for e in evidence))], ensure_ascii=False)
        if key in entries:
            previous = entries[key]
            previous["source_nodes"] = sorted(set(previous["source_nodes"] + sources))
            previous["evidence"] = sorted(set(previous["evidence"] + evidence))
            relation = record.get("relation", "unspecified")
            if relation != previous["relation"]:
                fail("resolve-input: duplicate finding has conflicting relations; select an explicit artifact.")
            continue
        entries[key] = {
            "item_index": len(entries), "title": title, "claim": claim, "evidence": evidence,
            "relation": record.get("relation", "unspecified"), "source_nodes": sources,
            "key": key,
        }
    return list(entries.values())


def run_artifacts(run_id):
    if run_id.startswith("-") or any(c.isspace() or ord(c) < 32 for c in run_id):
        fail("resolve-input: invalid run ID.")
    # The engine supplies its exact launch argv. Standalone callers without that
    # context use PATH; incomplete or malformed context must never change owners.
    executable = os.environ.get("ARCHON_EXECUTABLE")
    encoded_args = os.environ.get("ARCHON_EXECUTABLE_ARGS")
    argv = ["archon"]
    if executable is not None or encoded_args is not None:
        try:
            args = json.loads(encoded_args)
            if (not executable or not isinstance(args, list)
                    or any(not isinstance(arg, str) for arg in args)):
                raise ValueError("invalid launch context")
        except (TypeError, ValueError):
            fail("resolve-input: invalid Archon CLI launch context.")
        argv = [executable, *args]
    try:
        result = subprocess.run([*argv, "workflow", "get", run_id, "--json"],
                                capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.TimeoutExpired) as err:
        fail(f"resolve-input: workflow get failed ({type(err).__name__}).")
    if result.returncode != 0:
        fail(f"resolve-input: workflow get failed (exit {result.returncode}).")
    try:
        run = json.loads(result.stdout)
    except ValueError:
        fail("resolve-input: workflow get returned malformed JSON.")
    if not isinstance(run, dict) or run.get("id") != run_id:
        fail("resolve-input: workflow get returned mismatched run provenance.")
    if run.get("status") not in TERMINAL_STATUSES:
        fail("resolve-input: source run must have a terminal status.")
    directory = run.get("artifacts_dir")
    if not isinstance(directory, str) or not Path(directory).is_absolute():
        fail("resolve-input: canonical absolute artifacts_dir is unavailable; update the CLI or supply an artifact.")
    try:
        root = Path(directory).resolve(strict=True)
        if not root.is_dir():
            raise ValueError("not a directory")
        # A returned owned location does not establish existence or readability.
        with os.scandir(root) as children:
            root_names = {child.name for child in children}
    except (OSError, ValueError, RuntimeError) as err:
        fail(f"resolve-input: artifacts_dir is unavailable ({err}).")
    behind = run.get("leave_behind")
    names = behind.get("artifactFiles") if isinstance(behind, dict) else None
    if not isinstance(names, list):
        fail("resolve-input: leave_behind.artifactFiles is unavailable.")
    paths = {}
    for name in names:
        if (not isinstance(name, str) or not name or "\\" in name or ":" in name
                or PureWindowsPath(name).drive or name.startswith("/")
                or any(ord(c) < 32 for c in name)
                or any(p in ("", ".", "..") or p.endswith((" ", "."))
                       or PureWindowsPath(p).is_reserved() for p in name.split("/"))):
            fail("resolve-input: unsafe artifact filename in workflow get response.")
        try:
            path = (root / name).resolve()
            if not path.is_relative_to(root):
                fail("resolve-input: artifact symlink escapes artifacts_dir.")
        except (OSError, ValueError, RuntimeError) as err:
            fail(f"resolve-input: invalid artifact path ({err}).")
        if path in paths.values() or name in paths:
            fail("resolve-input: ambiguous duplicate artifact filename.")
        paths[name] = path
    # Review's empty consolidation is an adjudication, not a missing producer.
    selected = (["discoveries.json"] if "discoveries.json" in paths else sorted(
        name for name in paths if name.startswith("discoveries/")
        and len(name.split("/")) == 2 and name.endswith(".json")))
    # The CLI walk can omit files (its cap or an unreadable subtree). Verify the
    # native discovery inventory, without depending on the CLI's private cap.
    if "discoveries.json" in root_names and "discoveries.json" not in paths:
        fail("resolve-input: canonical discovery missing from artifact listing; supply an explicit artifact.")
    if "discoveries.json" not in selected and "discoveries" in root_names:
        try:
            raw_directory = (root / "discoveries").resolve(strict=True)
            if not raw_directory.is_relative_to(root):
                fail("resolve-input: artifact symlink escapes artifacts_dir.")
            with os.scandir(raw_directory) as children:
                actual = {"discoveries/" + child.name for child in children if child.name.endswith(".json")}
            if actual != set(selected):
                fail("resolve-input: incomplete raw artifact listing; supply an explicit artifact.")
        except (OSError, ValueError, RuntimeError) as err:
            fail(f"resolve-input: raw discovery storage is unavailable ({err}).")
    records = []
    for name in selected:
        records.extend(load_discoveries(paths[name]))
    return records, {"run_id": run_id, "status": run["status"], "artifact_files": selected}


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
    run_id = os.environ.get("INPUTS_RUN_ID", "").strip()
    if bool(artifact) == bool(run_id):
        fail("resolve-input: supply exactly one discovery_artifact or run_id.")
    records, provenance = (run_artifacts(run_id) if run_id else
                           (load_discoveries(artifact), {"artifact": artifact}))
    entries = normalize(records)
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
    context = {"revision": head.stdout.strip(), "forge": forge, "input": provenance}
    with open(os.path.join(out, "context.json"), "w", encoding="utf-8") as f:
        json.dump(context, f, indent=2)
    print(json.dumps({"count": len(entries), "forge_available": forge["available"],
                      "forge_host": forge["host"], "forge_path": forge["path"]}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
