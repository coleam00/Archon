# Hand the pull request off

The pull request's review has passed. The builder checked only what it changed, so the project's full validation is still to come, and the project's CI setting says where it comes from. This run's setting is `$INPUTS.ci`. It is what the land stage trusts at the head besides the review verdict, and it decides which one of the two validation sections below applies to this run:

- `forge`: the forge's checks are the full validation. Follow "Under `ci: forge`" and skip "Under `ci: none`".
- `none`: the project has no CI, so you run the full validation yourself and record it. Follow "Under `ci: none`" and skip "Under `ci: forge`": do not read the forge's checks, and a green check there is not the validation.

Under either setting: check the head and the base, follow the one validation section, take in the review threads, act, then declare. No one watches this run; your structured answer and `$ARTIFACTS_DIR/ci.md` are all the next stage reads.

The pull request is the one the review approved, `pull_request` in its result, at the commit it names as `head`:

$INPUTS.review

Read it with `pr.view` for its repository, `number`, `head` branch and `base`; act on exactly that pull request, never one found from the checkout's remotes or branch. Every forge read and write goes through the Archon CLI, whose argv is the JSON string array in `$ARCHON_CLI_COMMAND`, run as `<argv...> forge <op> --json --data '<request>'`. With `<ref>` = `{"repo":{"host":…,"path":…},"number":…}` from the record: `pr.view` takes `{"selector":{"kind":"number","ref":<ref>}}`; `pr.ready` and `pr.draft` take `{"ref":<ref>}`. A failed operation is the answer: report it, and never repeat it through another tool.

## The head and the base

If the pull request is merged, declare `ready`: there is nothing to hand off. If it is closed without a merge, declare `other` and say so. Otherwise confirm the pull request's head is this checkout's `HEAD` and the commit the review approved: a stale head is never handed off. When the pull request's head carries commits this checkout's `HEAD` does not, someone pushed after the review and no review covered them: do not mark it ready, put it back to draft if it is ready, and declare `pr_caused`, naming those commits, so the builder takes them in and the review sees them. When the two heads differ in any other way, declare `other` with the evidence.

Then confirm the pull request merges cleanly with its base: fetch the base from the remote whose URL is the record's repository (`git remote -v`; it need not be named `origin`) and run `git merge-tree --write-tree <remote>/<base> HEAD`, which exits 1 on a conflict and names the conflicting paths. A conflict is this pull request's own problem: declare `pr_caused` without marking it ready, and write to `$ARTIFACTS_DIR/ci.md` the base branch, every conflicting path, and the instruction for the builder: merge the base branch into this branch with a normal merge commit, never a rebase, resolve every conflict keeping the intent of both sides, and check what the resolution touched.

## Under `ci: forge`: the checks as they stand

CI is the project's full validation. The land stage judges CI at the head before it merges: it waits on pending checks, sends red the change caused back to the builder, and reruns red elsewhere once. So you never wait for CI. Read the checks once, hand the pull request off ready, and send it back to the builder only for a check that is already red because of this change.

Read `checks.state` once; it takes `{"ref":<ref>}`. Do not wait for a pending check, do not wait for checks to appear, and do not re-run or cancel any check. Its answer carries the `revision` it evaluated, each unit's conclusion, and a `summary` whose `counts` give the number of units in each state and whose `state` (`none`, `pending`, `green`, `red`, `gated` or `unknown`) is the worst unit's: one red unit makes it `red` while others are still `pending`.

When the answer names a red unit at the pushed head, gather the evidence for each failing check before you claim a cause: read its log with `checks.logs`, which takes `{"repo":{"host":…,"path":…},"unit":<the red unit's `unit` from the `checks.state` answer, unchanged>}` and answers the end of the log in `log.text` (when `log.truncated` is true and the failure is cut off, ask again with `"maxBytes"` up to 1048576; `log.kind` `none` means that unit has no log to read, so you cannot tell its cause from one), record the source file each failure points at, and whether that file is one this pull request changed or code its change makes reachable. A failure in a file the pull request changed is the change's whatever else is true. Any failure that is the change's makes the answer `pr_caused`. When you cannot tell, hand off and say so in `ci.md`: the land stage judges the red again before it merges, returns it when it is the change's and reruns it once when it is not, while a correction round with nothing to fix would only repeat this read at the same head. A red that is not the change's, such as a flake, an infrastructure failure or a red base, is the land stage's to judge: note it in `ci.md` and hand off.

## Under `ci: none`: the validation you run

Run the project's full validation yourself in this checkout, discovered from its own scripts and contributor docs, and wait for it to finish however long it takes: if your tool cuts a command off early, you may start it in the background, but then poll that job in the foreground, with commands that each finish within your tool's time limit, until it has finished, and read its result; never end your turn while it runs. Before you claim a cause for a failure, record the source file it points at, and whether that file is one this pull request changed or code its change makes reachable. A failure in a file the pull request changed is the change's whatever else is true. A failure is `pr_caused` when it is the change's and `other` otherwise, except that a failure you cannot place is the change's: no later check will see it again. The land stage merges only the commit you validated, and only when every part of the validation passed, so `ready` here means the validation passed at the head: the round does not end ready without that in `validation`.

## The review threads

The threads node before you answered every settled thread on the pull request. What it left:

$threads.output

Each thread in its `open` list holds the pull request: it goes back to the builder whatever the checks say, as `pr_caused` does, with each thread's URL and what the builder must do in `ci.md`. When its `ask` is true, a thread needs a decision this run cannot make: that is `other`, and its summary names the thread and the decision.

## Act

Before you hand off, read the pull request's head again; when it is no longer this checkout's `HEAD`, answer as for a head that carries unreviewed commits.

- `ready`: take the pull request out of draft (`pr.ready`) and read it back to confirm it is no longer a draft. Many repositories skip CI on draft pull requests, and marking it ready is what starts CI there. Write the head you handed off and the checks as you read them, or the validation you ran, to `$ARTIFACTS_DIR/ci.md`. If the ready flip fails, declare `other` with the error.
- `pr_caused` or `other`: when the pull request is not a draft, put it back to draft (`pr.draft`) and read it back to confirm it is a draft. Then write the failing checks, the conflict or the open threads, their log lines, the file each points at, and the cause with its evidence to `$ARTIFACTS_DIR/ci.md`. On `pr_caused` the builder fixes from that file, and the review sees the correction again. When the failure is a test this pull request added that fails on its own cost, such as a timeout or a resource budget rather than a wrong assertion, the instruction may be to remove that test, or replace it with a focused test of the same behavior, instead of making it fit the budget. If a draft flip fails, say so in the summary; the state stays what you found.

## How the stage ends

- `ready` hands the pull request to the land stage.
- `pr_caused` returns it to its builder: the outcome is `return`. Before you return it, read `rounds.md` (`.archon/sdlc/policy/`, over the default in `$PACK_DIR/.shared/policy/`): the binding is `build-after-host`. When its limit is used up, the outcome is `ask` instead: `send-back` then gives the builder one more round with `ci.md`.
- `other` is an ask: the outcome is `ask`. Write the question as `asks.md` says. The workflow declares the options every ask offers, because the answer's option starts the next stage; you write none. Write what each means for this pull request in `context`, and recommend one, or write `option: null` with why you cannot choose in `why`.

## Declare

- `outcome` — `ready`, `return` or `ask`, as above.
- `state` — `ready`, `pr_caused`, or `other`.
- `pull_request` — the pull request's URL.
- `head` — the full head commit you handed off or judged.
- `validation` — under `ci: none`, the full validation you ran: `head`, the full commit SHA it ran on, and `passed`, true only when every part of it passed. Null when you ran none, which is always the case under `ci: forge`, and under `ci: none` never the case when you hand a pull request off `ready`.
- `summary` — two to four sentences: the head, the checks as you read them, the cause of any red you judged with the log lines that show it, the threads left open, and the pull request's draft state when you finished.
- `report` — the absolute path of `$ARTIFACTS_DIR/ci.md`. The builder reads it there when the change comes back.
- `asks` — with `ask`, each decision as above; otherwise empty.
