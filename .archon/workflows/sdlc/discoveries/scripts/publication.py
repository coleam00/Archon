"""Prepare an exact batch, then publish only the native gate's persisted inputs.

The DAG owns approval and resume. This script has no approval receipt or policy
input. The prepare node's durable digest binds the gate message to the file read
after a pause. Forge operations own pagination, recovery and write verification.
"""

import hashlib
import json
import os
from pathlib import Path, PurePosixPath, PureWindowsPath
import subprocess
import sys


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def encoded(value):
    return (json.dumps(value, ensure_ascii=True, sort_keys=True, indent=2) + "\n").encode()


def git(*args):
    result = subprocess.run(["git", *args], capture_output=True)
    require(result.returncode == 0, "source inspection failed")
    return result.stdout


def check_source(revision, refs):
    require(git("rev-parse", "HEAD").decode().strip() == revision,
            "source revision moved; start a new revalidation and approval run")
    require(not git("status", "--porcelain", "--untracked-files=all"),
            "dirty source; restore the reviewed checkout or revalidate in a new run")
    for ref in refs:
        path, line = ref["path"], ref["line"]
        require(isinstance(path, str) and path and not PurePosixPath(path).is_absolute()
                and not PureWindowsPath(path).drive and "\\" not in path
                and not any(ord(c) < 32 for c in path)
                and not any(p in (".", "..", "") for p in path.split("/"))
                and type(line) is int and line > 0, "invalid source citation")
        require(git("ls-tree", "-z", revision, "--", path).split(b" ", 1)[0]
                in (b"100644", b"100755"), "citation is not a regular source file")
        require(line <= len(git("show", f"{revision}:{path}").splitlines()),
                "citation line is unavailable")


def forge(request):
    executable = os.environ.get("ARCHON_EXECUTABLE")
    args = os.environ.get("ARCHON_EXECUTABLE_ARGS")
    command = ["archon"]
    if executable is not None or args is not None:
        args = json.loads(args)
        require(executable and isinstance(args, list) and all(isinstance(a, str) for a in args),
                "invalid Archon CLI launch context")
        command = [executable, *args]
    operation = request["op"].replace("workitem.", "work-item.").split(".")
    result = subprocess.run([*command, "forge", *operation, "--request", "-", "--json"],
                            input=json.dumps(request), capture_output=True, text=True, timeout=120)
    # The owner's diagnostics are already redacted and retain uncertain-write evidence.
    if result.stderr:
        print(result.stderr, file=sys.stderr, end="")
    require(result.returncode == 0, "forge operation failed: " + result.stdout.strip())
    return json.loads(result.stdout)


def main():
    root = Path(os.environ["ARTIFACTS_DIR"])
    batch_path = root / "discovery-publication.json"
    mode = os.environ["INPUTS_MODE"]
    if mode == "prepare":
        publish = os.environ.get("INPUTS_PUBLISH", "false")
        require(publish in ("false", "true"), "publish must be true or false")
        if publish == "false":
            print(json.dumps({"requires_gate": False, "batch_hash": "", "review": ""}))
            return
        names = ("discovery-proposals.json", "discoveries/context.json",
                 "discoveries/normalized.json", "evidence-check.json")
        identities = {name: digest((root / name).read_bytes()) for name in names}
        document = json.loads((root / names[0]).read_bytes())
        context = json.loads((root / names[1]).read_bytes())
        repo = {k: document["forge"][k] for k in ("host", "path")}
        actions = []
        check_source(document["revision"], [])
        for row in document["proposals"]:
            if not row["actionable"]:
                continue
            require(document["forge"]["available"] and repo["host"] and repo["path"],
                    "publication needs a known forge identity")
            require(row["model_verdict"] == "supported" and row["evidence_status"] == "source-bound"
                    and row["evidence_refs"] and row["forge_checked"], "unverified proposal")
            check_source(document["revision"], row["evidence_refs"])
            marker = "<!-- archon-discovery:" + row["marker"] + " -->"
            citations = "\n".join(f"- `{r['path']}:{r['line']}` at `{document['revision']}`"
                                  for r in row["evidence_refs"])
            body = f"{row['summary']}\n\n{row['rationale']}\n\nSource evidence:\n{citations}"
            if row["classification"] == "new":
                request = {"op": "workitem.create", "repo": repo, "marker": marker,
                           "title": row["title"], "body": body, "max_pages": 100}
            else:
                require(row["classification"] == "update-existing", "unsupported publication action")
                target = row["target_item"]
                require(target["url"] == f"https://{repo['host']}/{repo['path']}/issues/{target['number']}",
                        "publication only updates an exact existing issue")
                request = {"op": "comment.upsert", "target": {"kind": "workitem", "ref": {
                    "repo": repo, "number": target["number"]}}, "marker": marker, "body": body}
            actions.append({"item_index": row["item_index"], "request": request,
                            "public_body": marker + "\n" + body, "evidence_refs": row["evidence_refs"]})
        batch = {"revision": document["revision"], "source": context["input"],
                 "artifact_sha256": identities, "actions": actions}
        data = encoded(batch)
        # A retry of preparation cannot silently replace a batch already shown to a human.
        require(not batch_path.exists() or batch_path.read_bytes() == data,
                "publication batch changed; start a new proposal and approval run")
        batch_path.write_bytes(data)
        fence = "```"
        while fence in data.decode():
            fence += "`"
        print(json.dumps({"requires_gate": bool(actions), "batch_hash": digest(data),
                          "review": fence + "json\n" + data.decode() + fence}))
        return
    require(mode == "publish", "unsupported publication mode")
    require(os.environ.get("INPUTS_DECISION") == "approve", "native batch approval required")
    data = batch_path.read_bytes()
    require(digest(data) == os.environ.get("INPUTS_BATCH_HASH"), "gate action tamper: batch digest changed")
    batch = json.loads(data)
    for name, expected in batch["artifact_sha256"].items():
        require(digest((root / name).read_bytes()) == expected,
                "reviewed evidence or proposals changed; revalidate and approve a new batch")
    refs = [ref for action in batch["actions"] for ref in action["evidence_refs"]]
    check_source(batch["revision"], refs)
    results = []
    for action in batch["actions"]:
        request = action["request"]
        repo = request.get("repo") or request["target"]["ref"]["repo"]
        matches = forge({"op": "workitem.search", "repo": repo,
                         "marker": request["marker"], "max_pages": 100})
        require(matches["repo"] == repo and matches["completeness"] == "complete",
                "incomplete marker enumeration; publication held")
        require(len(matches["items"]) <= 1, "ambiguous duplicate markers; operator must reconcile")
        check_source(batch["revision"], action["evidence_refs"])
        if matches["items"]:
            # A marker appearing during the pause wins. Never redirect an approved
            # update or add new text to an issue that the human did not select.
            result = {"status": "reused", "item": matches["items"][0]}
        else:
            result = {"status": "verified", "value": forge(request)}
        results.append({"marker": request["marker"], **result})
        # Progress is diagnostic only. Resume always uses the gate-bound request
        # and fresh owner reads, including when the response or this file was lost.
        (root / "discovery-publication-results.json").write_bytes(encoded(results))
    print(json.dumps({"count": len(results), "results": results}))


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", newline="\n")
    sys.stderr.reconfigure(encoding="utf-8", newline="\n")
    try:
        main()
    except (ValueError, KeyError, TypeError, OSError, subprocess.TimeoutExpired) as error:
        print(f"publication: {error}", file=sys.stderr)
        sys.exit(1)
