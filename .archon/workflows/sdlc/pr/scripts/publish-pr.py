"""Push the selected local branch and publish through the engine's forge contract."""
import json
import os
import re
import subprocess
import sys


def git(*args):
    result = subprocess.run(["git", *args], capture_output=True, text=True, encoding="utf-8")
    if result.returncode:
        raise RuntimeError(f"Git publication {args[0]} failed (exit {result.returncode}); inspect repository state before retrying")
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
sha, head_ref = git("rev-parse", "HEAD", "--symbolic-full-name", "HEAD").splitlines()
branch = head_ref.removeprefix("refs/heads/") if head_ref.startswith("refs/heads/") else ""
if not branch or branch == content["base"]:
    raise RuntimeError("Publication requires a named branch distinct from the base")
if re.fullmatch(r"(?:archon/)?pr-[0-9]+-review", branch):
    raise RuntimeError("Publication refuses a synthetic fork-review branch; arrange a writable checkout of the actual PR head")
base = content["base"]
if not isinstance(base, str) or base.startswith(("-", "refs/")):
    raise RuntimeError("Publication requires a logical base branch name")
# --branch expands checkout shorthand such as @{-1}; only accept the literal name.
if git("check-ref-format", "--branch", base) != base:
    raise RuntimeError("Publication requires a literal base branch name")
if git("status", "--porcelain", "--untracked-files=all"):
    raise RuntimeError("Publication requires a clean checkout")
# Origin owns the publication base. Fetch only that branch, never a local branch
# or a default; pin the qualified ref so revision-name ambiguity cannot change the guard.
base_ref = "refs/remotes/origin/" + base
git("fetch", "--no-tags", "--no-write-fetch-head", "origin", "+refs/heads/" + base + ":" + base_ref)
base_sha = git("rev-parse", "--verify", base_ref + "^{commit}")
if int(git("rev-list", "--count", base_sha + ".." + sha, "--")) == 0:
    raise RuntimeError("Publication requires commits ahead of the base")
if git("rev-parse", "HEAD", "--symbolic-full-name", "HEAD").splitlines() != [sha, head_ref]:
    raise RuntimeError("Publication checkout changed during base verification")
if git("status", "--porcelain", "--untracked-files=all"):
    raise RuntimeError("Publication requires a clean checkout")
# Exact SHA source and explicit origin destination preserve adopted branches and forks.
git("push", "-u", "origin", sha + ":refs/heads/" + branch)
git("branch", "--set-upstream-to=origin/" + branch, branch)
result = forge("pr", "create", request={"repo": repo, "head_repo": repo, "head": branch, "head_sha": sha, "base": content["base"], "title": content["title"], "body": content["body"], "is_draft": os.environ["INPUTS_DRAFT"] == "true"})
print(json.dumps(result))
