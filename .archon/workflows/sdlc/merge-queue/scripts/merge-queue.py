"""Run-owned supervised queue computations. YAML alone advances the bounded loops."""

import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
from uuid import uuid4


MAX_BATCH = 5
SHA = re.compile(r"[a-f0-9]{40}")


def require(value, message):
    if not value:
        raise ValueError(message)


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


def atomic(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(dir=path.parent, prefix=".queue-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(value, stream, indent=2)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def command(argv, cwd, data=None):
    return subprocess.run(argv, cwd=cwd, input=data, capture_output=True, text=True, check=False)


class Queue:
    def __init__(self, cwd, artifacts, run_id):
        self.cwd = Path(cwd).resolve()
        self.artifacts = Path(artifacts).resolve()
        self.run_id = run_id
        self.path = self.artifacts / "queue.json"
        self.state = json.loads(self.path.read_text()) if self.path.exists() else None
        if self.state:
            require(self.state["run_id"] == run_id and self.state["checkout"] == str(self.cwd),
                    "Queue belongs to another run or checkout")

    def save(self):
        atomic(self.path, self.state)

    def order_plan(self):
        return {"intake": self.state["intake"], "base": self.state["base"], "base_sha": self.state["base_sha"],
                "assessment": self.state["assessment"],
                "items": [{"pr": i["pr"], "files": i["files"]} for i in self.state["items"]]}

    def approved_order(self):
        require(digest(self.order_plan()) == self.state["order_snapshot"], "Pinned intake or order changed")
        require(self.state["order"] == self.state["assessment"]["order"], "Approved order changed")

    def git(self, *args, allowed=(0,), data=None):
        result = command(["git", *args], self.cwd, data)
        require(result.returncode in allowed, f"git {args[0]} failed (exit {result.returncode}); no revision changed by fallback")
        return result

    def cli(self, args, request=None):
        launch = [os.environ.get("ARCHON_EXECUTABLE", "archon")]
        launch += json.loads(os.environ.get("ARCHON_EXECUTABLE_ARGS", "[]"))
        result = command([*launch, *args, "--json"], self.cwd,
                         json.dumps(request) if request is not None else None)
        try:
            payload = json.loads(result.stdout)
        except (ValueError, TypeError):
            payload = {"kind": "invalid_response", "detail": "CLI returned no JSON result"}
        return result.returncode, payload

    def read_cli(self, args, request=None):
        code, payload = self.cli(args, request)
        require(code == 0, f"Public CLI failed: {json.dumps(payload)}")
        return payload

    def clean(self, expected):
        require(self.git("status", "--porcelain", "--untracked-files=all").stdout == "",
                "Dirty queue checkout; preserve changes and start a fresh queue after correction")
        require(self.git("rev-parse", "HEAD").stdout.strip() == expected, "Candidate HEAD changed")
        branch = self.git("symbolic-ref", "-q", "HEAD", allowed=(0, 1)).stdout.strip()
        require(branch == self.state["branch"] or (not branch and self.state.get("merge_checkout") == expected),
                "Queue branch ownership changed")

    def ownership(self):
        run = self.read_cli(["workflow", "get", self.run_id])
        require(run.get("id") == self.run_id and run.get("workflow_name") == "archon-merge-queue"
                and Path(run.get("working_path") or "").resolve() == self.cwd,
                "Engine run does not own this queue checkout")
        git_dir = Path(self.git("rev-parse", "--absolute-git-dir").stdout.strip()).resolve()
        common = Path(self.git("rev-parse", "--path-format=absolute", "--git-common-dir").stdout.strip()).resolve()
        require(git_dir != common and (self.cwd / ".git").is_file(), "Queue requires a linked engine worktree")
        branch = self.git("symbolic-ref", "-q", "HEAD", allowed=(0, 1)).stdout.strip()
        if not branch and self.state and self.state.get("merge_checkout"):
            branch = self.state["branch"]
            require(self.git("rev-parse", branch).stdout.strip() == self.ordered()[-1]["candidate"],
                    "Owned queue branch moved during publication")
        require(branch.startswith("refs/heads/archon/task-") or branch.startswith("refs/heads/archon/merge-queue-"),
                "Use a dedicated native archon/task-* or archon/merge-queue-* branch")
        require(not self.git("ls-remote", "--heads", "origin", branch).stdout,
                "Queue branch is published; use a new native queue worktree")
        return branch

    def remote_base(self, base):
        self.git("check-ref-format", "refs/heads/" + base)
        lines = self.git("ls-remote", "--heads", "origin", "refs/heads/" + base).stdout.splitlines()
        require(len(lines) == 1, "Missing or ambiguous base ref")
        sha, ref = lines[0].split("\t")
        require(SHA.fullmatch(sha) and ref == "refs/heads/" + base, "Invalid base identity")
        return sha

    def view(self, ref):
        record = self.read_cli(["forge", "pr", "view", "--request", "-"], {"ref": ref})
        require(record.get("ref") == ref and SHA.fullmatch(record.get("head_sha", "")), "PR identity mismatch")
        for key in ("head", "base"):
            require(isinstance(record.get(key), str), "Missing PR branch")
            self.git("check-ref-format", "refs/heads/" + record[key])
        require(record.get("head_repo") == ref["repo"], "Fork PRs require a forge fetch capability; unsupported in this slice")
        require(record.get("state") == "open" and record.get("is_draft") is False, "PR must be open and ready")
        return record

    def intake(self, refs):
        require(isinstance(refs, list) and 1 <= len(refs) <= MAX_BATCH, f"Explicit batch must contain 1..{MAX_BATCH} PR refs")
        for ref in refs:
            require(isinstance(ref, dict) and set(ref) == {"repo", "number"}
                    and type(ref["number"]) is int and ref["number"] > 0, "Malformed qualified PR ref")
            repo = ref["repo"]
            require(isinstance(repo, dict) and set(repo) == {"host", "path"}
                    and isinstance(repo["host"], str) and re.fullmatch(r"[a-z0-9]+(?:[.-][a-z0-9]+)*", repo["host"])
                    and isinstance(repo["path"], str) and len(repo["path"].split("/")) >= 2
                    and all(re.fullmatch(r"[\w.-]+", part) and part not in (".", "..") for part in repo["path"].split("/")),
                    "Malformed qualified repository")
        require(len({digest(ref) for ref in refs}) == len(refs), "Duplicate intake")
        require(all(ref["repo"] == refs[0]["repo"] for ref in refs), "Mixed repositories")
        if self.state:
            require(refs == self.state["intake"], "Intake is immutable on resume")
            return self.state
        branch = self.ownership()
        resolved = self.read_cli(["forge", "resolve"])
        require(resolved.get("repo") == refs[0]["repo"] and resolved.get("forge") not in (None, "none"),
                "Queue origin does not resolve to the intake repository")
        items = [self.view(ref) for ref in refs]
        require(len({item["base"] for item in items}) == 1, "Mixed base branches")
        require(all("refs/heads/" + item["head"] != branch for item in items), "Queue branch is a source PR")
        base = items[0]["base"]
        base_sha = self.remote_base(base)
        self.state = {"version": 1, "run_id": self.run_id, "checkout": str(self.cwd), "branch": branch,
                      "intake": refs, "base": base, "base_sha": base_sha, "phase": "intake",
                      "items": [], "order": [], "order_receipt": None, "candidate_receipt": None}
        self.clean(base_sha)
        for item in items:
            self.git("fetch", "--no-tags", "origin", "refs/heads/" + item["head"])
            require(self.git("rev-parse", "FETCH_HEAD").stdout.strip() == item["head_sha"], "PR head moved during intake")
            files = self.git("diff", "--name-only", base_sha + "..." + item["head_sha"]).stdout.splitlines()
            self.state["items"].append({"pr": item, "files": files, "status": "queued"})
        self.save()
        return self.state

    def assess(self, assessment):
        require(isinstance(assessment, dict) and isinstance(assessment.get("order"), list), "Missing assessment order")
        numbers = [item["pr"]["ref"]["number"] for item in self.state["items"]]
        order = assessment["order"]
        require(all(type(n) is int for n in order) and sorted(order) == sorted(numbers), "Order must be an exact intake permutation")
        judgments = assessment.get("judgments", [])
        require(sorted(j.get("number", -1) for j in judgments) == sorted(numbers), "Every PR needs exactly one judgment")
        require(all(j.get("size") in ("small_bounded", "risky", "large") and isinstance(j.get("reason"), str)
                    and j["reason"].strip() for j in judgments), "Invalid size or missing order reasons")
        if "assessment" in self.state:
            require(self.state["assessment"] == assessment, "Assessment is immutable on resume")
        else:
            self.state.update(assessment=assessment, order=order, phase="awaiting_order")
            self.state["order_snapshot"] = digest(self.order_plan())
            self.save()
        self.approved_order()
        return {"snapshot": self.state["order_snapshot"], "plan": self.order_plan()}

    def ordered(self):
        return [next(i for i in self.state["items"] if i["pr"]["ref"]["number"] == n) for n in self.state["order"]]

    def hold(self, reason, start=0):
        for item in self.ordered()[start:]:
            if item["status"] != "merged":
                item.update(status="held", reason=reason)
        self.state["phase"] = "held"
        self.save()

    def gate(self, kind, receipt, snapshot):
        require(isinstance(receipt, dict) and receipt.get("decision") in ("approve", "hold")
                and isinstance(receipt.get("text"), str), "Expected a declared native gate receipt; prose is not approval")
        require(snapshot == self.state[kind + "_snapshot"], "Approval snapshot changed")
        self.approved_order()
        existing = self.state[kind + "_receipt"]
        if existing is not None:
            require(existing == {"response": receipt, "snapshot": snapshot}, "Gate receipt is immutable")
            return {"proceed": self.state["phase"] not in ("held", "failed")}
        if kind == "candidate":
            require(self.chain() == self.state["candidate_chain"], "Candidate chain changed after gate")
            self.verify_evidence()
        self.state[kind + "_receipt"] = {"response": receipt, "snapshot": snapshot}
        if receipt["decision"] == "hold":
            self.hold(f"Supervisor held {kind} snapshot")
        else:
            self.state["phase"] = "preparing" if kind == "order" else "merging"
            self.save()
        return {"proceed": receipt["decision"] == "approve"}

    def checks(self, item):
        ref = item["pr"]["ref"]
        verdict = self.read_cli(["forge", "checks", "--ref", json.dumps(ref)])
        require(verdict.get("head_sha") == item["pr"]["head_sha"], "Checks belong to a stale PR head")
        required = verdict.get("required")
        require(isinstance(required, dict), "Required external CI policy is unknown")
        if verdict.get("state") == "green" and required.get("state") in ("green", "none"):
            require(verdict.get("counts", {}).get("total", 0) > 0, "Head CI none is not green")
            return verdict
        # Only a separately committed base policy can authorize absence of external CI.
        if verdict.get("state") == "none" and required.get("state") == "none" and required.get("counts", {}).get("total") == 0:
            policy = self.git("show", self.state["base_sha"] + ":.archon/merge-queue-policy.json", allowed=(0, 128))
            require(policy.returncode == 0 and json.loads(policy.stdout) == {"external_ci": "none"},
                    "Head CI none requires an explicit no-CI policy committed at the pinned base")
            return verdict
        raise ValueError("External CI or required checks are not green")

    def current(self, item, base):
        record = self.view(item["pr"]["ref"])
        require(all(record[k] == item["pr"][k] for k in ("head", "head_sha", "head_repo", "base")), "PR head/base changed")
        require(self.remote_base(self.state["base"]) == base, "Upstream base changed; reapproval requires a fresh reviewed queue")
        return self.checks(item)

    def prepare(self):
        require(self.state["order_receipt"]["response"]["decision"] == "approve", "Order is not approved")
        self.approved_order()
        if self.state["phase"] == "held":
            return {"run": False}
        items = self.ordered()
        index = next((n for n, i in enumerate(items) if i["status"] not in ("tested", "merged")), len(items))
        if index == len(items):
            return {"run": False}
        item = items[index]
        base = self.state["base_sha"] if index == 0 else items[index - 1]["candidate"]
        try:
            self.ownership()
            item["head_checks"] = self.current(item, self.state["base_sha"])
            self.clean(item.get("candidate", base) if self.git("rev-parse", "HEAD").stdout.strip() == item.get("candidate") else base)
            if "candidate" not in item:
                result = self.git("merge-tree", "--write-tree", base, item["pr"]["head_sha"], allowed=(0, 1))
                if result.returncode == 1:
                    item["correction"] = {"ref": item["pr"]["ref"], "head_sha": item["pr"]["head_sha"], "base_sha": base,
                                          "requirement": "Run native archon-deliver separately to repair this conflict, independently review, then start a new queue.",
                                          "git_evidence": result.stdout}
                    raise ValueError("Composition conflict requires a separate native deliver correction")
                tree = result.stdout.splitlines()[0]
                require(SHA.fullmatch(tree), "Missing composition tree")
                candidate = self.git("commit-tree", tree, "-p", base, "-p", item["pr"]["head_sha"],
                                     "-m", f"Compose queue {self.run_id} PR {item['pr']['ref']['number']}").stdout.strip()
                item.update(candidate=candidate, expected_base=base, status="prepared")
                self.save()  # Persist the exact object before moving the owned branch.
            self.git("merge", "--ff-only", "--no-edit", item["candidate"])
            self.clean(item["candidate"])
            evidence_dir = self.artifacts / "candidates" / item["candidate"]
            if item.get("evidence_started"):
                raise ValueError("Interrupted candidate evidence; start a fresh queue for independent re-review")
            evidence_dir.mkdir(parents=True, exist_ok=True)
            # Canonical reports are scratch for the existing includes. Preserve every prior set.
            for name in ("review", "validation.md", "discoveries", "discoveries.json", "discoveries.md"):
                source = self.artifacts / name
                if source.exists():
                    archive = self.artifacts / "prior-evidence" / str(uuid4())
                    archive.mkdir(parents=True)
                    shutil.move(str(source), str(archive / name))
            item["evidence_started"] = True
            self.save()
            return {"run": True, "number": item["pr"]["ref"]["number"], "candidate": item["candidate"],
                    "local_range": base + ".." + item["candidate"], "work_order": item["pr"].get("body", ""),
                    "review_errors": True, "review_docs": "auto"}
        except (ValueError, OSError) as error:
            self.hold(str(error), index)
            return {"run": False}

    def record(self, prepared, review, validation):
        if not prepared.get("run"):
            return {"done": True}
        item = next(i for i in self.ordered() if i["pr"]["ref"]["number"] == prepared["number"])
        index = self.ordered().index(item)
        if item["status"] in ("tested", "held"):
            return {"done": self.state["phase"] == "held" or all(i["status"] == "tested" for i in self.ordered())}
        try:
            require(prepared["candidate"] == item["candidate"], "Candidate identity changed")
            self.clean(item["candidate"])
            evidence = {"review_result": review, "validation_result": validation, "files": {}}
            destination = self.artifacts / "candidates" / item["candidate"]
            for name in ("review", "validation.md"):
                source = self.artifacts / name
                require(source.exists(), f"Missing {name} evidence")
                if source.is_dir():
                    require((source / "report.md").is_file() and (source / "scope.md").is_file(), "Missing review report/scope")
                    shutil.copytree(source, destination / name, dirs_exist_ok=False)
                else:
                    shutil.copyfile(source, destination / name)
            for path in sorted(destination.rglob("*")):
                if path.is_file():
                    require(path.stat().st_size > 0, "Empty evidence file")
                    evidence["files"][str(path.relative_to(self.artifacts))] = hashlib.sha256(path.read_bytes()).hexdigest()
            item["evidence"] = evidence
            require(isinstance(review, dict) and review.get("ready") is True, "Composition review missing or not ready")
            require(isinstance(validation, dict) and validation.get("checks_performed") is True
                    and validation.get("green") is True, "Composition checks missing, absent, or red")
            item.update(status="tested", evidence=evidence)
            self.save()
        except (ValueError, OSError) as error:
            self.hold(str(error), index)
        return {"done": self.state["phase"] == "held" or all(i["status"] == "tested" for i in self.ordered())}

    def chain(self):
        return [{"ref": i["pr"]["ref"], "head_ref": i["pr"]["head"], "head": i["pr"]["head_sha"],
                 "base": i.get("expected_base"), "candidate": i.get("candidate"), "evidence": i.get("evidence"),
                 "head_checks": i.get("head_checks")}
                for i in self.ordered()]

    def verify_evidence(self):
        for item in self.ordered():
            require(item["status"] in ("tested", "merging", "uncertain", "merged"), "Candidate is not tested")
            for name, checksum in item["evidence"]["files"].items():
                path = (self.artifacts / name).resolve()
                require(path.is_relative_to(self.artifacts) and path.is_file()
                        and hashlib.sha256(path.read_bytes()).hexdigest() == checksum, "Candidate evidence changed or missing")
            parents = self.git("show", "-s", "--format=%P", item["candidate"]).stdout.strip().split()
            require(parents == [item["expected_base"], item["pr"]["head_sha"]], "Candidate parents changed")
        self.clean(self.state.get("merge_checkout", self.ordered()[-1]["candidate"]))

    def snapshot(self):
        if self.state["phase"] == "held":
            return {"ready": False}
        try:
            self.approved_order()
            self.verify_evidence()
        except (ValueError, OSError, KeyError) as error:
            self.hold("Candidate evidence is incomplete: " + str(error))
            return {"ready": False}
        chain = self.chain()
        if "candidate_chain" in self.state:
            require(chain == self.state["candidate_chain"] and digest(chain) == self.state["candidate_snapshot"],
                    "Candidate snapshot is immutable")
            return {"ready": True, "snapshot": self.state["candidate_snapshot"], "chain": chain}
        self.state.update(candidate_chain=chain, candidate_snapshot=digest(chain), phase="awaiting_candidates")
        self.save()
        return {"ready": True, "snapshot": digest(chain), "chain": chain}

    def merge(self):
        require(self.state["candidate_receipt"]["response"]["decision"] == "approve", "Candidates not approved")
        require(self.chain() == self.state["candidate_chain"], "Approved chain changed")
        require(self.state["candidate_receipt"]["snapshot"] == self.state["candidate_snapshot"] == digest(self.chain()),
                "Candidate approval does not match the exact snapshot")
        items = self.ordered()
        index = next((n for n, i in enumerate(items) if i["status"] != "merged"), len(items))
        if index == len(items):
            return {"done": True}
        item = items[index]
        if item["status"] in ("held", "failed"):
            return {"done": True}
        try:
            self.approved_order()
            self.ownership()
            self.verify_evidence()
            # An uncertain attempt must reach the owner's exact identity recovery path:
            # reading an already-merged PR as a fresh open PR would prevent recovery.
            recovering = item["status"] in ("merging", "uncertain")
            observed = self.read_cli(["forge", "pr", "view", "--request", "-"], {"ref": item["pr"]["ref"]}) if recovering else None
            if not recovering or observed.get("state") != "merged":
                item["checks"] = self.current(item, item["expected_base"])
                require(item["checks"] == item["head_checks"], "External check evidence changed after approval")
            request = {"ref": item["pr"]["ref"], "expected_head_ref": "refs/heads/" + item["pr"]["head"],
                       "expected_head_sha": item["pr"]["head_sha"], "expected_base_ref": "refs/heads/" + self.state["base"],
                       "expected_base_sha": item["expected_base"], "candidate_sha": item["candidate"], "checkout": str(self.cwd)}
            if "merge_request" in item:
                require(request == item["merge_request"], "Recovery identity changed")
            # The forge owner requires HEAD to be the exact candidate it publishes.
            # Keep the owned branch pinned to the full chain while visiting its commits.
            self.git("switch", "--detach", item["candidate"])
            self.state["merge_checkout"] = item["candidate"]
            self.clean(item["candidate"])
            item.update(status="merging", merge_request=request)
            self.save()
            code, result = self.cli(["forge", "pr", "merge-pinned", "--request", "-"], request)
            item["merge_result"] = result
            if code != 0:
                recovery = result.get("recovery", {})
                if recovery.get("publication") == "not_attempted" and all(recovery.get(k) == v for k, v in request.items() if k != "checkout"):
                    self.hold("Pinned operation refused publication; see merge_result", index)
                    item["status"] = "failed"
                    self.save()
                    return {"done": True}
                item["status"] = "uncertain"
                self.save()
                raise RuntimeError("Pinned merge did not return success; resume this exact operation to recover; see queue.json")
            if not (result.get("status") in ("merged", "already_merged") and result.get("publication") == "applied"
                    and all(result.get(key) == value for key, value in request.items() if key != "checkout")):
                item["status"] = "uncertain"
                self.save()
                raise RuntimeError("Pinned merge returned an incomplete outcome; resume exact identity recovery")
            item["status"] = "merged"
            self.state["phase"] = "merged" if index == len(items) - 1 else "merging"
            self.save()
            if index == len(items) - 1:
                self.git("switch", self.state["branch"].removeprefix("refs/heads/"))
            return {"done": index == len(items) - 1}
        except (ValueError, OSError) as error:
            self.hold(str(error), index)
            return {"done": True}

    def report(self):
        return {"merged": bool(self.state["items"]) and all(i["status"] == "merged" for i in self.state["items"]),
                "queue": str(self.path), "phase": self.state["phase"],
                "entries": [{"ref": i["pr"]["ref"], "status": i["status"], "reason": i.get("reason", ""),
                             "candidate": i.get("candidate"), "correction": i.get("correction")}
                            for i in self.state["items"]]}


def main():
    queue = Queue(Path.cwd(), os.environ["ARTIFACTS_DIR"], os.environ["WORKFLOW_ID"])
    def value(name, default=None, raw=False):
        text = os.environ.get("INPUTS_" + name.upper(), json.dumps(default))
        return text if raw else json.loads(text)
    action = os.environ["INPUTS_ACTION"]
    if action == "intake":
        result = queue.intake(value("prs"))
    elif action == "assess":
        result = queue.assess(value("assessment"))
    elif action in ("order", "candidate"):
        result = queue.gate(action, value("receipt"), value("snapshot", raw=True))
    elif action == "prepare":
        result = queue.prepare()
    elif action == "record":
        result = queue.record(value("prepared"), value("review"), value("validation"))
    elif action == "snapshot":
        result = queue.snapshot()
    elif action == "merge":
        result = queue.merge()
    elif action == "report":
        result = queue.report()
    else:
        raise ValueError("Unknown queue computation")
    print(json.dumps(result))


if __name__ == "__main__":
    main()
