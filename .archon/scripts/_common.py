"""Shared helpers for the Archon video pack scripts.

Named Archon script nodes execute as `uv run <path>`, so the script's own
directory is on sys.path and this module imports cleanly from siblings.
(Inline `script: |` nodes run via `python -c` and could NOT import this.)

Node-to-node data moves through files under the run's work directory rather
than through `$nodeId.output`: named scripts don't get output substitution,
and the payloads here are media files anyway.
"""

from __future__ import annotations

import json
import os
import pathlib
import subprocess
import sys

# .archon/scripts/_common.py -> parents[2] is the project root
ROOT = pathlib.Path(__file__).resolve().parents[2]


def log(msg: str) -> None:
    """Progress goes to stderr; stdout is the node's captured output."""
    print(msg, file=sys.stderr, flush=True)


def load_env() -> dict[str, str]:
    """Read .env from the project root, letting the real environment win.

    Archon injects managed per-project env vars into script subprocesses, so
    once this project is registered the .env file becomes a local-dev
    convenience rather than the source of truth.
    """
    env: dict[str, str] = {}
    f = ROOT / ".env"
    if f.exists():
        for line in f.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip()
    for k in list(env):
        if os.environ.get(k):
            env[k] = os.environ[k]
    return env


def require_key(env: dict[str, str], name: str) -> str:
    val = env.get(name) or os.environ.get(name, "")
    if not val:
        raise SystemExit(f"{name} is not set (add it to {ROOT / '.env'})")
    return val


def work_dir() -> pathlib.Path:
    """The run's working directory.

    Inside Archon this is $ARTIFACTS_DIR (pre-created by the executor, and
    outside the repo so nothing lands in git status). Standalone runs fall
    back to ./work/local so the scripts stay testable without the engine.
    """
    d = os.environ.get("ARTIFACTS_DIR") or str(ROOT / "work" / "local")
    p = pathlib.Path(d)
    p.mkdir(parents=True, exist_ok=True)
    return p


def read_json(name: str) -> dict:
    p = work_dir() / name
    if not p.exists():
        raise SystemExit(f"missing {p} — an upstream node did not produce it")
    return json.loads(p.read_text())


def write_json(name: str, data: object) -> pathlib.Path:
    p = work_dir() / name
    p.write_text(json.dumps(data, indent=2))
    return p


def run(cmd: list[str], quiet: bool = False) -> str:
    """Run a subprocess, failing loudly with the tail of stderr."""
    if not quiet:
        log(f"$ {cmd[0]} {' '.join(cmd[1:4])} …")
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        log(r.stderr[-3000:])
        raise SystemExit(f"{cmd[0]} failed with exit {r.returncode}")
    return r.stdout


def probe(path: pathlib.Path) -> dict:
    """ffprobe a media file into a dict."""
    out = run(
        [
            "ffprobe", "-v", "error", "-print_format", "json",
            "-show_format", "-show_streams", str(path),
        ],
        quiet=True,
    )
    return json.loads(out)


def media_duration(path: pathlib.Path) -> float:
    return float(probe(path)["format"]["duration"])
