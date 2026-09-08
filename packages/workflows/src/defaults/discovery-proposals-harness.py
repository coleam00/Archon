"""Exercise real discovery scripts in a plain git repo; simulate only gh transport."""

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
if "raw" in request:
    source.write_text(request["raw"], encoding="utf-8")
os.chdir(repo)
os.environ.update({
    "ARTIFACTS_DIR": str(artifacts),
    "INPUTS_DISCOVERY_ARTIFACT": str(source) if not request.get("missing") else str(root / "missing.json"),
    "INPUTS_RUN_ID": request.get("run_id", ""),
})
calls = []


def transport(args, **kwargs):
    calls.append(args)
    if args[0] == "gh":
        if args != ["gh", "repo", "view", "github.com/example/repo", "--json", "nameWithOwner"]:
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
    if code:
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
}))
