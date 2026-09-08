"""Exercise real discovery scripts and git; simulate only CLI transports."""

import contextlib
import io
import json
import os
from pathlib import Path
import runpy
import subprocess
import sys
from unittest.mock import patch

request = json.load(sys.stdin)
root, scripts = Path(sys.argv[1]), Path(sys.argv[2])
repo, artifacts = root / "repo", root / "artifacts"
repo.mkdir()
artifacts.mkdir()
real_run = subprocess.run


def git(*args):
    result = real_run(["git", *args], cwd=repo, capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError(result.stderr)
    return result.stdout.strip()


git("init", "-q")
git("config", "user.name", "Fixture")
git("config", "user.email", "fixture@example.invalid")
(repo / "AGENTS.md").write_text("Fixture source only.\nSecond line.\n", encoding="utf-8")
(repo / "folder").mkdir()
(repo / "folder" / "source.txt").write_text("source\n", encoding="utf-8")
git("add", ".")
git("-c", "core.hooksPath=", "commit", "-qm", "fixture source")
if request.get("remote"):
    git("remote", "add", "origin", request["remote"])
original_head = git("rev-parse", "HEAD")
source = root / "input.json"
source.write_text(json.dumps(request.get("records", [])), encoding="utf-8")
source_artifacts = root / "source artifacts"
source_artifacts.mkdir()
for name, value in request.get("artifact_files", {}).items():
    path = source_artifacts / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding="utf-8")
if request.get("symlink_escape"):
    outside = root / "outside"
    outside.mkdir()
    (outside / "regress.json").write_text(json.dumps(request["records"]), encoding="utf-8")
    link = source_artifacts / "discoveries"
    if os.name == "nt":
        # Directory junctions exercise real resolve() escapes without symlink privilege.
        result = real_run(["cmd", "/c", "mklink", "/J", str(link), str(outside)], capture_output=True)
        if result.returncode:
            raise RuntimeError("Could not create scratch junction")
    else:
        link.symlink_to(outside, target_is_directory=True)
if "raw" in request:
    source.write_text(request["raw"], encoding="utf-8")
os.chdir(repo)
os.environ.update({
    "ARTIFACTS_DIR": str(artifacts),
    "INPUTS_DISCOVERY_ARTIFACT": str(source) if not request.get("missing") else str(root / "missing.json"),
    "INPUTS_RUN_ID": request.get("run_id", ""),
})
if request.get("run_only") or request.get("no_input"):
    os.environ["INPUTS_DISCOVERY_ARTIFACT"] = ""
calls = []


def transport(args, **kwargs):
    calls.append(args)
    if args[0] == "archon":
        if args != ["archon", "workflow", "get", request["run_id"], "--json"]:
            raise AssertionError(f"Unexpected CLI operation: {args}")
        response = {"id": request["run_id"], "status": "completed",
                    "artifacts_dir": str(source_artifacts),
                    "leave_behind": {"artifactFiles": list(request.get("artifact_files", {}))}}
        response.update(request.get("cli_response", {}))
        if request.get("missing_storage"):
            response["artifacts_dir"] = str(root / "absent storage")
        if request.get("cli_error") == "timeout":
            raise subprocess.TimeoutExpired(args, 60)
        if request.get("cli_error") == "missing":
            raise FileNotFoundError("test CLI unavailable")
        return subprocess.CompletedProcess(args, request.get("cli_exit", 0),
                                           request.get("cli_raw", json.dumps(response)), "test CLI diagnostic")
    if args[0] == "gh":
        if args != ["gh", "repo", "view", "github.com/" + request.get("gh_repository", "example/repo"), "--json", "nameWithOwner"]:
            raise AssertionError(f"Unexpected forge operation: {args}")
        return subprocess.CompletedProcess(args, request.get("gh_exit", 0),
                                           json.dumps({"nameWithOwner": request.get("gh_identity", "example/repo")}), "")
    if args[0] != "git" or args[1] not in ("remote", "rev-parse", "show", "ls-tree"):
        raise AssertionError(f"Unexpected script operation: {args}")
    return real_run(args, **kwargs)


class Stream(io.StringIO):
    def reconfigure(self, **kwargs):
        pass


steps = []
for name, binding in (
    ("resolve-input", {}),
    ("check-evidence", {"INPUTS_REVALIDATION": request.get("revalidation", [])}),
    ("render-proposals", {"INPUTS_SEARCH_RESULTS": request.get("search", []),
                          "INPUTS_CLASSIFICATION": request.get("classification", [])}),
):
    if request.get("move") == name:
        (repo / "AGENTS.md").write_text("Changed source.\n", encoding="utf-8")
        git("add", ".")
        git("-c", "core.hooksPath=", "commit", "-qm", "move source")
    os.environ.update({key: json.dumps(value) for key, value in binding.items()})
    out, err = Stream(), Stream()
    with patch("subprocess.run", transport), contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        namespace = runpy.run_path(str(scripts / (name + ".py")))
        try:
            code = namespace["main"]()
        except SystemExit as exc:
            code = exc.code
    steps.append({"name": name, "code": code, "stdout": out.getvalue(), "stderr": err.getvalue()})
    if code or request.get("resolve_only"):
        break

files = {}
for name in ("discoveries/normalized.json", "discoveries/context.json", "evidence-check.json",
             "discovery-proposals.json", "discovery-proposals.md"):
    file = artifacts / name
    if file.exists():
        files[name] = file.read_text(encoding="utf-8")
print(json.dumps({
    "steps": steps, "files": files, "calls": calls,
    "status": git("status", "--porcelain"), "head": original_head,
    "classifications": runpy.run_path(str(scripts / "render-proposals.py"))["CLASSIFICATIONS"],
    "verdicts": runpy.run_path(str(scripts / "check-evidence.py"))["VERDICTS"],
    "terminal_statuses": runpy.run_path(str(scripts / "resolve-input.py"))["TERMINAL_STATUSES"],
}))
