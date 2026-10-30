# Split One Item Into Issues

Triage judged this item ready to split: it is a PRD, a release that tests a hypothesis, or a bundle of separate tasks. List the issues it splits into. The next node files each one, links its dependencies, and comments the list on the item; you write nothing to the tracker, the repository or the state store yourself, and the checkout must be exactly as you found it when you finish.

The item: `$INPUTS.url`. Its title and body are in `$ARTIFACTS_DIR/split/prd.md`; read the body from there, because it is the text you split. A dated "Current scope" section in it overrides what it rules on. You may read the item's comments and linked items with the tracker's CLI.

The issues already filed from this item, by key: `$INPUTS.filed`. Each is `{ "key", "number", "url" }`; empty means none are. They exist because an earlier split filed them. Open each one you list again, and give it the same key, so it is not filed twice; a key not in this list files a new issue.

## Read first

- The project's direction document, where it has one, and its repository guidance, so each issue fits where the project is going.
- Enough of the current code and the open issues to tell what already exists. An issue never asks for what the code already does or an open issue already tracks.

## Decide what the item is

- `prd` — the item states a hypothesis, the signal that proves or disproves it with the command that measures it, and a threshold and a window. Declare that command as `signal_command` and the window in days as `window_days`. When the PRD names a command that does not exist yet, declare the command as the PRD describes it; the first issue builds it.
- `bundle` — the item lists separate tasks with no hypothesis tying them together.

Triage found the item to be one of the two. Declare which one you find, and why, in `summary`.

## List the issues

At most twelve, in filing order. Each one is a single change a run can deliver and a reviewer can read.

- **A PRD plans for learning.** The first issue puts the hypothesis in front of real data as soon as possible: the smallest change that lets the signal be measured on real use. When the signal has no data source yet, or its command does not exist, the first issue adds that measurement, so the command prints the signal. The issues after it build what the hypothesis is about, each one moving the signal or making it readable. In a product that already runs, no issue rebuilds what already exists or sets the product up again: build on what is there.
- **A bundle is split as written.** One issue per task the item lists, in the item's order, with the task's own scope. Do not merge, widen or reinterpret the tasks; a task that is already done gets no issue.
- **An open issue that already owns a piece is listed, not filed again.** When an open issue in this repository already tracks part of the outcome, declare it in `existing` with one line on why the outcome depends on it, and file no issue for that piece. The item's outcome waits on it as much as on the issues you file. A piece already done gets neither.

Each issue:

- `key` — a short stable slug for the piece of work, lowercase words joined by hyphens. Reuse the key of an already filed issue that covers the same work.
- `title` — the outcome, in plain words.
- `body` — a contract another run starts from cold, in the repository's issue template shape when it has one. It states the problem, why it is worth solving, why now, the outcome that should become observably true, the invariants that must hold, and what acceptance looks like, with checks a person can observe. Link the item: say this issue is part of `$INPUTS.url`. Carry only the context from the item that constrains this piece; do not paste the whole item. Do not add the dependency lines or any marker; the next node writes those.
- `size` — `s` a few files on one surface, `m` several files or two surfaces, `l` several packages, schemas or surfaces. An `l` issue is a sign the piece is still more than one change; split it further when it is.
- `depends_on` — the keys of the issues it genuinely needs merged first, each listed before it or already filed. Keep the list short, so as much work as possible can run in parallel.

Each issue goes back through triage on its own, which judges its contract the way it judges any other item. Write it so it passes unedited.

## Declare

- `split` — `{ "kind": "prd", "signal_command", "window_days" }` or `{ "kind": "bundle" }`.
- `issues` — the list above.
- `existing` — `{ "number", "why" }` for each open issue in this repository the outcome depends on and you did not file again, possibly empty.
- `summary` — two or three sentences: what the item is, how the list is ordered and why the first issue comes first.
