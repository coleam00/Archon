"""Real Git/computation fixtures; agents and public forge CLI transport are simulated."""
import importlib.util
import contextlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import sqlite3


script, root, scenario, phase = sys.argv[1:]
root = Path(root)
spec = importlib.util.spec_from_file_location("queue_script", script)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def git(cwd, *args, data=None):
    result = subprocess.run(["git", *args], cwd=cwd, input=data.encode() if data is not None else None, capture_output=True)
    assert result.returncode == 0, (args, result.stderr)
    return result.stdout.decode().strip()


seed = root / "seed"
automatic = scenario.startswith("auto_")
auto_policy = {"version": 1, "mode": "automatic", "max_prs": 5, "max_files": 10, "max_changed_lines": 300}
if scenario == "auto_batch_threshold":
    auto_policy["max_prs"] = 1
if scenario == "auto_threshold":
    auto_policy["max_changed_lines"] = 1
if scenario == "auto_cumulative_threshold":
    auto_policy["max_changed_lines"] = 3
if scenario == "auto_unknown_policy":
    auto_policy["version"] = 2
if scenario == "auto_unsafe_path":
    auto_policy["path"] = "../caller.json"
if scenario == "auto_malformed_policy":
    auto_policy["max_files"] = True
if scenario == "auto_hard_bound":
    auto_policy["max_prs"] = 6


def commit(a, b, parent=None, policy=False):
    lines = []
    for name, value in (("a.txt", a), ("b.txt", b)):
        blob = git(seed, "hash-object", "-w", "--stdin", data=str(value) + "\n")
        lines.append(f"100644 blob {blob}\t{name}\n")
    check = "from pathlib import Path\na = int(Path('a.txt').read_text())\nb = int(Path('b.txt').read_text())\n"
    check += f"print(f'composition: a={{a}}, b={{b}}')\nassert a + b <= {1 if scenario == 'joint_red' else 2}\n"
    check_blob = git(seed, "hash-object", "-w", "--stdin", data=check)
    lines.append(f"100644 blob {check_blob}\tcheck.py\n")
    if policy:
        policy_data = json.dumps(auto_policy) if automatic else '{"external_ci":"none"}'
        if automatic and parent and scenario == "auto_policy_changed":
            policy_data = json.dumps({**auto_policy, "max_files": 9})
        if scenario == "auto_duplicate_policy":
            policy_data = policy_data[:-1] + ', "mode":"automatic"}'
        blob = git(seed, "hash-object", "-w", "--stdin", data=policy_data)
        name = "merge-queue-auto.json" if automatic else "merge-queue-policy.json"
        mode = "120000" if scenario == "auto_symlink_policy" else "100644"
        policy_lines = f"{mode} blob {blob}\t{name}\n"
        if scenario == "auto_no_ci_exemption":
            exemption = git(seed, "hash-object", "-w", "--stdin", data='{"external_ci":"none"}')
            policy_lines += f"100644 blob {exemption}\tmerge-queue-policy.json\n"
        subtree = git(seed, "mktree", data=policy_lines)
        lines.insert(0, f"040000 tree {subtree}\t.archon\n")
    tree = git(seed, "mktree", data="".join(lines))
    return git(seed, "commit-tree", tree, *(["-p", parent] if parent else []), "-m", f"Fixture {a} {b}")


remote = root / "remote.git"
checkout = root / "queue"
artifacts = root / "artifacts"
manifest = root / "graph.json"
if phase == "setup":
    seed.mkdir(parents=True)
    git(seed, "init", "-b", "base")
    git(seed, "config", "user.name", "Queue Fixture")
    git(seed, "config", "user.email", "queue@example.invalid")
    policy = scenario == "no_ci_policy" or (automatic and scenario != "auto_absent_policy")
    base = commit(0, 0, policy=policy)
    head1 = commit(1, 0, base, policy=policy)
    head2 = commit(2, 0, base) if scenario == "conflict" else commit(0, 1, base, policy=policy)
    for name, sha in (("base", base), ("one", head1), ("two", head2)):
        git(seed, "update-ref", "refs/heads/" + name, sha)
    git(seed, "clone", "--bare", str(seed), str(remote))
    git(seed, "remote", "add", "origin", str(remote))
    git(seed, "worktree", "add", "-b", "archon/task-queue", str(checkout), base)
    artifacts.mkdir()
    manifest.write_text(json.dumps([base, head1, head2]))
    sys.exit(0)
base, head1, head2 = json.loads(manifest.read_text())
repo = {"host": "example.test", "path": "team/project"}
refs = [{"repo": repo, "number": n} for n in (1, 2)]
records = [{"ref": ref, "url": f"https://example.test/team/project/pulls/{ref['number']}",
            "head_repo": repo, "head": "one" if ref["number"] == 1 else "two", "base": "base",
            "head_sha": head1 if ref["number"] == 1 else head2, "is_draft": False,
            "state": "open", "title": "Fixture", "body": "Preserve composed a+b <= 1"} for ref in refs]
calls = []
transport_state = root / "transport.json"
transport_saved = json.loads(transport_state.read_text()) if transport_state.exists() else {}
merge_calls = transport_saved.get("merge_calls", [])
applied = transport_saved.get("applied", [])
records = transport_saved.get("records", records)
loss = scenario == "response_loss" and not applied
check_state = "green"
required_state = "green"
source_changed = False


def counts(state):
    result = {"total": 0, "green": 0, "red": 0, "pending": 0, "unknown": 0, "gated": 0}
    if state != "none":
        result["total"] = result[state] = 1
    return result


class FixtureQueue(module.Queue):
    def transport(self, args, request=None):
        global loss
        calls.append({"args": args, "request": request})
        if args[:2] == ["workflow", "get"]:
            if phase == "node":
                with sqlite3.connect(str(Path(os.environ["ARCHON_HOME"]) / "archon.db")) as database:
                    database.row_factory = sqlite3.Row
                    row = database.execute("SELECT id, workflow_name, working_path FROM remote_agent_workflow_runs WHERE id = ?", [args[2]]).fetchone()
                    assert row is not None
                    return 0, dict(row)
            return 0, {"id": "fixture", "workflow_name": "archon-merge-queue", "working_path": str(checkout)}
        if args[:2] == ["forge", "resolve"]:
            return 0, {"repo": repo, "forge": "fixture"}
        if args[:3] == ["forge", "pr", "view"]:
            return 0, json.loads(json.dumps(records[request["ref"]["number"] - 1]))
        if args[:3] == ["forge", "workitem", "view"]:
            ref = request["ref"]
            return 0, {"ref": ref, "url": f"https://github.com/{ref['repo']['path']}/issues/{ref['number']}",
                       "title": "Original arithmetic work order", "body": "Changed work order" if source_changed else
                       "Bound the arithmetic composition. Needed for current release. Preserve a+b <= 2; both checks pass.",
                       "state": "open"}
        if args[:2] == ["forge", "checks"]:
            ref = json.loads(args[3])
            sha = records[ref["number"] - 1]["head_sha"]
            result = {"head_sha": sha, "state": check_state, "counts": counts(check_state),
                      "units": [] if check_state == "none" else [{"name": "ci", "source": "native", "state": check_state}],
                      "required": {"state": required_state, "counts": counts(required_state)}}
            if scenario == "auto_unknown_required":
                result.pop("required")
            return 0, result
        assert args == ["forge", "pr", "merge-pinned", "--request", "-"]
        assert git(checkout, "rev-parse", "HEAD") == request["candidate_sha"]
        assert not git(checkout, "status", "--porcelain", "--untracked-files=all")
        merge_calls.append(request)
        result = {k: v for k, v in request.items() if k != "checkout"}
        if request in applied:
            return 0, dict(result, status="already_merged", publication="applied", cleanup="not_needed")
        if scenario == "failed_operation":
            return 1, {"kind": "forge_error", "evidence": "Simulated rejection", "recovery": dict(result, publication="not_attempted", cleanup="not_needed")}
        assert git(seed, "--git-dir", str(remote), "rev-parse", request["expected_base_ref"]) == request["expected_base_sha"]
        assert git(seed, "--git-dir", str(remote), "rev-parse", request["expected_head_ref"]) == request["expected_head_sha"]
        # Simulated forge publication over a real scratch git remote; production never pushes here.
        git(checkout, "push", "origin", request["candidate_sha"] + ":" + request["expected_base_ref"])
        applied.append(request.copy())
        records[request["ref"]["number"] - 1]["state"] = "merged"
        if loss:
            loss = False
            return 2, {"kind": "process_failure", "detail": "Simulated response lost after publication"}
        return 0, dict(result, status="merged", publication="applied", cleanup="not_needed")


def new_queue():
    return FixtureQueue(checkout, artifacts, os.environ["WORKFLOW_ID"] if phase == "node" else "fixture")


# Only the public CLI process transport is simulated. Exercise the production
# argv, JSON encoding/decoding, exit handling, and every queue computation.
original_command = module.command
wire = new_queue()
os.environ["ARCHON_EXECUTABLE"] = "fixture-archon"
os.environ["ARCHON_EXECUTABLE_ARGS"] = "[]"


def transport(argv, cwd, data=None):
    if argv[0] != "fixture-archon":
        return original_command(argv, cwd, data)
    assert argv[-1] == "--json"
    code, payload = wire.transport(argv[1:-1], json.loads(data) if data else None)
    transport_state.write_text(json.dumps({"merge_calls": merge_calls, "applied": applied, "records": records}))
    return subprocess.CompletedProcess(argv, code, json.dumps(payload), "")


module.command = transport
if phase == "node":
    module.main()
    sys.exit(0)


def rejected(fn, text):
    try:
        fn()
    except (ValueError, RuntimeError) as error:
        assert text in str(error), str(error)
    else:
        raise AssertionError("Expected rejection: " + text)


q = new_queue()
if automatic:
    if scenario in ("auto_no_external", "auto_no_ci_exemption"):
        check_state = required_state = "none"
    if scenario == "auto_unknown_required":
        required_state = "unknown"
    q.intake(refs)
    if scenario == "auto_absent_policy":
        (checkout / ".archon").mkdir()
        (checkout / module.AUTO_POLICY_PATH).write_text(json.dumps(auto_policy))
        assert q.read_policy()["policy"] is None
    assessment = {"order": [1, 2], "judgments": [{"number": n, "size": "risky" if scenario == "auto_risky" else
                  "large" if scenario == "auto_large" else "small_bounded", "reason": "Simulated independent diff judgment"} for n in (1, 2)]}
    q.assess(assessment)
    # Execute the shared contract validator too. Only the model verdict is simulated.
    triage_script = Path(__file__).resolve().parents[5] / ".archon/workflows/sdlc/triage/scripts/validate-contract.py"
    triage_spec = importlib.util.spec_from_file_location("triage_contract", triage_script)
    triage_owner = importlib.util.module_from_spec(triage_spec)
    triage_spec.loader.exec_module(triage_owner)
    for index in range(2):
        prepared = q.triage_prepare()
        if not prepared["run"]:
            break
        assert git(checkout, "rev-parse", "HEAD") == base
        (artifacts / "triage.md").write_text("Simulated fresh model triage at original base " + base +
                                             " for PR " + str(index + 1) + "; original issue " + str(index + 101))
        result = {"route": "deliver", "summary": "Simulated model read of original issue and pinned PR relationship",
                  "contract": "READY", "design_first": False, "complexity": "risky" if scenario == "auto_disagreement" else "small_bounded",
                  "proposed_edits": {"title": "", "body": ""}, "labels": ["archon-ready"], "blocked_by": [], "blocked_reason": "",
                  "issue_repo": "team/project", "issue_number": index + 101,
                  "issue_url": f"https://github.com/team/project/issues/{index + 101}"}
        if scenario in ("auto_ambiguous_workitem", "auto_context_gap"):
            result.update(contract="NO_ACTION", route="no_action", labels=["archon-close"], issue_repo="", issue_number=0, issue_url="")
        triage_owner.validate(result, str(artifacts))
        result["publication"] = {"published": False, "applied_labels": [], "skipped_labels": []}
        if scenario == "auto_missing_triage":
            (artifacts / "triage.md").unlink()
        q.triage_record(prepared, result)
        q = new_queue()
    order = q.order_snapshot()
    order_human = {"auto_absent_policy", "auto_unknown_policy", "auto_unsafe_path", "auto_malformed_policy",
                   "auto_hard_bound", "auto_duplicate_policy", "auto_symlink_policy", "auto_batch_threshold",
                   "auto_threshold", "auto_policy_changed", "auto_risky", "auto_large", "auto_disagreement",
                   "auto_ambiguous_workitem", "auto_context_gap", "auto_missing_triage", "auto_no_external",
                   "auto_unknown_required", "auto_no_ci_exemption"}
    assert order["human_required"] == (scenario in order_human), order
    if scenario in order_human:
        assert order["decision"]["kind"] == "human_required" and order["decision"]["reasons"]
        rejected(lambda: q.gate("order", None, order["snapshot"]), "genuine native human gate")
        if scenario != "auto_no_ci_exemption":
            assert not merge_calls
            print(json.dumps({"order": order, "calls": calls}))
            sys.exit(0)
        q.gate("order", {"decision": "approve", "text": "Supervised no-CI order"}, order["snapshot"])
    else:
        q.gate("order", None, order["snapshot"])
        assert q.state["order_receipt"] == order["decision"] and "response" not in q.state["order_receipt"]
    for index in range(2):
        prepared = q.prepare()
        assert prepared["run"], q.state
        review_dir = artifacts / "review"
        review_dir.mkdir(exist_ok=True)
        (review_dir / "scope.md").write_text(prepared["local_range"])
        (review_dir / "report.md").write_text("Simulated independent model review: " + prepared["candidate"])
        check = None if scenario == "auto_no_app_checks" else subprocess.run(
            [sys.executable, "check.py"], cwd=checkout, capture_output=True, text=True)
        assert check is None or check.returncode == 0
        summary = "No applicable project checks" if check is None else f"python check.py: exit {check.returncode}\n{check.stdout}"
        (artifacts / "validation.md").write_text(summary)
        q.record(prepared, None if scenario == "auto_missing_review" else
                 {"ready": scenario != "auto_failed_review", "action": "none", "findings_summary": "Simulated review"},
                 {"checks_performed": check is not None, "green": True, "red_cause": "", "summary": summary})
        if q.state["phase"] == "held":
            break
    snapshot = q.snapshot()
    if scenario in ("auto_failed_review", "auto_missing_review", "auto_no_app_checks", "auto_no_ci_exemption", "auto_cumulative_threshold"):
        assert snapshot["human_required"] and snapshot["decision"]["kind"] == "human_required", snapshot
        rejected(lambda: q.gate("candidate", None, snapshot["snapshot"]), "genuine native human gate")
        proceed = q.gate("candidate", {"decision": "approve", "text": "Human inspected failed evidence"}, snapshot["snapshot"])
        assert proceed["proceed"] == (scenario in ("auto_no_ci_exemption", "auto_cumulative_threshold"))
        assert not merge_calls
        print(json.dumps({"snapshot": snapshot, "calls": calls}))
        sys.exit(0)
    assert snapshot["ready"] and not snapshot["human_required"], snapshot
    q = new_queue()
    assert q.snapshot() == snapshot
    if scenario == "auto_stale_snapshot":
        q.state["candidate_chain"][0]["candidate"] = "0" * 40
        rejected(lambda: q.gate("candidate", None, snapshot["snapshot"]), "Candidate chain changed")
        assert not merge_calls
        sys.exit(0)
    if scenario == "auto_changed_evidence":
        (artifacts / next(iter(q.ordered()[0]["evidence"]["files"]))).write_text("Changed evidence")
        rejected(lambda: q.gate("candidate", None, snapshot["snapshot"]), "evidence changed")
        assert not merge_calls
        sys.exit(0)
    q.gate("candidate", None, snapshot["snapshot"])
    assert q.state["candidate_receipt"] == snapshot["decision"] and "response" not in q.state["candidate_receipt"]
    if scenario == "auto_stale_head":
        records[0]["head_sha"] = head2
    if scenario == "auto_stale_base":
        git(seed, "--git-dir", str(remote), "update-ref", "refs/heads/base", head2)
    if scenario == "auto_ci_changed":
        check_state = "red"
    if scenario == "auto_source_changed":
        source_changed = True
    if scenario == "auto_policy_snapshot_changed":
        q.state["automatic_policy"]["source_policy_hash"] = "0" * 40
    if scenario == "auto_input_changed":
        rejected(lambda: q.intake(list(reversed(refs))), "Intake is immutable")
        sys.exit(0)
    result = q.merge()
    if scenario in ("auto_stale_head", "auto_stale_base", "auto_ci_changed", "auto_source_changed", "auto_policy_snapshot_changed"):
        assert result["done"] and q.state["phase"] == "held" and not merge_calls, q.state
    else:
        assert not result["done"], q.state
        assert q.merge()["done"] and q.report()["merged"], q.state
        before = len(merge_calls)
        for _ in range(3):
            q = new_queue()
            assert q.merge()["done"]
        assert len(merge_calls) == before and len(applied) == 2
    print(json.dumps({"state": q.state, "calls": calls}))
    sys.exit(0)
if scenario == "malformed":
    for value in ([], [1], [{"repo": repo, "number": True}], refs * 3, refs + [refs[0]]):
        rejected(lambda: q.intake(value), "")
    print(json.dumps({"scenario": scenario, "calls": calls}))
    sys.exit(0)
if scenario == "mixed_repo":
    rejected(lambda: q.intake([refs[0], {"repo": {**repo, "path": "team/other"}, "number": 2}]), "Mixed repositories")
    sys.exit(0)
if scenario == "mixed_base":
    records[1]["base"] = "other"
    rejected(lambda: q.intake(refs), "Mixed base")
    sys.exit(0)
if scenario == "draft":
    records[1]["is_draft"] = True
    rejected(lambda: q.intake(refs), "open and ready")
    sys.exit(0)
q.intake(refs)
if scenario == "wrong_order":
    for order in ([1], [1, 1], [2, 3], [True, 2]):
        rejected(lambda: q.assess({"order": order}), "exact intake permutation")
    sys.exit(0)
assessment = {"order": [1, 2], "judgments": [{"number": n, "size": "risky", "reason": "Potential semantic overlap"} for n in (1, 2)]}
order_snapshot = {"snapshot": q.state["order_snapshot"]} if "order_snapshot" in q.state else q.assess(assessment)
receipt = {"decision": "approve", "text": "Reviewed exact snapshot"}
if scenario == "denied_order":
    q.gate("order", {"decision": "hold", "text": "Wait"}, order_snapshot["snapshot"])
    assert q.report()["phase"] == "held" and not merge_calls
    sys.exit(0)
if scenario == "prose_approval":
    rejected(lambda: q.gate("order", "approve", order_snapshot["snapshot"]), "native gate receipt")
    sys.exit(0)
previous_cwd = Path.cwd()
previous_env = os.environ.copy()
try:
    os.chdir(checkout)
    os.environ.update(ARTIFACTS_DIR=str(artifacts), WORKFLOW_ID="fixture", INPUTS_ACTION="order",
                      INPUTS_RECEIPT=json.dumps(receipt), INPUTS_SNAPSHOT=order_snapshot["snapshot"], INPUTS_PRS=json.dumps(refs))
    with contextlib.redirect_stdout(io.StringIO()) as output:
        module.main()
    assert json.loads(output.getvalue()) == {"proceed": q.state["phase"] not in ("held", "failed")}
finally:
    os.chdir(previous_cwd)
    os.environ.clear()
    os.environ.update(previous_env)
q = new_queue()
if phase == "intake":
    sys.exit(0)
if scenario in ("ci_none", "no_ci_policy"):
    check_state = required_state = "none"
if scenario == "ci_red":
    check_state = "red"
if scenario == "required_red":
    required_state = "red"
if scenario == "stale_head":
    records[0]["head_sha"] = head2
    q = new_queue()
if scenario == "stale_base":
    git(seed, "--git-dir", str(remote), "update-ref", "refs/heads/base", head2)
if scenario == "dirty":
    (checkout / "untracked.txt").write_text("preserve me")

# Simulated reviewers report their local scope; the actual project check below
# executes on each real composed tree, including an individually-green/jointly-red graph.
for index in ([0] if phase == "prepare1" else [1] if phase == "prepare2" else [] if phase.startswith("merge") or phase in ("recover", "replay") else range(2)):
    prepared = q.prepare()
    if not prepared["run"]:
        break
    candidate = prepared["candidate"]
    assert git(checkout, "show", "-s", "--format=%P", candidate).split() == [q.ordered()[index]["expected_base"], (head1, head2)[index]]
    review_dir = artifacts / "review"
    review_dir.mkdir(exist_ok=True)
    (review_dir / "scope.md").write_text(prepared["local_range"])
    (review_dir / "report.md").write_text("Simulated independent reviewer: " + candidate)
    a = int((checkout / "a.txt").read_text())
    b = int((checkout / "b.txt").read_text())
    check = None if scenario == "no_checks" else subprocess.run(
        [sys.executable, "check.py"], cwd=checkout, capture_output=True, text=True)
    green = check is None or check.returncode == 0
    if scenario == "joint_red":
        assert int(git(checkout, "show", head1 + ":a.txt")) + int(git(checkout, "show", head1 + ":b.txt")) <= 1
        assert int(git(checkout, "show", head2 + ":a.txt")) + int(git(checkout, "show", head2 + ":b.txt")) <= 1
    (artifacts / "validation.md").write_text("No checks performed" if check is None else
        f"python check.py: exit {check.returncode}\n{check.stdout}\n{check.stderr}")
    if scenario == "missing_evidence":
        (review_dir / "report.md").unlink()
    verdict = {"checks_performed": scenario != "no_checks", "green": green, "red_cause": "" if green else "introduced", "summary": "Real arithmetic composition check"}
    result = q.record(prepared, {"ready": True, "action": "none", "findings_summary": "Simulated agent"}, verdict)
    if result["done"]:
        break
if phase == "prepare1":
    sys.exit(0)
held = {"ci_none", "ci_red", "required_red", "stale_head", "stale_base", "dirty", "conflict", "joint_red", "missing_evidence", "no_checks"}
if scenario in held:
    assert q.state["phase"] == "held", q.state
    assert not merge_calls
    if scenario == "joint_red":
        assert q.ordered()[0]["status"] == "tested" and q.ordered()[1]["status"] == "held"
    if scenario == "conflict":
        assert q.ordered()[1]["correction"]["head_sha"] == head2
else:
    if phase == "prepare2":
        snapshot = q.snapshot()
        assert snapshot["ready"], q.state
        sys.exit(0)
    snapshot = q.candidate_output(True)
    if phase == "merge1":
        if scenario == "paused_resume":
            q = new_queue()
            assert q.state["phase"] == "awaiting_candidates" and not merge_calls
            assert q.snapshot() == snapshot
            q.state["candidate_chain"][0]["candidate"] = "0" * 40
            rejected(q.snapshot, "Candidate snapshot is immutable")
            q = new_queue()
        if scenario == "denied_candidates":
            q.gate("candidate", {"decision": "hold", "text": "Wait"}, snapshot["snapshot"])
            assert not q.report()["merged"] and q.state["phase"] == "held" and not merge_calls
            sys.exit(0)
        if scenario == "changed_evidence":
            (artifacts / next(iter(q.ordered()[0]["evidence"]["files"]))).write_text("Changed")
            rejected(lambda: q.gate("candidate", receipt, snapshot["snapshot"]), "evidence changed")
            assert not merge_calls
            sys.exit(0)
        q.gate("candidate", receipt, snapshot["snapshot"])
        if scenario == "paused_resume":
            assert q.snapshot() == snapshot and q.state["phase"] == "merging"
            q.state["candidate_receipt"]["snapshot"] = "changed"
            rejected(q.merge, "approval does not match")
            q = new_queue()
        if scenario == "base_after_gate":
            git(seed, "--git-dir", str(remote), "update-ref", "refs/heads/base", head2)
            assert q.merge()["done"] and q.state["phase"] == "held" and not merge_calls
            sys.exit(0)
        if scenario == "response_loss":
            rejected(q.merge, "did not return success")
            assert q.ordered()[0]["status"] == "uncertain"
        elif scenario == "failed_operation":
            assert q.merge()["done"]
            assert q.ordered()[0]["status"] == "failed" and q.ordered()[1]["status"] == "held" and not applied
        else:
            assert not q.merge()["done"]
    elif phase == "recover":
        assert not q.merge()["done"]
        assert merge_calls[0] == merge_calls[1]
    elif phase == "merge2":
        assert q.merge()["done"] and q.report()["merged"]
        assert q.ordered()[1]["merge_request"]["expected_base_sha"] == q.ordered()[0]["candidate"]
    elif phase == "replay":
        before = len(merge_calls)
        for _ in range(3):
            q = new_queue()
            assert q.merge()["done"]
        assert len(merge_calls) == before and len(applied) == 2
    else:
        raise AssertionError("Unknown fixture stage")

print(json.dumps({"scenario": scenario, "calls": calls, "state": q.state}))
