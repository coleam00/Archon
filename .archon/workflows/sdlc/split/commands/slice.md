# Split One Item, or Build It Whole

Break this item into the fewest pieces that each prove something on their own, or don't split it. Triage judged that building it as one work item would not work. Check that first: one run can plan and deliver a large change, and one pull request for one outcome is easier to review than several that only make sense together.

The item: `$INPUTS.url`, with its title and body in `$ARTIFACTS_DIR/split/prd.md`. A dated "Current scope" section in it overrides what it rules on. Triage's reason for splitting: `$INPUTS.reason` (empty when none was recorded).

## Read first

- The triage policy: the pack's default in `$PACK_DIR/.shared/policy/triage.md`, then the project's `.archon/sdlc/policy/triage.md` when it exists, which adds to the default and wins where they conflict. Its sections on splitting, on how each kind splits, and on PRDs are the bar you judge against.
- The project's direction document and repository guidance, the current code, and the open issues, enough to tell what already exists. You may read the item's comments, linked items and the open issues through the Archon CLI, whose argv is the JSON string array in `$ARCHON_CLI_COMMAND`, as `<argv...> forge <op> --json --data '<request>'`, taking the repository and number from the item's URL: `workitem.comments` takes `{"subject":{"kind":"issue","ref":{"repo":{"host":…,"path":…},"number":…}}}`, `workitem.view` takes that `{"ref":…}`, and `workitem.search` takes `{"repo":…,"text":"<terms>","kind":"issue"}`. An earlier split's comment on the item holds its plan.

## Decide

1. **Build whole, or split?** Split only for a reason the policy names and the item itself shows. Weigh triage's reason; don't take it on trust. When one work item works, answer `{ "kind": "whole", "route" }`: `deliver` when the item is already an implementation-ready work order, `plan` when implementation decisions remain. An item an earlier split already filed issues from is the exception: those pieces may be in flight, so the split stands.
2. **What kind is it?** `prd`, `epic` or `bundle`, as the policy defines them, and split it the way the policy says that kind splits. A PRD's verdict, judged on real use after release, is never a piece.
3. **What comes next?** File only the current phase or increment: the smallest piece that proves the next thing, often one issue. Each later phase waits for a signal the earlier work must show before it is filed; a later split files it. A bundle files every task as written and has no later phase.

An open issue that already owns a piece is listed in `existing`, not filed again. A piece already done gets neither.

## Each issue

A contract another run starts from cold, in the repository's issue template shape when it has one: the problem, why it is worth solving, why now, the outcome that should become observably true, the invariants, and acceptance a person can check. Say it is part of `$INPUTS.url`, and carry only the context from the item that constrains this piece. It comes back through triage on its own, so write it to pass unedited.

## Declare

- `split` — `{ "kind": "prd" | "epic" | "bundle" }`, or `{ "kind": "whole", "route" }`.
- `issues` — `{ "key", "title", "body" }` for each issue filed now; empty when built whole. `key` is a short lowercase slug joined by hyphens. Issues already filed from this item, by key: `$INPUTS.filed`. Give a piece you list again its earlier key, so it is not filed twice.
- `existing` — `{ "number", "why" }` for open issues that own part of the outcome; empty when built whole.
- `comment` — the comment posted on the item exactly as you write it, for its author and maintainers. It is the only record of the plan: the next split files the next phase from it, and a later triage weighs it. For a split, say what the item is and why it splits this way, what the current piece is, each later phase with the signal the earlier work must show before it is filed, each existing issue that owns a part and why, and what happens to the item now: a PRD stays open until its hypothesis has a verdict, an epic until its increments merge, a bundle is closed. When an earlier comment holds phases that are still ahead, carry them over, because this comment replaces it. The next node appends the list of the issues filed from the item, so do not list or number them yourself. For an item built whole, say that it is built as one work item and why.
- `summary` — one or two sentences for the run's record: what the item is and why it splits, or why one work item works.

You write nothing to the tracker, the repository or the state store; the next node files and comments.
