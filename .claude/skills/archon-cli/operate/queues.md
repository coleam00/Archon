---
name: archon-cli-queues
description: Drive the SDLC pack's queues by hand: intake, the build queue, the merge queue and the discoveries drain. Their inputs, what each run does, the decisions they raise and how to answer them. Read when launching or tending any of them.
---

# Driving the SDLC queues

The bundled SDLC pack turns issues into merged pull requests through four queue
workflows. Each run does one step and stops only for a decision it cannot make:

| Workflow | One run |
|---|---|
| `archon-intake` | Records an issue event and triages the best waiting issue. The verdict becomes the item's stage and a route label. |
| `archon-build-queue` | Claims the best waiting triaged item, or the one `number` names, and takes it to a pull request whose review says Ready, one round per run. |
| `archon-merge-queue` | Claims the items the build queue finished and merges what policy allows, one at a time, through a gate. |
| `archon-discoveries` | Decides the out-of-scope findings finished runs recorded: file, track, drop or ask. |

The pack's README (`.archon/workflows/sdlc/README.md`) is the full contract. This
reference covers launching and tending the queues by hand.

## Before the first run

- `archon workflow run archon-forge-check` must pass in the checkout. It proves the
  pack can read the repository through its forge source (`gh` by default).
- `.archon/sdlc/policy/maintainers.json` on the default branch lists the forge logins
  whose issues are triaged and whose review comments count. An entry can be an object,
  `{ "login": "<login>", "merge_queue": "own-prs" }`, which also sends that
  maintainer's own open pull requests through the merge queue, except one a work item
  already names, such as a pull request the build queue delivered, and one from a
  `build/` branch in the repository itself, the build queue's branch namespace: a
  hand-made pull request on a `build/` branch does not enroll. Without the file
  every author is an outsider: intake labels their issues `archon-needs-maintainer`
  and runs no agent.
- The forge account the pack's review runs post as must also be on
  `maintainers.json`. The merge queue counts only a review comment a listed
  maintainer wrote; with no trusted review, no verdict is Ready and nothing merges.
- The merge gate requires green CI at the pull request's head. A repository with no
  CI checks reads as `none`, not green, so nothing merges there.
- Policy documents at `.archon/sdlc/policy/<topic>.md` add to the pack's defaults
  rather than replacing them. Where a line in the project's file conflicts with the
  default, the project's line wins.
- The pack installs no trigger bindings. Nothing runs on its own until the operator
  adds one. The README shows a binding per queue; until then, launch by hand.

## Inputs

Every queue takes the repository as two inputs: `repo_host` (such as `github.com`)
and `repo_path` (`<owner>/<repo>`). Launch from the repository's checkout, detached.

```bash
R="--input repo_host=github.com --input repo_path=<owner>/<repo>"

archon workflow run archon-intake $R --input number=<issue> --detach
archon workflow run archon-build-queue $R --detach
archon workflow run archon-merge-queue $R --detach
archon workflow run archon-discoveries $R --detach
```

Optional inputs, with their defaults in each workflow's YAML:

- `archon-intake`: `action` (`opened` by default; `edited`, `reopened`, or `added`
  for a label), `label` and `label_actor` for a label event.
- `archon-build-queue`: `number` (the issue to build; empty claims the first in
  order), `retriage_as` (a maintainer login; set, a run that names no item also
  re-triages blocked items that no longer look blocked) and `round_limit` (default
  `3`), the rounds after which a run that wants another also judges whether the rounds
  converge.
- `archon-merge-queue`: `limit` (default `10` items claimed), `merge_method`
  (`squash` or `merge`) and `retriage_as` (a maintainer login; set, an issue still
  open after its pull request merged goes back to intake).
- `archon-discoveries`: `since` and `until` (ISO-8601) and `limit` (default `20` runs
  per pass).

Intake, the merge queue and the discoveries drain never change their checkout. They
create no worktree and run in the launch checkout as it stands, so launch them from a
checkout that tracks the default branch. The build queue changes its checkout, so each
run gets its own worktree on a run-named branch. A completed round removes that
worktree when it is clean and every commit is on a remote, and keeps the branch;
otherwise the run names the path and what removing it would lose.

## Intake

Run intake once per issue event. For a new issue, `--input number=<issue>` is enough.

An edit or a plain rerun does not re-triage a maintainer's issue that was already
triaged. To re-triage one, add the `archon-triage` label on the forge and launch the
label event, naming who added it:

```bash
archon workflow run archon-intake $R --input number=<issue> \
  --input action=added --input label=archon-triage --input label_actor=<maintainer-login> --detach
```

`label_actor` must be on `maintainers.json`. The same event with a listed maintainer
promotes an outside author's issue.

Read the result from the issue's labels:

- `archon-ready`, `archon-plan` or `archon-investigate`: routed to the build queue.
- `archon-needs-contract`: the body misses one of the six brief elements. Fix the
  body, then re-triage.
- `archon-blocked`: a prerequisite or a decision must land first. Re-triage once it
  has.
- `archon-close`: a duplicate or already delivered. Intake closes it when the triage
  policy allows.
- `archon-needs-maintainer`: an outside author's issue, waiting for promotion.

## Build queue

A run claims the waiting item that sorts first and works it for one round. To build
a chosen issue, name it:

```bash
archon workflow run archon-build-queue $R --input number=<issue> --detach
```

A named issue that cannot be claimed refuses the run before any agent, with the
reason: it has no work item, another run holds it, or it does not wait for the build
queue. Launch one run per item you want worked at the same time; the launch's
`--config` decides which provider builds it.

A round ends one of three ways, recorded on the item:

- `done`: the pull request's latest review says Ready at its head. The merge queue
  takes it from there. When only a check no round can run is left, the run asks once
  for it instead. A pull request already reviewed Ready at its head is marked
  ready without another round.
- `continue`: the issue already answers what stopped the round, and the correction
  stays inside the issue's shape (one that adds machinery the issue does not name asks
  instead). A pull request that changed nothing material since its last
  review never continues; the round ends as done or ask. The run starts the
  item's next round at once, as a detached `archon-build-queue --input number=<n>`
  run on the same run config and the same `retriage_as` and `round_limit`.
  If that launch fails, the item waits for the next queue run.
- `ask`: the run pauses as one attention item labelled `build: route`, `build: stop`
  or `build: scope`.

An item the merge queue returns waits for a new build round, with the merge queue's
brief. A re-triage after the queue's last decision starts the item over.

Do not resume a failed build-queue run once a later build-queue run has released its
claim. A run that names no item releases every finished run's claim, whichever item it
then picks. A run named for the same `number` releases it too; one named for a
different `number` leaves it alone. A resume skips the completed `facts` node that
claimed the item, so the resumed run works the whole round, then its `apply` refuses
because the item is no longer claimed by it. Launch a fresh run with
`--input number=<issue>` instead.

## Merge queue

A sweep claims every waiting item up to `limit` and merges what policy allows, one
at a time, through a gate that requires a Ready verdict for the head, green CI there
and a default branch whose CI is not red. A pull request that merges cleanly into the
default branch merges, even when it is behind, so one sweep can land many. The queue
never pushes or waits for CI: a conflict goes back to the build queue, and the default
branch's CI on a merge is the next sweep's first fact. Claims keep two sweeps off the
same item.

A verdict counts only at the head it reviewed: after a push, the pull request goes
back to the build queue for a new round. A maintainer's own pull request
(`merge_queue: "own-prs"`) is an own-PR work item with no build record to return to,
so where another would go back, the sweep asks instead and offers no `return`.

A pull request whose read fails twice in a row is parked with the read error until
the build queue readies the item again. A maintainer's own pull request has no build
record, so nothing readies it again: once parked, it stays parked, and you merge it by
hand.

A sweep merges a clear pull request on its own. An unclear one, such as a very large
change, pauses as an attention item labelled `merge: pr` with the choices `merge`,
`return`, `park` and `other`. A red default branch pauses as `merge: base` with the
one choice `hold`, and the gate refuses every merge until it is green. A run raises at
most one attention item: the red default branch first, otherwise the first pull
request the sweep asked about. A later sweep decides the rest again.

A `merge` answer approves the pull request at the head it asked about, and a sweep
the answer starts, on the answered run's `limit`, `merge_method` and
`retriage_as`, merges it once the gate passes. The approval carries to a later head only when the sweep
judges that everything since is merges of the default branch and their conflict
resolutions, and the verdict is Ready at the later head. A `return` hands the item
back to the build queue, whose next round starts at once on the build queue's own
input defaults. A `park` stops work on the item until the build queue readies it again.

For an own pull request, `park` and `other` stop queue work until a later sweep
observes a head different from the head asked about. At the same head it stays
parked, even after green CI or a new review. The `other` text is recorded as the
ruling on the work item; it starts no build round.

## Discoveries drain

Each pass decides the records of up to `limit` finished runs, oldest first. Repeat
passes until one finds nothing queued: its `decide` node is skipped
(`archon workflow get <run-id> --verbose --json`). Stop early when a pass pauses with a
`discoveries: question` item, and answer it first.

Issues a pass files carry no labels. Run intake on each one to triage it.

## Answering queue decisions

Queue items follow one shape: what is being decided, why it matters, the
recommendation with its evidence and what would change it, the choices and what each
does, and what happens if nobody answers. Answer them as `managing-runs.md`
("Answering a decision well") describes:

```bash
archon workflow respond <run-id> <choice> "<reason>" --detach
```

The build queue and merge items owned by a build write the ruling into the issue
body as a dated "Current scope" section, and later rounds work from it. An enrolled
own PR keeps the answer on its work item's merge decision entry; it writes no issue
section. Write the reason as a ruling a later round can act on: what is in scope,
what is not, and why. An answer that
continues an item (a build `continue`, a merge `merge` or `return`) starts the follow-up
run at once, on the run config the answered run started with, so you don't relaunch. A
follow-up in the same queue also keeps the answered run's input selections.

- When the recommendation fits the user's standing direction, answer it yourself.
- When it is unclear, risky or not decided by anything the user has said, bring it to
  the user with the item's own summary.
- `other` exists on every pull-request and build item. Use it when no declared choice
  fits, and say exactly what to do instead.

## Merging by hand

A pull request the queues did not deliver has no work item, so the merge queue does
not take it, unless its author's `maintainers.json` entry sets
`merge_queue: "own-prs"`. To merge one yourself:

1. Read the review verdict and the open review threads, including automated
   reviewers' inline comments.
2. Merge at the head you read: `gh pr merge <n> --squash --match-head-commit <sha>`.
   A push since your read makes the merge fail instead of landing unreviewed code.
3. Update your checkout to the new default branch.
