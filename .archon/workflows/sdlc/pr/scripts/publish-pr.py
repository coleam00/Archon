"""Push the selected local branch and publish through the engine's forge contract."""
import json
import os
import subprocess
import sys


def git(*args):
    result = subprocess.run(["git", *args], capture_output=True, text=True, encoding="utf-8")
    if result.returncode:
        raise RuntimeError("Git publication step failed; inspect repository state before retrying")
    return result.stdout.strip()


def forge(*args, request=None):
    command = [os.environ["ARCHON_EXECUTABLE"], *json.loads(os.environ["ARCHON_EXECUTABLE_ARGS"])]
    result = subprocess.run([*command, "forge", *args, "--json", *(["--request", "-"] if request is not None else [])], input=json.dumps(request) if request is not None else None, capture_output=True, text=True, encoding="utf-8")
    sys.stderr.write(result.stderr)
    if result.returncode:
        raise RuntimeError("Forge publication refused: " + result.stdout.strip())
    return json.loads(result.stdout)


content = json.loads(os.environ["INPUTS_CONTENT"])
resolved = forge("resolve")
if resolved["forge"] == "none":
    raise RuntimeError("PR publication requires a configured forge")
repo = resolved["repo"]
branch = git("branch", "--show-current")
if not branch or branch == content["base"]:
    raise RuntimeError("Publication requires a named branch distinct from the base")
git("check-ref-format", "--branch", branch)
git("check-ref-format", "--branch", content["base"])
sha = git("rev-parse", "HEAD")
if int(git("rev-list", "--count", content["base"] + ".." + sha)) == 0:
    raise RuntimeError("Publication requires commits ahead of the base")
# Exact SHA source and explicit origin destination preserve adopted branches and forks.
git("push", "-u", "origin", sha + ":refs/heads/" + branch)
git("branch", "--set-upstream-to=origin/" + branch, branch)
result = forge("pr", "create", request={"repo": repo, "head_repo": repo, "head": branch, "head_sha": sha, "base": content["base"], "title": content["title"], "body": content["body"], "is_draft": os.environ["INPUTS_DRAFT"] == "true"})
print(json.dumps(result))
