"""Choose what this lifecycle run works on.

An explicit target wins unchanged. With none, choose the oldest open issue with
none of the caller-configured state labels, no open pull request claiming it,
and no open dependency. Without every state label automatic intake stops safely
because it cannot distinguish all touched work. Deterministic gh reads only;
judgment belongs to triage.

Dependencies use the backlog's `Depends on: #<n>` lines; `owner/repo#<n>` and
full issue or pull request URLs count when they name this repository, and
references to other repositories are left to triage. A dependency is open while
that number is an open issue or pull request. An issue whose only state label is
the mapped BLOCKED label and which declares dependencies becomes a candidate
again once all of them are closed; triage then replaces the label. A BLOCKED
issue with no declared dependency waits on something intake cannot see, so it
stays touched.

A pull request claims issue N only with a closing keyword (`Closes`, `Fixes`,
`Resolves` and their forms) or the pack's own `Relates to`, followed by a
reference to this repository. A bare `#N` mention does not claim anything.

Unfinished work comes before new work. Before choosing an issue, automatic intake
looks for a pull request an earlier run delivered but never merged: open, from
this repository, carrying the pack's review report comment, claiming an open
issue whose dependencies are closed, untouched for `redrive_after_minutes`, and
re-driven fewer than `redrive_limit` times (each attempt leaves a re-drive
comment). The oldest such pull request is returned with `kind: pr`; the caller
brings it up to date and finishes it instead of leaving its issue claimed and
everything behind it waiting. `redrive_limit` 0 turns this off.
"""

import json
import os
import re
import subprocess
import sys
from datetime import datetime, timedelta, timezone


STATES = {"READY", "DESIGN_FIRST", "NEEDS_CONTRACT_WORK", "BLOCKED", "NO_ACTION"}

# gh paginates internally; the limit only has to exceed any real backlog.
LIMIT = "100000"
REVIEW_MARKER = "<!-- archon-review-report -->"
REDRIVE_MARKER = "<!-- archon-redrive -->"
PR_FIELDS = "number,title,body,url,isDraft,isCrossRepository,updatedAt,comments"
DEPENDS = re.compile(r"^[ \t]*depends on:(.*)$", re.IGNORECASE | re.MULTILINE)
CLAIM_KEYWORD = r"\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|relates\s+to)\s*:?\s+"
# One reference to an issue or pull request: its URL, `owner/repo#n`, or `#n`.
REFERENCE = (
    r"(?:https?://[^\s/]+/(?P<url_repo>[\w.-]+/[\w.-]+)/(?:issues|pull)/(?P<url_number>\d+)"
    r"|(?<![\w/.#-])(?:(?P<short_repo>[\w.-]+/[\w.-]+))?#(?P<number>\d+))\b"
)


def gh(*args: str):
    out = subprocess.run(["gh", *args], check=True, capture_output=True, text=True).stdout
    return json.loads(out) if out.strip() else []


def state_labels() -> tuple[set[str], str | None, bool]:
    value = json.loads(os.environ.get("INPUTS_STATE_LABELS", "{}"))
    if not isinstance(value, dict) or any(key not in STATES for key in value):
        raise ValueError("state_labels must be a JSON object with supported state keys")
    labels = list(value.values())
    if any(not isinstance(label, str) or not label or label.strip() != label or len(label) > 50
           or any(ord(char) < 32 for char in label)
           for label in labels):
        raise ValueError("state_labels values must be non-empty GitHub label names")
    folded = {label.casefold() for label in labels}
    if len(folded) != len(labels):
        raise ValueError("state_labels must not map multiple states to the same label")
    blocked = value.get("BLOCKED")
    return folded, blocked.casefold() if blocked else None, set(value) == STATES


def references(text: str, repo: str, prefix: str = "") -> set[int]:
    """Numbers referenced in this repository; references elsewhere are ignored."""
    found = set()
    for match in re.finditer(prefix + REFERENCE, text, re.IGNORECASE):
        other = match.group("url_repo") or match.group("short_repo")
        if other and other.casefold() != repo.casefold():
            continue
        found.add(int(match.group("url_number") or match.group("number")))
    return found


def dependencies(body: str, repo: str) -> set[int]:
    return set().union(*(references(line, repo) for line in DEPENDS.findall(body or "")))


def roots(blockers: set[int], open_needs: dict[int, set[int]]) -> set[int]:
    """The open dependencies a chain is actually stuck behind: those not waiting
    on anything open themselves. A pure cycle reports its members."""
    found, seen, stack = set(), set(), list(blockers)
    while stack:
        number = stack.pop()
        if number in seen:
            continue
        seen.add(number)
        if open_needs.get(number):
            stack.extend(open_needs[number])
        else:
            found.add(number)
    return found or seen


def redrive_settings() -> tuple[int, float]:
    limit = os.environ.get("INPUTS_REDRIVE_LIMIT", "").strip() or "2"
    after = os.environ.get("INPUTS_REDRIVE_AFTER_MINUTES", "").strip() or "30"
    if not limit.isdigit():
        raise ValueError("redrive_limit must be a whole number")
    try:
        minutes = float(after)
    except ValueError:
        raise ValueError("redrive_after_minutes must be a number") from None
    if minutes < 0:
        raise ValueError("redrive_after_minutes must not be negative")
    return int(limit), minutes


def bodies(pr: dict) -> list[str]:
    return [str(comment.get("body") or "") for comment in pr.get("comments") or []
            if isinstance(comment, dict)]


def idle_since(pr: dict, minutes: float) -> bool:
    stamp = str(pr.get("updatedAt") or "")
    try:
        updated = datetime.fromisoformat(stamp.replace("Z", "+00:00"))
    except ValueError:
        return False
    if updated.tzinfo is None:
        updated = updated.replace(tzinfo=timezone.utc)
    return datetime.now(timezone.utc) - updated >= timedelta(minutes=minutes)


def redrivable(prs: list[dict], repo: str, issue_urls: dict[int, str],
               open_needs: dict[int, set[int]], limit: int, minutes: float) -> tuple[dict, int] | None:
    """The oldest pull request a run delivered but nobody merged, with its issue."""
    if limit <= 0:
        return None
    found = []
    for pr in prs:
        if pr.get("isCrossRepository") or not pr.get("url"):
            continue
        comments = bodies(pr)
        if not any(body.lstrip().startswith(REVIEW_MARKER) for body in comments):
            continue
        if sum(body.lstrip().startswith(REDRIVE_MARKER) for body in comments) >= limit:
            continue
        if not idle_since(pr, minutes):
            continue
        claims = references(f"{pr.get('title') or ''}\n{pr.get('body') or ''}", repo, CLAIM_KEYWORD)
        issues = sorted(number for number in claims
                        if number in issue_urls and not (open_needs.get(number, set()) - {pr["number"]}))
        if issues:
            found.append((pr, issues[0]))
    return min(found, key=lambda item: item[0]["number"]) if found else None


def emit(target: str, found: bool, selected: bool, reason: str, waiting_on: list[int],
         open_issues: int, kind: str = "issue", pr: str = "") -> int:
    print(json.dumps({"target": target, "found": found, "selected": selected, "reason": reason,
                      "waiting_on": waiting_on, "open_issues": open_issues, "kind": kind,
                      "pr": pr}))
    return 0


def repository(issues: list[dict]) -> str:
    match = re.match(r"https?://[^/]+/([^/]+/[^/]+)/issues/\d+", issues[0]["url"]) if issues else None
    return match.group(1) if match else ""


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8", newline="\n")
    owned_labels, blocked_label, complete_mapping = state_labels()
    limit, minutes = redrive_settings()
    explicit = os.environ.get("INPUTS_TARGET", "").strip()
    if explicit:
        return emit(explicit, True, False, "explicit target", [], 0)
    if not complete_mapping:
        return emit("", False, True, "automatic intake requires state_labels for every state", [], 0)
    issues = gh("issue", "list", "--state", "open", "--limit", LIMIT,
                "--json", "number,url,labels,body")
    prs = gh("pr", "list", "--state", "open", "--limit", LIMIT, "--json", PR_FIELDS)
    repo = repository(issues)
    open_numbers = {issue["number"] for issue in issues} | {pr["number"] for pr in prs}
    claimed = set().union(*(references(f"{pr.get('title') or ''}\n{pr.get('body') or ''}",
                                       repo, CLAIM_KEYWORD) for pr in prs))
    open_needs = {issue["number"]: dependencies(issue.get("body"), repo) & open_numbers
                  for issue in issues}
    unfinished = redrivable(prs, repo, {issue["number"]: issue["url"] for issue in issues},
                            open_needs, limit, minutes)
    if unfinished:
        pr, number = unfinished
        url = next(issue["url"] for issue in issues if issue["number"] == number)
        return emit(url, True, True, f"unfinished pull request #{pr['number']} for #{number}",
                    [], len(issues), "pr", pr["url"])
    candidates = []
    waiting_on: set[int] = set()
    for issue in issues:
        if issue["number"] in claimed:
            continue
        labels = {label.get("name", "").casefold() for label in issue.get("labels", [])}
        state = labels & owned_labels
        needs = dependencies(issue.get("body"), repo)
        if state and not (state == {blocked_label} and needs):
            continue
        blockers = needs & open_numbers
        if blockers:
            waiting_on |= roots(blockers, open_needs)
            continue
        candidates.append(issue)
    if not candidates:
        reason = f"{len(issues)} open issue(s), none untouched"
        if waiting_on:
            reason += "; stalled behind open dependencies " + ", ".join(f"#{n}" for n in sorted(waiting_on))
        return emit("", False, True, reason, sorted(waiting_on), len(issues))
    chosen = min(candidates, key=lambda issue: issue["number"])
    return emit(chosen["url"], True, True, f"oldest ready open issue of {len(candidates)}",
                sorted(waiting_on), len(issues))


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        print(f"select-target: {error}", file=sys.stderr)
        sys.exit(1)
