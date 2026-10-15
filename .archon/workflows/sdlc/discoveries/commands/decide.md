# Decide Each Discovery

Finished runs recorded discoveries: defects and gaps they proved outside their own change. Decide what becomes of each one, once. You judge and author; the next node performs exactly the writes you declare and nothing else. You write nothing to the tracker, the repository or the state store yourself, and the checkout must be exactly as you found it when you finish.

The repository: `$INPUTS.repo_host/$INPUTS.repo_path`. The base commit every claim is checked against: `$INPUTS.base_sha`.

## Read first

- `$ARTIFACTS_DIR/drain/queue.json`: the queued runs and their undecided records. Each record has a `ref` of the form `<run-id>:<ref>`, a title, a claim and its evidence. `reviewed: true` means the run's review certified it; `false` is a raw record no review judged. Each run's `artifacts` directory holds the run's own report, `discoveries.md` and anything the evidence cites; open them when a record needs its context.
- `$ARTIFACTS_DIR/drain/discovery-decisions.md`: every decision made so far, one section per key, with its outcome, reason, the runs that found it, and any question asked with the maintainer's answer. This is your memory. Search it before deciding anything.
- The project's direction document, where it has one: at the root, in a config directory such as `.archon/`, or wherever its steering files point.
- The SDLC policy files this decision names, at `.archon/sdlc/policy/`, falling back to the pack's defaults. This decision names `discoveries.md`, `triage.md` and `rulings.md`; the pack's defaults are in `$INPUTS.policy_defaults`. A project's file replaces the default whole: when it exists, do not read the default.
- The project's `engineering.md` and `architecture.md`, only when a decision depends on what they rule.

## Decide every record

For every record in the queue:

1. **Verify the claim at the base.** Read the code the evidence cites with `git show $INPUTS.base_sha:<path>` and `git grep <pattern> $INPUTS.base_sha`. Never check out, switch, reset or edit anything. A record's file:line evidence was true when its run wrote it; the base may have moved since. Do not run tests or probes: a claim you cannot settle by reading is unverified.
2. **Check memory.** A key in `discovery-decisions.md` that describes the same defect is the same discovery, however differently it is worded. Use its key.
3. **Search the tracker**, read-only: open and recently closed issues and pull requests that may already cover it. On GitHub, `gh issue list --repo $INPUTS.repo_host/$INPUTS.repo_path --state all --search "<terms>"` and `gh pr list` with the same flags. Read an issue before you say it covers a record.
4. **Merge duplicates.** Records from different runs, or several records in one run, that describe one defect are one decision: list every one of their refs under it. Related defects that one change would fix may share one filed issue the same way.
5. **Decide** under the policy.

Every queued ref appears in exactly one decision, and every decision names at least one ref. A ref you were not given never appears. The next node refuses the whole pass, before any write, when this does not hold.

## The outcomes

- `file` — a new issue. `title` is the issue title. `body` is a full brief another run can start from: the problem, why it is worth solving, why now, the desired outcome, the invariants that must hold, and what acceptance looks like, with the verified file:line evidence at the base. Write what is true at the base, not the run's history. The workflow adds a marker line before it and the source runs after it.
- `track` — an open issue in this repository already covers it. Name the issue. `comment` is evidence the issue does not already hold, such as a new reproduction or a member of the defect class it does not list, written to stand alone; it replaces any earlier evidence comment for this key, so restate what still matters. Set `comment` to null when the record adds nothing: nothing is posted.
- `drop` — with a one-line `reason`.
- `ask` — only when the policy, rulings, direction and memory cannot decide it. `question` is what a maintainer must answer, with enough context to answer it without opening the run; `recommendation` is what you would do and why. A maintainer's earlier answer in memory that covers a similar item decides it: apply it rather than asking again. Every question in the pass reaches the maintainer as one attention item.

Each decision also carries `key` and `title`. `key` is short kebab-case naming the defect, not the run, such as `cli-forge-test-inherits-workflow-id`; reuse the memory key for a discovery memory already holds. A key that already has an issue in memory is never filed again: track it on that issue, or drop it. `title` is one line naming the defect. Keep every `reason` to one line that a maintainer reading the outcome can check.

Declare `summary`: how many records you decided, and how many of each outcome, in two sentences.

## Never

- Never write to `$ARTIFACTS_DIR/discoveries/`: anything there would be drained as this run's own discovery.
- Never post, file, label, close or comment yourself. The next node writes what you declared.
- Never decide from a record's prose alone: its evidence is a claim to verify at the base.
