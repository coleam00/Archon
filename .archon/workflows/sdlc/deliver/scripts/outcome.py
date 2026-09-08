"""The delivery tail's terminal report.

flip-ready owns the one irreversible public action and prints the ready pull
request's URL. This composes what the run's reader — usually an orchestrating
agent — actually receives, which is that URL plus whatever the review recorded
in the run's discovery sidecar.

Bound inputs (`with:` bindings, canonical text in env):
- INPUTS_PR_URL: flip-ready's output, the ready pull request's URL.
"""

import json
import os
import sys

DISCOVERY_RELAY = (
    "If you are an agent reading this: open discoveries.md and surface each discovery to your human. "
    "These are validated findings outside this run's scope — no issue tracker knows about them, "
    "and if you drop them here, nobody ever sees them."
)

RAW_DISCOVERY_RELAY = (
    "If you are an agent reading this: surface each record above to your human. "
    "These are findings this run proved outside its scope — no issue tracker knows about them, "
    "and if you drop them here, nobody ever sees them."
)


def format_discoveries(artifacts: str, failed: bool = False) -> str:
    """The discoveries section for a terminal report, or empty when there is nothing to report.

    Presentation only: discoveries never gate readiness, so a sidecar this
    cannot read must not fail a tail that has already done its irreversible work.
    A read or parse failure degrades to a one-line pointer at the file rather than
    to silence — the report's reader is exactly who needs to know it is there.
    Nothing is appended only when there is genuinely nothing to report: no sidecar,
    or no recorded discoveries. `title` is coerced rather than trusted: an agent
    writes these records from prose with no schema, and a JSON-legal non-string
    title must not raise past the caller and fail an already-delivered run.

    A FAILED run with no consolidated file never reached review, so the producers' own
    sidecars are the entire record — format_raw_discoveries owns that case. An
    EMPTY consolidated file is review's adjudication rather than a gap, so it stays
    silent, and a completed run's report keeps the same shape on every branch.

    Kept byte-identical across the three SDLC tails. A packaged script is
    materialized standalone, so there is no import channel to share it through.
    """
    disc_file = os.path.join(artifacts, "discoveries.json")
    if not os.path.isfile(disc_file):
        return format_raw_discoveries(artifacts) if failed else ""
    try:
        with open(disc_file, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError) as err:
        return f"\n\nDiscoveries: could not read {disc_file} ({err}). Open it directly."
    if not isinstance(data, list) or not data:
        return ""
    titles = [
        (str(d.get("title") or "").strip() if isinstance(d, dict) else "") or "(untitled discovery)"
        for d in data
    ]
    lines = "\n".join(f"- {t}" for t in titles)
    md_path = os.path.join(artifacts, "discoveries.md")
    return f"\n\nDiscoveries ({len(data)}):\n{lines}\n\nReport: {md_path}\n\n{DISCOVERY_RELAY}"


def format_raw_discoveries(artifacts: str) -> str:
    """The producer sidecars of a run that died before review consolidated them.

    A failed run is where a discovery matters most — the run often failed BECAUSE of
    what it found — and consolidation lives on the completion path only. So this
    reports the records exactly as their producers wrote them, says they were never
    validated, and adds nothing else: no second consolidator on a path that already
    failed. Records are read as defensively as the consolidated section is, and for
    the same reason: an agent wrote them from prose against no schema, and one
    malformed record must not raise past the last thing this run can say.

    Silent when there is nothing to report, like the consolidated section above:
    The contract is one section that exists only when discoveries do, and a failed
    run is not a reason to print an empty one.

    Kept byte-identical across the three SDLC tails.
    """
    disc_dir = os.path.join(artifacts, "discoveries")
    try:
        names = sorted(n for n in os.listdir(disc_dir) if n.endswith(".json"))
    except OSError:
        names = []
    lines = []
    unreadable = []
    for name in names:
        path = os.path.join(disc_dir, name)
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, ValueError) as err:
            unreadable.append(f"- {path}: could not read ({err}). Open it directly.")
            continue
        for record in data if isinstance(data, list) else []:
            if not isinstance(record, dict):
                continue
            title = str(record.get("title") or "").strip() or "(untitled discovery)"
            relation = str(record.get("relation") or "").strip() or "relation unstated"
            claim = str(record.get("claim") or "").strip()
            lines.append(f"- {title} [{relation}]" + (f"\n  {claim}" if claim else ""))
    if not lines and not unreadable:
        return ""
    body = "\n".join(lines + unreadable)
    return (
        f"\n\nUnconsolidated discoveries ({len(lines)}) — recorded by this run's nodes and "
        f"never validated or consolidated, because the run ended first:\n{body}\n\n"
        f"Raw records: {disc_dir}\n\n{RAW_DISCOVERY_RELAY}"
    )


RED_CAUSE_CAVEAT = (
    "The project's own checks did not pass locally on this branch. The pull request's "
    "own CI is the gate that still stands — read it before merging, and if the red is "
    "inherited, the base branch is what needs the fix."
)


def format_red_causes(artifacts: str) -> str:
    """The caveat for red this run's green gate deliberately let through.

    The gate fails on red the change introduced and passes red it cannot have caused,
    which is only a safe trade while every reader of this report meets the claim. A
    run whose gates never passed red has no record and prints nothing.

    Presentation, like the discoveries sections: an unreadable record degrades to a
    pointer rather than failing a tail that has already done its irreversible work.

    Kept byte-identical across the three SDLC tails.
    """
    path = os.path.join(artifacts, "red-causes.json")
    if not os.path.isfile(path):
        return ""
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError) as err:
        return f"\n\nDelivered on red: could not read {path} ({err}). Open it directly."
    lines = []
    for record in data if isinstance(data, list) else []:
        if not isinstance(record, dict):
            continue
        cause = str(record.get("cause") or "").strip() or "cause unstated"
        stage = str(record.get("stage") or "").strip() or "A stage"
        summary = str(record.get("summary") or "").strip()
        lines.append(f"- {stage}: {cause} red" + (f"\n  {summary}" if summary else ""))
    if not lines:
        return ""
    body = "\n".join(lines)
    return (
        f"\n\nDelivered on red ({len(lines)}) — a gate accepted red this change did "
        f"not cause:\n{body}\n\n{RED_CAUSE_CAVEAT}"
    )


def format_caveats(artifacts: str, failed: bool = False) -> str:
    """Everything a terminal report owes its reader beyond the result itself.

    Both sections exist because their channel is otherwise write-only — a gate that
    accepted red, and discoveries no consolidation ever reached.
    Composed in one place so a new branch in main() cannot print a report that
    quietly drops one.

    Kept byte-identical across the three SDLC tails.
    """
    return format_red_causes(artifacts) + format_discoveries(artifacts, failed)


def main() -> int:
    # Windows Python writes stdout in the console code page and rewrites '\n' as
    # '\r\n'. A terminal report is stored, posted to GitHub, and compared byte for
    # byte, so pin one encoding and one line ending on every platform.
    sys.stdout.reconfigure(encoding="utf-8", newline="\n")
    sys.stderr.reconfigure(encoding="utf-8", newline="\n")
    artifacts = os.environ["ARTIFACTS_DIR"]
    url = os.environ["INPUTS_PR_URL"].strip()
    if not url:
        print(
            "outcome: flip-ready reported no pull request URL."
            + format_caveats(artifacts, failed=True),
            file=sys.stderr,
        )
        return 1
    print(url + format_caveats(artifacts))
    return 0


if __name__ == "__main__":
    sys.exit(main())
