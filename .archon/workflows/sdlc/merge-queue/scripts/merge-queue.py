"""Run-owned supervised queue computations. YAML alone advances the bounded loops."""

import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
from typing import Literal, TypedDict
from uuid import uuid4


MAX_BATCH = 5
SHA = re.compile(r"[a-f0-9]{40}")
AUTO_POLICY_PATH = ".archon/merge-queue-auto.json"
MAX_FILES = 10
MAX_CHANGED_LINES = 300
COMPLEXITIES = ("small_bounded", "risky", "large")


class AutomaticPolicy(TypedDict):
    version: Literal[1]
    mode: Literal["automatic"]
    max_prs: int
    max_files: int
    max_changed_lines: int


class PolicyDecision(TypedDict):
    kind: Literal["automatic_policy", "human_required"]
    stage: Literal["order", "candidate"]
    source_policy_hash: str | None
    snapshot: str
    reasons: list[str]


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "Duplicate policy field")
        result[key] = value
    return result


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
                "automatic_policy": self.state["automatic_policy"],
                "assessment": self.state["assessment"], "order": self.state["order"],
                "items": [{"pr": i["pr"], "files": i["files"], "triage": i.get("triage"), "order_checks": i.get("order_checks")}
                          for i in self.state["items"]]}

    def read_policy(self):
        source = self.state["base_sha"] + ":" + AUTO_POLICY_PATH
        result = self.git("show", source, allowed=(0, 128))
        if result.returncode:
            return {"policy": None, "source_policy_hash": None, "reason": "No committed automatic policy"}
        source_hash = self.git("rev-parse", source).stdout.strip()
        try:
            entry = self.git("ls-tree", self.state["base_sha"], "--", AUTO_POLICY_PATH).stdout
            require(entry.startswith("100644 blob "), "Automatic policy must be a regular committed file")
            policy = json.loads(result.stdout, object_pairs_hook=unique_object)
            require(isinstance(policy, dict) and set(policy) == set(AutomaticPolicy.__annotations__),
                    "Malformed automatic policy fields")
            require(type(policy["version"]) is int and policy["version"] == 1 and policy["mode"] == "automatic",
                    "Unknown automatic policy version or mode")
            for key, maximum in (("max_prs", MAX_BATCH), ("max_files", MAX_FILES), ("max_changed_lines", MAX_CHANGED_LINES)):
                require(type(policy[key]) is int and 1 <= policy[key] <= maximum, "Automatic policy exceeds hard bounds: " + key)
            return {"policy": policy, "source_policy_hash": source_hash, "reason": ""}
        except (ValueError, TypeError) as error:
            return {"policy": None, "source_policy_hash": source_hash, "reason": str(error)}

    def verify_policy(self):
        require(self.read_policy() == self.state["automatic_policy"], "Pinned automatic policy changed")

    def triage_prepare(self):
        if not self.state["automatic_policy"]["policy"]:
            return {"run": False}
        item = next((i for i in self.state["items"] if "triage" not in i), None)
        if item is None:
            return {"run": False}
        self.clean(self.state["base_sha"])
        require(not item.get("triage_started"), "Interrupted triage requires a fresh queue")
        previous = self.artifacts / "triage.md"
        if previous.exists():
            archive = self.artifacts / "prior-evidence" / str(uuid4())
            archive.mkdir(parents=True)
            shutil.move(str(previous), str(archive / "triage.md"))
        item["triage_started"] = True
        self.save()
        return {"run": True, "ref": item["pr"]["ref"], "head": item["pr"]["head_sha"],
                "base": self.state["base_sha"], "target":
                "Triage the single original source work item implemented by this pinned PR, at the current original base. "
                "The PR below is provenance, not the work order. Read the actual PR and original tracker item and "
                "verify their relationship. Do not treat a related issue, PR self-report, or caller verdict as a contract. "
                "If the original item is absent, ambiguous, inaccessible, or cannot be attributed, return no_action "
                "with empty issue identity and explain the gap. Otherwise return the verified original issue identity. "
                "Do not publish. Pinned PR: " + json.dumps(item["pr"])}

    def triage_record(self, prepared, result):
        if not prepared.get("run"):
            return {"done": True}
        item = next(i for i in self.state["items"] if i["pr"]["ref"] == prepared["ref"])
        require("triage" not in item, "Triage evidence is immutable; resume its completed node")
        evidence = {"result": result, "source": None, "files": {}, "reason": ""}
        try:
            self.clean(self.state["base_sha"])
            require(prepared["base"] == self.state["base_sha"] and prepared["head"] == item["pr"]["head_sha"],
                    "Triage candidate identity changed")
            require(self.view(item["pr"]["ref"]) == item["pr"], "Source PR changed during triage")
            report = self.artifacts / "triage.md"
            require(report.is_file() and bool(report.read_text(encoding="utf-8").strip()), "Missing fresh triage evidence")
            destination = self.artifacts / "triage" / str(item["pr"]["ref"]["number"]) / "report.md"
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(report, destination)
            evidence["files"][str(destination.relative_to(self.artifacts))] = hashlib.sha256(destination.read_bytes()).hexdigest()
            require(isinstance(result, dict), "Missing shared triage output")
            # The shared triage producer currently attributes only github.com issues.
            # Other forges retain supervision until that producer supports their identities.
            repo, number = result.get("issue_repo"), result.get("issue_number")
            require(isinstance(repo, str) and re.fullmatch(r"[\w.-]+/[\w.-]+", repo)
                    and type(number) is int and number > 0, "Missing original work-item attribution")
            ref = {"repo": {"host": "github.com", "path": repo}, "number": number}
            source = self.read_cli(["forge", "workitem", "view", "--request", "-"], {"ref": ref})
            require(source.get("ref") == ref and source.get("url") == result.get("issue_url")
                    and source.get("url") == f"https://github.com/{repo}/issues/{number}"
                    and bool(source.get("body", "").strip()), "Original work-item read did not match triage")
            evidence["source"] = source
            require(result.get("contract") == "READY" and result.get("route") == "deliver"
                    and result.get("design_first") is False and result.get("complexity") == "small_bounded",
                    "Original work item is not independently ready and small_bounded")
            item["order_checks"] = self.current(item, self.state["base_sha"])
        except (ValueError, OSError) as error:
            evidence["reason"] = str(error)
        item["triage"] = evidence
        self.save()
        return {"done": all("triage" in i for i in self.state["items"])}

    def bounded_diff(self, start, end, policy):
        fields = self.git("diff", "--numstat", "-z", "--no-renames", start, end).stdout.split("\0")
        entries = [entry.split("\t", 2) for entry in fields if entry]
        require(all(len(entry) == 3 and entry[0].isdigit() and entry[1].isdigit() for entry in entries),
                "Binary or unknown diff size requires supervision")
        require(len(entries) <= policy["max_files"] and
                sum(int(a) + int(d) for a, d, _ in entries) <= policy["max_changed_lines"], "Diff threshold exceeded")
        require(all(path != AUTO_POLICY_PATH and path != ".archon/merge-queue-policy.json" for _, _, path in entries),
                "Candidate authors policy changes")

    def policy_decision(self, stage, snapshot):
        reasons = []
        source = self.state["automatic_policy"]
        policy = source["policy"]
        try:
            self.verify_policy()
            require(policy is not None, source["reason"])
            require(len(self.state["items"]) <= policy["max_prs"], "Batch threshold exceeded")
            require(self.state["assessment"] is not None, "Independent diff assessment is missing; intake order requires human review")
            require(all(j["size"] == "small_bounded" for j in self.state["assessment"]["judgments"]),
                    "Diff assessment is risky, large, or disagrees with small_bounded triage")
            for item in self.ordered():
                triage = item.get("triage")
                require(triage is not None and not triage["reason"] and triage["source"] is not None,
                        "Missing or ineligible original work-item triage: " + (triage["reason"] if triage else "not completed"))
                for name, checksum in triage["files"].items():
                    path = (self.artifacts / name).resolve()
                    require(path.is_relative_to(self.artifacts) and path.is_file()
                            and hashlib.sha256(path.read_bytes()).hexdigest() == checksum, "Triage evidence changed or missing")
                self.bounded_diff(self.state["base_sha"], item["pr"]["head_sha"], policy)
                checks = item.get("head_checks" if stage == "candidate" else "order_checks", {})
                require(checks.get("state") == "green" and checks.get("counts", {}).get("total", 0) > 0
                        and checks.get("required", {}).get("state") in ("green", "none"),
                        "Automatic authorization requires actual positive external checks and known required policy")
                if stage == "candidate":
                    review = item.get("evidence", {}).get("review_result") or {}
                    require(review.get("ready") is True,
                            "Independent review is not green")
                    validation = item.get("evidence", {}).get("validation_result") or {}
                    require(validation.get("checks_performed") is True and validation.get("green") is True,
                            "No positive applicable project checks")
                    self.bounded_diff(self.state["base_sha"], item["candidate"], policy)
            require(self.state["phase"] != "held", "Queue guard held the candidate chain")
        except (ValueError, OSError, KeyError) as error:
            reasons.append(str(error))
        decision: PolicyDecision = {"kind": "human_required" if reasons else "automatic_policy", "stage": stage,
                                    "source_policy_hash": source["source_policy_hash"], "snapshot": snapshot, "reasons": reasons}
        return decision

    def order_snapshot(self):
        if "assessment" not in self.state:
            require(self.state["automatic_policy"]["policy"] is not None, "Missing independent diff assessment")
            # Missing model output stays missing. Only a human can authorize the
            # original intake order when assessment failed before producing one.
            self.state.update(assessment=None, order=[ref["number"] for ref in self.state["intake"]], phase="awaiting_order")
        snapshot = digest(self.order_plan())
        require(self.state.get("order_snapshot", snapshot) == snapshot, "Pinned intake or order changed")
        self.state["order_snapshot"] = snapshot
        decision = self.policy_decision("order", snapshot)
        require(self.state.get("order_decision", decision) == decision, "Order policy decision changed")
        self.state["order_decision"] = decision
        self.save()
        return {"snapshot": snapshot, "plan": self.order_plan(), "decision": decision,
                "human_required": decision["kind"] == "human_required"}

    def authorized(self, kind):
        receipt = self.state[kind + "_receipt"]
        return receipt is not None and (receipt.get("kind") == "automatic_policy" or
                                       receipt.get("response", {}).get("decision") == "approve")

    def approved_order(self):
        require(digest(self.order_plan()) == self.state["order_snapshot"], "Pinned intake or order changed")
        assessment = self.state["assessment"]
        expected = assessment["order"] if assessment is not None else [ref["number"] for ref in self.state["intake"]]
        require(self.state["order"] == expected, "Approved order changed")

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
        self.state["automatic_policy"] = self.read_policy()
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
        require(all(j.get("size") in COMPLEXITIES and isinstance(j.get("reason"), str)
                    and j["reason"].strip() for j in judgments), "Invalid size or missing order reasons")
        if "assessment" in self.state:
            require(self.state["assessment"] == assessment, "Assessment is immutable on resume")
        else:
            self.state.update(assessment=assessment, order=order, phase="awaiting_order")
            self.save()
        if not self.state["automatic_policy"]["policy"]:
            return self.order_snapshot()
        return {"assessment": assessment}

    def ordered(self):
        return [next(i for i in self.state["items"] if i["pr"]["ref"]["number"] == n) for n in self.state["order"]]

    def hold(self, reason, start=0):
        for item in self.ordered()[start:]:
            if item["status"] != "merged":
                item.update(status="held", reason=reason)
        self.state["phase"] = "held"
        self.save()

    def gate(self, kind, receipt, snapshot):
        decision = self.state[kind + "_decision"]
        require(decision["snapshot"] == snapshot == self.state[kind + "_snapshot"], "Approval snapshot changed")
        if receipt is None:
            require(decision["kind"] == "automatic_policy", "A genuine native human gate is required")
            require(self.policy_decision(kind, snapshot) == decision, "Automatic policy authorization changed")
            self.approved_order()
            if kind == "candidate":
                require(self.chain() == self.state["candidate_chain"], "Candidate chain changed after gate")
                self.verify_evidence()
            existing = self.state[kind + "_receipt"]
            require(existing is None or existing == decision, "Policy receipt is immutable")
            if existing is not None:
                return {"proceed": self.state["phase"] not in ("held", "failed")}
            self.state[kind + "_receipt"] = decision
            self.state["phase"] = "preparing" if kind == "order" else "merging"
            self.save()
            return {"proceed": True}
        require(isinstance(receipt, dict) and receipt.get("decision") in ("approve", "hold")
                and isinstance(receipt.get("text"), str), "Expected a declared native gate receipt; prose is not approval")
        self.approved_order()
        existing = self.state[kind + "_receipt"]
        if existing is not None:
            require(existing == {"response": receipt, "snapshot": snapshot}, "Gate receipt is immutable")
            return {"proceed": self.state["phase"] not in ("held", "failed")}
        if kind == "candidate":
            require(self.chain() == self.state["candidate_chain"], "Candidate chain changed after gate")
        if kind == "candidate" and self.state["phase"] == "held":
            # A human sees the failed evidence, but cannot waive a merge guard.
            self.state["candidate_receipt"] = {"response": receipt, "snapshot": snapshot}
            self.save()
            return {"proceed": False}
        if kind == "candidate":
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
        if self.state["automatic_policy"]["policy"]:
            require(record == item["pr"], "PR source context changed")
            triage = item.get("triage")
            if triage and triage["source"]:
                source = self.read_cli(["forge", "workitem", "view", "--request", "-"], {"ref": triage["source"]["ref"]})
                require(source == triage["source"], "Original work-item context changed")
        require(self.remote_base(self.state["base"]) == base, "Upstream base changed; reapproval requires a fresh reviewed queue")
        return self.checks(item)

    def prepare(self):
        require(self.authorized("order"), "Order is not approved")
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
            source = (item.get("triage") or {}).get("source")
            return {"run": True, "number": item["pr"]["ref"]["number"], "candidate": item["candidate"],
                    "local_range": base + ".." + item["candidate"], "work_order": source["body"] if source else item["pr"].get("body", ""),
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
            return self.held_snapshot()
        try:
            self.approved_order()
            self.verify_evidence()
        except (ValueError, OSError, KeyError) as error:
            self.hold("Candidate evidence is incomplete: " + str(error))
            return self.held_snapshot()
        chain = self.chain()
        if "candidate_chain" in self.state:
            require(chain == self.state["candidate_chain"] and digest(chain) == self.state["candidate_snapshot"],
                    "Candidate snapshot is immutable")
            return self.candidate_output(True)
        self.state.update(candidate_chain=chain, candidate_snapshot=digest(chain), phase="awaiting_candidates")
        self.state["candidate_decision"] = self.policy_decision("candidate", digest(chain))
        self.save()
        return self.candidate_output(True)

    def held_snapshot(self):
        if not self.state["automatic_policy"]["policy"] or not self.authorized("order"):
            return {"ready": False, "human_required": False}
        chain = self.chain()
        require(self.state.get("candidate_snapshot", digest(chain)) == digest(chain), "Held candidate snapshot is immutable")
        self.state.update(candidate_chain=chain, candidate_snapshot=digest(chain))
        self.state["candidate_decision"] = self.policy_decision("candidate", digest(chain))
        self.save()
        return self.candidate_output(False)

    def candidate_output(self, ready):
        return {"ready": ready, "snapshot": self.state["candidate_snapshot"], "chain": self.state["candidate_chain"],
                "decision": self.state["candidate_decision"],
                "human_required": self.state["candidate_decision"]["kind"] == "human_required"}

    def merge(self):
        require(self.authorized("candidate"), "Candidates not approved")
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
            self.verify_policy()
            if self.state["candidate_receipt"].get("kind") == "automatic_policy":
                require(self.policy_decision("candidate", self.state["candidate_snapshot"]) == self.state["candidate_receipt"],
                        "Automatic candidate authorization changed")
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
                "order_decision": self.state.get("order_decision"), "candidate_decision": self.state.get("candidate_decision"),
                "entries": [{"ref": i["pr"]["ref"], "status": i["status"], "reason": i.get("reason", ""),
                             "candidate": i.get("candidate"), "correction": i.get("correction")}
                            for i in self.state["items"]]}


def main():
    queue = Queue(Path.cwd(), os.environ["ARTIFACTS_DIR"], os.environ["WORKFLOW_ID"])
    def value(name, default=None, raw=False):
        text = os.environ.get("INPUTS_" + name.upper(), json.dumps(default))
        return text if raw else json.loads(text)
    action = os.environ["INPUTS_ACTION"]
    if queue.state:
        require(value("prs") == queue.state["intake"], "Intake is immutable on resume")
    if action == "intake":
        result = queue.intake(value("prs"))
    elif action == "assess":
        result = queue.assess(value("assessment"))
    elif action == "triage-prepare":
        result = queue.triage_prepare()
    elif action == "triage-record":
        result = queue.triage_record(value("prepared"), value("triage"))
    elif action == "order-snapshot":
        result = queue.order_snapshot()
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
