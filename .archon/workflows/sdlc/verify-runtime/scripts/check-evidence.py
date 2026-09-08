"""Judge one verification attempt. The only place any of this workflow's
verdict is decided.

Never trusts a self-reported pass count or a prose marker: the verdict is
recomputed from each assertion's own `ok` field, and only after every
structural check below passes. A report that claims all-green but is missing
required coverage, restates a claim instead of observing it, or points at
on-disk evidence that does not exist is `malformed`, not `verified` — receipt
presence is not success. `status` distinguishes four outcomes the loop and the
final gate need to tell apart:

- `unavailable` — the declared environment never came up; nothing was judged.
- `malformed`   — the report is not trustworthy evidence (bad shape, missing
                  coverage, an unobserved claim, absent evidence, or a
                  candidate mismatch). The ONLY status the retry loop above
                  acts on — `until_bash` continues exactly while this is
                  `malformed`, and stops for every other value. An ordinary
                  failed assertion is never routed here.
- `failed`      — every structural check passed; at least one assertion's own
                  `ok` was not true. Evidence-backed, not retried.
- `verified`    — every structural check passed and every assertion was true.

Bound inputs (`with:` bindings, canonical text/JSON in env):
- INPUTS_START_OK: whether the declared environment came up ('true'/'false').
- INPUTS_CANDIDATE: the agent's own reported candidate identity (may be '').
- INPUTS_ASSERTIONS_RAW: JSON array the agent reported (may be '[]').
- INPUTS_REQUIRED_IDS: JSON array of assertion ids the scenario declared.
- INPUTS_REQUIRED_DESCRIPTIONS: JSON object, id -> declared description.
- INPUTS_CANDIDATE_COMMAND: the shell command that names the running
  candidate (read-scenario.py already defaults this to `git rev-parse HEAD`).
- INPUTS_EXPECTED_CANDIDATE: caller-declared expected identity, or ''.
"""

import json
import os
import subprocess
import sys

# Borrowed directly from the prior harness's stoplist (agentcheck.py's
# _EMPTY_ANSWERS): trivial restatements that are not an observation.
_EMPTY_ANSWERS = {
    "as expected",
    "ok",
    "pass",
    "passed",
    "yes",
    "works",
    "n/a",
    "none",
    "looks good",
    "correct",
    "success",
    "true",
    "done",
}


def emit(status: str, reason: str, candidate: str = "") -> int:
    print(json.dumps({"status": status, "reason": reason, "candidate": candidate}))
    return 0


def resolve_evidence_path(path: str) -> str:
    return path if os.path.isabs(path) else os.path.join(os.getcwd(), path)


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8", newline="\n")
    sys.stderr.reconfigure(encoding="utf-8", newline="\n")

    if os.environ.get("INPUTS_START_OK", "false").strip() != "true":
        return emit(
            "unavailable",
            "the declared environment did not come up (see the start-run node's "
            "log for the project command's own diagnostic)",
        )

    try:
        assertions = json.loads(os.environ.get("INPUTS_ASSERTIONS_RAW") or "[]")
    except json.JSONDecodeError:
        return emit("malformed", "the assertions payload was not valid JSON")

    required_ids = json.loads(os.environ["INPUTS_REQUIRED_IDS"])
    required_descriptions = json.loads(os.environ["INPUTS_REQUIRED_DESCRIPTIONS"])

    if not isinstance(assertions, list) or len(assertions) == 0:
        return emit("malformed", "the report declared zero assertions")

    seen: set[str] = set()
    for entry in assertions:
        if not isinstance(entry, dict):
            return emit("malformed", "an assertion entry was not a JSON object")
        for key in ("id", "ok", "observed", "evidence_path"):
            if key not in entry:
                return emit("malformed", f"an assertion entry is missing required field '{key}'")
        aid = entry["id"]
        if not isinstance(aid, str) or not aid:
            return emit("malformed", "an assertion entry had a non-string or empty id")
        if aid in seen:
            return emit("malformed", f"duplicate assertion id in the report: '{aid}'")
        seen.add(aid)
        if aid not in required_ids:
            return emit("malformed", f"assertion id '{aid}' is not part of the declared scenario")
        if not isinstance(entry["ok"], bool):
            return emit("malformed", f"assertion '{aid}' has a non-boolean 'ok'")

        observed = str(entry["observed"]).strip()
        if not observed:
            return emit("malformed", f"assertion '{aid}' reported empty observed evidence")
        lowered = observed.lower()
        if lowered in _EMPTY_ANSWERS or lowered == aid.lower():
            return emit(
                "malformed",
                f"assertion '{aid}' restates the claim instead of reporting an "
                f"observation: '{observed}'",
            )
        description = str(required_descriptions.get(aid, "")).strip().lower()
        if description and lowered == description:
            return emit(
                "malformed",
                f"assertion '{aid}' observed text is identical to its declared "
                "description, not an independent observation",
            )

        evidence_path = str(entry["evidence_path"]).strip()
        if not evidence_path:
            return emit("malformed", f"assertion '{aid}' declared no evidence file")
        resolved = resolve_evidence_path(evidence_path)
        if not os.path.isfile(resolved):
            return emit(
                "malformed",
                f"assertion '{aid}' evidence file does not exist on disk: {evidence_path}",
            )
        if os.path.getsize(resolved) == 0:
            return emit("malformed", f"assertion '{aid}' evidence file is empty: {evidence_path}")

    missing = sorted(set(required_ids) - seen)
    if missing:
        return emit("malformed", f"missing required assertion coverage: {', '.join(missing)}")

    candidate = os.environ.get("INPUTS_CANDIDATE", "").strip()
    if not candidate:
        return emit("malformed", "the report did not declare an observed candidate identity")

    candidate_command = os.environ.get("INPUTS_CANDIDATE_COMMAND", "").strip() or "git rev-parse HEAD"
    try:
        ground_truth = subprocess.run(
            candidate_command,
            shell=True,
            capture_output=True,
            text=True,
            timeout=30,
            check=True,
        ).stdout.strip()
    except (OSError, subprocess.SubprocessError) as exc:
        return emit(
            "unavailable",
            f"could not independently determine the candidate identity via "
            f"'{candidate_command}': {exc}",
        )

    if not ground_truth:
        return emit(
            "unavailable",
            f"the candidate-identity command produced no output: '{candidate_command}'",
        )

    if candidate != ground_truth:
        return emit(
            "malformed",
            f"the report's candidate '{candidate}' does not match the "
            f"independently observed candidate '{ground_truth}'",
            candidate,
        )

    expected_candidate = os.environ.get("INPUTS_EXPECTED_CANDIDATE", "").strip()
    if expected_candidate and expected_candidate != ground_truth:
        return emit(
            "malformed",
            f"the target is running candidate '{ground_truth}', not the expected "
            f"'{expected_candidate}'",
            candidate,
        )

    failed_ids = sorted(entry["id"] for entry in assertions if entry["ok"] is not True)
    if failed_ids:
        return emit(
            "failed",
            f"assertions did not pass: {', '.join(failed_ids)}",
            candidate,
        )

    return emit(
        "verified",
        f"every declared assertion passed with real, distinct, on-disk evidence "
        f"({len(assertions)} of {len(required_ids)})",
        candidate,
    )


if __name__ == "__main__":
    sys.exit(main())
