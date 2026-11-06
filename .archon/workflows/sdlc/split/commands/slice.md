# Split One Item Into Issues

Triage judged this item ready, and judged that building it as one work item would not work, so it routed the item here to be split into issues. Check that judgment first, then list the issues it splits into. The next node files each one, links its dependencies, and comments the list on the item; you write nothing to the tracker, the repository or the state store yourself, and the checkout must be exactly as you found it when you finish.

The item: `$INPUTS.url`. Its title and body are in `$ARTIFACTS_DIR/split/prd.md`; read the body from there, because it is the text you split. A dated "Current scope" section in it overrides what it rules on. You may read the item's comments and linked items with the tracker's CLI.

Triage's summary of why it should be split: `$INPUTS.reason`. Empty means none was recorded.

The issues already filed from this item, by key: `$INPUTS.filed`. Each is `{ "key", "number", "url" }`; empty means none are. They exist because an earlier split filed them. Open each one you list again, and give it the same key, so it is not filed twice; a key not in this list files a new issue.

## Read first

- The SDLC triage policy, at `.archon/sdlc/policy/triage.md`, falling back to the pack's default in `$PACK_DIR/.shared/policy/triage.md`. Read the default first, then the project's file when it exists: the project's file adds to the default, and where the two conflict, the project's line wins. Its sections on splitting and on PRDs are the bar triage held this item to, and the one you check it against.
- The project's direction document, where it has one, and its repository guidance, so each issue fits where the project is going.
- Enough of the current code and the open issues to tell what already exists. An issue never asks for what the code already does or an open issue already tracks.

## Split, or build whole

Judge the item yourself against the triage policy's section on splitting, as a check on triage: split only when building it as one work item would not work, for a reason the item itself shows. Weigh triage's reason, but do not take it on trust; a large item is not a reason to split.

When building it whole would work, do not split it: declare `{ "kind": "whole", "route" }`, with `route` `deliver` when the item is already an implementation-ready work order and `plan` when material implementation decisions remain. List no issues and no existing issues, and say in `summary` why one work item works, answering triage's reason. The item goes to the build queue as one work item.

## Decide what the item is

When you split, declare what the item is:

- `prd` — the item states a hypothesis, the signal that proves or disproves it with the command that measures it, and a threshold and a window. Declare that command as `signal_command` and the window in days as `window_days`. When the PRD names a command that does not exist yet, declare the command as the PRD describes it; the first issue builds it. The PRD stays open until its hypothesis has a verdict.
- `epic` — one larger outcome whose pieces depend on each other. The epic stays open until its pieces merge.
- `bundle` — separate tasks with no hypothesis or shared outcome tying them together. The bundle is closed once its issues are filed.

Declare which one you find, and why, in `summary`.

## List the issues

At most twelve, in filing order. Each one is a single change a run can deliver and a reviewer can read.

- **An epic is split along what each piece needs merged first.** Each piece is one reviewable change that leaves the product working; order them so the earliest pieces unblock the most, and link each to the pieces it genuinely needs.
- **A PRD plans for learning.** The first issue puts the hypothesis in front of real data as soon as possible: the smallest change that lets the signal be measured on real use. When the signal has no data source yet, or its command does not exist, the first issue adds that measurement, so the command prints the signal. The issues after it build what the hypothesis is about, each one moving the signal or making it readable. In a product that already runs, no issue rebuilds what already exists or sets the product up again: build on what is there.
- **A bundle is split as written.** One issue per task the item lists, in the item's order, with the task's own scope. Do not merge, widen or reinterpret the tasks; a task that is already done gets no issue.
- **An open issue that already owns a piece is listed, not filed again.** When an open issue in this repository already tracks part of the outcome, declare it in `existing` with one line on why the outcome depends on it, and file no issue for that piece. The item's outcome waits on it as much as on the issues you file. A piece already done gets neither.

Each issue:

- `key` — a short stable slug for the piece of work, lowercase words joined by hyphens. Reuse the key of an already filed issue that covers the same work.
- `title` — the outcome, in plain words.
- `body` — a contract another run starts from cold, in the repository's issue template shape when it has one. It states the problem, why it is worth solving, why now, the outcome that should become observably true, the invariants that must hold, and what acceptance looks like, with checks a person can observe. Link the item: say this issue is part of `$INPUTS.url`. Carry only the context from the item that constrains this piece; do not paste the whole item. Do not add the dependency lines for the issues you list, or any marker; the next node writes those. When the piece needs an issue in `existing` merged first, say so in its body and name that issue, so triage holds it until then.
- `size` — `s` a few files on one surface, `m` several files or two surfaces, `l` several packages, schemas or surfaces. An `l` issue is a sign the piece is still more than one change; split it further when it is.
- `depends_on` — the keys of the issues it genuinely needs merged first, each listed before it or already filed. Keep the list short, so as much work as possible can run in parallel.

Each issue goes back through triage on its own, which judges its contract the way it judges any other item. Write it so it passes unedited.

## Declare

- `split` — `{ "kind": "prd", "signal_command", "window_days" }`, `{ "kind": "epic" }`, `{ "kind": "bundle" }`, or `{ "kind": "whole", "route" }`.
- `issues` — the list above, empty when nothing is left to file: every piece is done or owned by an issue in `existing`. Empty when the item is built whole.
- `existing` — `{ "number", "why" }` for each open issue in this repository the outcome depends on and you did not file again, possibly empty.
- `summary` — two or three sentences. For a split: what the item is, why building it whole would not work, how the list is ordered and why the first issue comes first. For `whole`: why one work item works. It is posted on the item and recorded as the reason.
