"""Strict fake for gh api. The real script owns all decisions and checks."""
import json
import os
import sys
from pathlib import Path
from urllib.parse import unquote

path = Path(os.environ["FAKE_GH_STATE"])
state = json.loads(path.read_text(encoding="utf-8"))
args = sys.argv[1:]
mode = os.environ.get("FAKE_GH_MODE", "")
assert args[:3] == ["api", "--hostname", "github.com"], args
endpoint = args[3]
assert endpoint.startswith("repos/explicit/other-repo/"), endpoint
state["calls"].append(args)
path.write_text(json.dumps(state), encoding="utf-8")
if "--method" in args:
    method = args[args.index("--method") + 1]
    if method in ("POST", "PUT"):
        assert args[-2:] == ["--input", "-"]
        payload = json.load(sys.stdin)
    if endpoint == "repos/explicit/other-repo/labels":
        assert method == "POST"
        if mode == "partial_create" and state["labels"]:
            sys.exit("synthetic create failure after one label")
        assert payload["name"] not in state["labels"], "duplicate label creation"
        state["labels"].append(payload["name"])
    else:
        label_endpoint = "repos/explicit/other-repo/issues/42/labels"
        if not state.get("written"):
            if mode == "concurrent_unrelated":
                state["issue_labels"].append("area:concurrent/cli,api")
            if mode == "concurrent_pack":
                state["issue_labels"].append("archon-close")
        if method in ("POST", "PUT"):
            assert endpoint == label_endpoint
            assert all(name in state["labels"] or name in state["issue_labels"] for name in payload["labels"])
            if mode != "noop_write":
                if method == "PUT":
                    state["issue_labels"] = payload["labels"]
                else:
                    state["issue_labels"] = sorted(set(state["issue_labels"]) | set(payload["labels"]))
        elif method == "DELETE":
            assert endpoint.startswith(label_endpoint + "/")
            encoded = endpoint[len(label_endpoint) + 1:]
            assert "/" not in encoded and "," not in encoded, "label path data must be URL encoded"
            name = unquote(encoded)
            assert name in state["issue_labels"], "404: label absent"
            if mode == "partial_remove":
                sys.exit("synthetic remove failure after addition")
            if mode not in ("noop_write", "retain_stale"):
                state["issue_labels"].remove(name)
        else:
            raise AssertionError(args)
        if mode == "drop_unrelated" and "unrelated-label" in state["issue_labels"]:
            state["issue_labels"].remove("unrelated-label")
        state["written"] = True
    path.write_text(json.dumps(state), encoding="utf-8")
    if mode == "write_then_fail" and state.get("written"):
        sys.exit("synthetic connection failure after write")
    print("{}")
elif endpoint.endswith("labels?per_page=100"):
    assert args[-2:] == ["--paginate", "--slurp"]
    entries = [{"name": n} for n in state["labels"]]
    print(json.dumps([[{}]] if mode == "malformed_labels" else [entries[i:i+100] for i in range(0, len(entries), 100)]))
else:
    assert endpoint == "repos/explicit/other-repo/issues/42"
    if mode == "read_failure" and state.get("written"):
        sys.exit("synthetic read-back failure")
    url = state["url"]
    if mode == "wrong_before" or (mode == "wrong_after" and state.get("written")):
        url = "https://github.com/origin/repo/issues/42"
    result = {"html_url": url, "number": state["number"], "labels": [{"name": n} for n in state["issue_labels"]]}
    if mode == "is_pr":
        result["pull_request"] = {}
    print(json.dumps(result))
