"""Validate and normalize this run's discovery input; probe forge reachability.

Bound inputs (`with:` bindings, canonical text in env):
- INPUTS_DISCOVERY_ARTIFACT: path to a discovery artifact this run can read
  directly (a consolidated discoveries.json or one producer's raw sidecar).
- INPUTS_RUN_ID: accepted for the input contract in issue #3215, but there is
  no callable seam today that turns a bare run id into that run's artifact
  directory from inside a workflow node - see resolve_run_id_only_failure.
  Supplying only run_id is a hard failure naming that exact gap, not a
  guessed path and not a hand-rolled read of the workflow database.

No judgment content lives here: whether a path exists, whether its content
parses as the expected shape, and whether a forge remote is reachable are all
mechanical checks, so this stays a script rather than a command.
"""

import json
import os
import subprocess
import sys

MISSING_SEAM_MESSAGE = (
    "resolve-input: run_id was supplied without discovery_artifact. There is "
    "no callable seam today - no CLI command, HTTP route, or other interface "
    "reachable from inside a workflow node - that turns a bare run id into "
    "that run's artifact directory. The building blocks "
    "(resolveRunStorageRoot, getRunArtifactsDirForRoot) exist only as "
    "internal TypeScript functions inside the CLI/engine process. Supply "
    "discovery_artifact with the path to the artifact directly instead of a "
    "run id."
)


def normalize_entry(raw: object, item_index: int) -> dict:
    """One discovery record, coerced as defensively as outcome.py already reads it.

    The producing prompts write this from prose with no enforced schema
    (review-synthesize.md, the per-lens review commands, implement.md), so a
    JSON-legal record with a missing or wrongly-typed field must normalize
    rather than raise.
    """
    record = raw if isinstance(raw, dict) else {}
    evidence = record.get("evidence")
    evidence_list = [str(e) for e in evidence] if isinstance(evidence, list) else []
    source_nodes = record.get("source_nodes")
    if isinstance(source_nodes, list):
        source_nodes_list = [str(s) for s in source_nodes]
    else:
        single = record.get("source_node")
        source_nodes_list = [str(single)] if single else []
    relation = str(record.get("relation") or "").strip() or "unspecified"
    return {
        "item_index": item_index,
        "title": str(record.get("title") or "").strip() or "(untitled discovery)",
        "claim": str(record.get("claim") or "").strip(),
        "evidence": evidence_list,
        "relation": relation,
        "source_nodes": source_nodes_list,
    }


def load_discoveries(path: str) -> list:
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except OSError as err:
        fail(f"resolve-input: could not read discovery_artifact '{path}' ({err}).")
    except ValueError as err:
        fail(f"resolve-input: discovery_artifact '{path}' is not valid JSON ({err}).")
    if not isinstance(data, list):
        fail(
            f"resolve-input: discovery_artifact '{path}' must contain a JSON array of "
            "discovery records (the shape review-synthesize.md and the per-lens "
            "review commands write); got a different JSON type."
        )
    return [normalize_entry(entry, index) for index, entry in enumerate(data)]


def fail(message: str) -> None:
    print(message, file=sys.stderr)
    sys.exit(1)


def parse_remote(url: str) -> tuple:
    """(host, owner/repo) from a git remote URL, or ("", "") when it does not parse.

    Mirrors the normalization pr.md already does inline for its own gh calls:
    strip credentials and transport syntax, accept https, git@host:, and
    ssh://git@host/ forms, and drop a trailing .git.
    """
    stripped = url.strip()
    if stripped.endswith(".git"):
        stripped = stripped[: -len(".git")]
    if stripped.startswith("https://") or stripped.startswith("http://"):
        rest = stripped.split("://", 1)[1]
        rest = rest.split("@")[-1]  # drop any embedded credentials
        parts = rest.split("/", 1)
    elif stripped.startswith("ssh://"):
        rest = stripped.split("://", 1)[1]
        rest = rest.split("@")[-1]
        parts = rest.split("/", 1)
    elif "@" in stripped and ":" in stripped:
        rest = stripped.split("@", 1)[1]
        parts = rest.split(":", 1)
    else:
        return "", ""
    if len(parts) != 2 or not parts[0] or not parts[1]:
        return "", ""
    return parts[0], parts[1].strip("/")


def probe_forge() -> tuple:
    """(available, host, path). Never raises: an unreachable forge is a normal outcome."""
    try:
        remote = subprocess.run(
            ["git", "remote", "get-url", "origin"],
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False, "", ""
    if remote.returncode != 0:
        return False, "", ""
    host, path = parse_remote(remote.stdout)
    if not host or not path:
        return False, "", ""
    try:
        auth = subprocess.run(
            ["gh", "auth", "status", "--hostname", host],
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False, host, path
    if auth.returncode != 0:
        return False, host, path
    return True, host, path


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8", newline="\n")
    sys.stderr.reconfigure(encoding="utf-8", newline="\n")

    discovery_artifact = os.environ.get("INPUTS_DISCOVERY_ARTIFACT", "").strip()
    run_id = os.environ.get("INPUTS_RUN_ID", "").strip()
    artifacts = os.environ["ARTIFACTS_DIR"]

    if not discovery_artifact and run_id:
        fail(MISSING_SEAM_MESSAGE)
    if not discovery_artifact:
        fail(
            "resolve-input: no input supplied. Set discovery_artifact to the path "
            "of a discovery artifact this run can read (a consolidated "
            "discoveries.json or one producer's raw sidecar)."
        )

    entries = load_discoveries(discovery_artifact)

    out_dir = os.path.join(artifacts, "discoveries")
    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, "normalized.json"), "w", encoding="utf-8", newline="\n") as f:
        json.dump(entries, f, indent=2)

    available, host, path = probe_forge()
    print(
        json.dumps(
            {
                "count": len(entries),
                "forge_available": available,
                "forge_host": host,
                "forge_path": path,
            }
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
