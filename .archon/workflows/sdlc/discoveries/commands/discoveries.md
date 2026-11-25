# Decide Each Discovery

A change landed. The runs that built it recorded discoveries: defects and gaps they proved outside their own change. Decide what becomes of each one, once, and make the writes your decisions need.

The repository: `$INPUTS.repo_host`/`$INPUTS.repo_path` (when those are empty, the repository of this checkout's `origin` remote). The item is `issue-$INPUTS.issue`. The base every claim is checked against is the landing branch after the merge: fetch `$BASE_BRANCH` from that repository's remote and use its head commit, called the base below.

## Read first

- What the item's runs recorded. The latest review's accepted records are its `discoveries`, certified by that review:

  $INPUTS.review

  The raw records are in each run's own artifacts: list the item's runs through the Archon CLI, whose argv is the JSON string array in `$ARCHON_CLI_COMMAND`, with `<argv...> workflow runs --item issue-$INPUTS.issue --json`, read each run's artifacts directory with `<argv...> workflow artifacts <run-id> --json` (`artifactsDir`), and read every `discoveries/*.json` and `discoveries.md` there. A raw record no review certified is still a claim to verify. Give each record a `ref` of the form `<run-id>:<index>` so a decision can name it.
- Decisions an operator already made on this item, oldest first: an answer to a question an earlier pass asked about these records decides the refs it covers.

  $INPUTS.answers

- The project's direction document, where it has one: at the root, in a config directory such as `.archon/`, or wherever its steering files point.
- The SDLC policy files this decision names, at `.archon/sdlc/policy/`, falling back to the pack's defaults. This decision names `discoveries.md`, `triage.md` and `rulings.md`; the pack's defaults are in `$PACK_DIR/.shared/policy/`. Read the default first, then the project's file when it exists: the project's file adds to the default, and where the two conflict, the project's line wins.
- The project's `engineering.md` and `architecture.md`, only when a decision depends on what they rule.

## Decide every record

For every record you read:

1. **Verify the claim at the base.** Read the code the evidence cites with `git show <base>:<path>` and `git grep <pattern> <base>`. A record's file:line evidence was true when its run wrote it; the base may have moved since. Do not run tests or probes: a claim you cannot settle by reading is unverified. A claim that does not hold at the base may be about an open pull request's change, such as code it adds or a guard it removes: look for that pull request with `workitem.search` (step 3) before you drop the claim as fixed or unverified.
2. **Apply earlier answers.** An answer above decides the refs its question covers: follow the answer rather than asking again.
3. **Search the tracker**, read-only: open and recently closed issues and pull requests that may already cover it. Use the Archon CLI, whose argv is the JSON string array in `$ARCHON_CLI_COMMAND`, as `<argv...> forge <op> --json --data '<request>'`, with `<repo>` = `{"host":…,"path":…}`. `workitem.search` takes `{"repo":<repo>,"text":"<terms>","state":"any"}`, with `"kind":"pr"` or `"issue"` to search one kind, and answers the most recently updated matches; `truncated` says more matched, and how the terms match is the forge's own search, so try more than one wording. A failed search is not an empty one: report it, and never repeat it through another tool. Read an issue and its comments (`workitem.view` with `{"ref":{"repo":<repo>,"number":<n>}}`, `workitem.comments` with `{"subject":{"kind":"issue","ref":…}}`) before you say it covers a record or that nothing does: the evidence an issue already holds is often in a comment, not its body. An issue this workflow filed starts with the marker `<!-- archon-discovery <key> -->`; one that describes the same defect is the same discovery, however differently it is worded.
4. **Merge duplicates.** Records from different runs, or several records in one run, that describe one defect are one decision: list every one of their refs under it. The policy says when separate defects may share one filed issue.
5. **Decide** under the policy.

Every record you read appears in exactly one decision, and every decision names at least one ref. Decide them all before you write anything.

## The outcomes

- `file` — a new issue. `title` is the issue title. `body` is the full brief the policy's File asks for, with the verified file:line evidence at the base. Write what is true at the base, not the run's history. File it with `workitem.create`, its body beginning with the marker line `<!-- archon-discovery <key> -->` and ending with the runs it came from; the forge recovers the issue an earlier pass filed with the same marker instead of filing it twice. Never label it: a maintainer decides whether it is triaged. At most three are filed in one pass, most valuable first; hold the rest, saying so.
- `track` — an open issue in this repository already covers it. Name the issue. The evidence the policy's Track lets you add, such as a new reproduction or a member of the defect class the issue does not list, is written to stand alone and posted with `workitem.comment.upsert` and the marker `<!-- archon-discovery-evidence <key> -->`; it replaces any earlier evidence comment for this key, so restate what still matters. When the policy says to post nothing, post nothing.
- `drop` — with a one-line `reason`.
- `ask` — only when the policy's Ask applies. Leave it as an ask, written as `asks.md` says, with enough context to answer it without opening the run and what you would do and why. The answers start this stage again.
- `wait` — only when the policy's Wait applies. Name that pull request in the one-line `reason`. Nothing is written; once the pull request merged or closed, a later pass decides the record against the base like any other.

Each decision also carries `key` and `title`. `key` is short kebab-case naming the defect, not the run, such as `cli-forge-test-inherits-workflow-id`; reuse the key of an issue this workflow already filed for the same defect, and track it on that issue rather than filing it again. `title` is one line naming the defect. Keep every `reason` to one line that a maintainer reading the outcome can check.

Write every forge request to a file under `$ARTIFACTS_DIR` and pass it with `--data-file`. A failed write is the answer: report it, and never repeat it through another tool.

Declare `outcome`: `ask` when you leave a question, otherwise `decided`; `decisions`, one per decision, each with its `outcome`, `key`, `title`, `refs`, `issue` (the URL filed or tracked, or the empty string) and one-line `reason`; `summary`: how many records you decided, and how many of each outcome, in two sentences; and `asks`, the questions you leave, or an empty list.

## Never

- Never write to `$ARTIFACTS_DIR/discoveries/`: anything there would be read as this run's own discovery.
- Never label, close or edit an issue, and never post anything but the writes above.
- Never decide from a record's prose alone: its evidence is a claim to verify at the base.
