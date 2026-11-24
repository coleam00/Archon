# Split One Item, or Build It Whole

Break this item into the fewest pieces that each prove something on their own, or don't split it. Triage judged that building it as one work item would not work. Check that first: one run can plan and deliver a large change, and one pull request for one outcome is easier to review than several that only make sense together.

The item: issue number `$INPUTS.issue` in `$INPUTS.repo_host`/`$INPUTS.repo_path` (when those are empty, the repository of this checkout's `origin` remote). Read its title, body and comments yourself. A dated "Current scope" section in it overrides what it rules on.

Triage's reason for splitting is its `summary`, and its assessment is at its `report` path:

$INPUTS.triage

What the last split of this item ended with, `null` when this is the first: the issues it filed, by key, and the plan it left:

$INPUTS.earlier

Decisions an operator already made on this item, oldest first; where two disagree, the later one holds:

$INPUTS.answers

## Read first

- The triage policy: the pack's default in `$PACK_DIR/.shared/policy/triage.md`, then the project's `.archon/sdlc/policy/triage.md` when it exists, which adds to the default and wins where they conflict. Its sections on splitting, on how each kind splits, and on PRDs are the bar you judge against.
- The project's direction document and repository guidance, the current code, and the open issues, enough to tell what already exists. You may read the item's comments, linked items and the open issues through the Archon CLI, whose argv is the JSON string array in `$ARCHON_CLI_COMMAND`, as `<argv...> forge <op> --json --data '<request>'`, with the item's repository and number: `workitem.comments` takes `{"subject":{"kind":"issue","ref":{"repo":{"host":…,"path":…},"number":…}}}`, `workitem.view` takes that `{"ref":…}`, and `workitem.search` takes `{"repo":…,"text":"<terms>","kind":"issue"}`. An earlier split's comment on the item holds its plan.

## Decide

1. **Build whole, or split?** Split only for a reason the policy names and the item itself shows. Weigh triage's reason; don't take it on trust. When one work item works, the kind is `whole`, and the outcome is `build` when the item is already an implementation-ready work order, or `plan` when implementation decisions remain. An item an earlier split already filed issues from is the exception: those pieces may be in flight, so the split stands.
2. **What kind is it?** `prd`, `epic` or `bundle`, as the policy defines them, and split it the way the policy says that kind splits. A PRD's verdict, judged on real use after release, is never a piece.
3. **What comes next?** File only the current phase or increment: the smallest piece that proves the next thing, often one issue. Each later phase waits for a signal the earlier work must show before it is filed; a later split files it. A bundle files every task as written and has no later phase.

An open issue that already owns a piece is listed in `existing`, not filed again. A piece already done gets neither.

## Each issue

A contract another run starts from cold, in the repository's issue template shape when it has one: the problem, why it is worth solving, why now, the outcome that should become observably true, the invariants, and acceptance a person can check. Say it is part of the item, by its URL, and carry only the context from the item that constrains this piece. It comes back through triage on its own, so write it to pass unedited.

## Publish

Make the writes your decision needs, through the Archon CLI, whose argv is the JSON string array in `$ARCHON_CLI_COMMAND`, writing each request to a file under `$ARTIFACTS_DIR` and passing it with `--data-file`. A failed write is the answer: report it, and never repeat it through another tool.

1. File each issue with `workitem.create`, its body beginning with the marker line `<!-- archon-split issue-$INPUTS.issue:<key> -->`. The forge recovers the issue an earlier split filed with the same marker instead of filing it twice, so a piece you list again under its earlier key is never filed twice.
2. Record each filed issue as part of this item: `<argv...> workflow link --item issue-<filed number> --kind part_of --to issue-$INPUTS.issue`. A filed issue's change then lands where this item's does.
3. Put each filed issue in triage by adding the label `archon-triage` to it with `workitem.label.add`: it comes back through triage on its own, as the maintainer who put this item in triage asked.
4. Post the comment on the item with `workitem.comment.upsert` and the marker `<!-- archon-sdlc:split -->`, for its author and maintainers. It is the only record of the plan: the next split files the next phase from it, and a later triage weighs it. For a split, say what the item is and why it splits this way, what the current piece is, each later phase with the signal the earlier work must show before it is filed, each existing issue that owns a part and why, and what happens to the item now: a PRD stays open until its hypothesis has a verdict, an epic until its increments merge, a bundle is closed. When an earlier comment holds phases that are still ahead, carry them over, because this comment replaces it. End it with the list of the issues filed from the item, by number and title, the earlier ones included. For an item built whole, say that it is built as one work item and why.
5. A bundle is closed with `workitem.close` once every task is filed. A PRD and an epic stay open.

An item built whole writes only the comment.

## Declare

- `outcome` — `split` when you filed or listed the pieces; `plan` or `build` when the item is built whole, as above; `ask` when a decision an operator owes stops the cut, left as `asks.md` says.
- `kind` — `prd`, `epic`, `bundle` or `whole`.
- `issues` — `{ "key", "title", "number" }` for each issue filed from the item, this split's and earlier ones; empty when built whole. `key` is a short lowercase slug joined by hyphens.
- `existing` — `{ "number", "why" }` for open issues that own part of the outcome; empty when built whole.
- `summary` — one or two sentences for the run's record: what the item is and why it splits, or why one work item works.
- `asks` — with `ask`, the decisions; otherwise empty.
