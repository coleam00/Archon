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
| `archon-build-queue` | Claims the best waiting triaged item and takes it to a pull request whose review says Ready, one round per run. |
| `archon-merge-queue` | Claims the items the build queue finished and merges at most one pull request, through a gate. |
| `archon-discoveries` | Decides the out-of-scope findings finished runs recorded: file, track, drop or ask. |

The pack's README (`.archon/workflows/sdlc/README.md`) is the full contract. This
reference covers launching and tending the queues by hand.

## Before the first run

- `archon workflow run archon-forge-check` must pass in the checkout. It proves the
  pack can read the repository through its forge source (`gh` by default).
- `.archon/sdlc/policy/maintainers.json` on the default branch lists the forge logins
  whose issues are triaged and whose review comments count. Without the file every
  author is an outsider: intake labels their issues `archon-needs-maintainer` and runs
  no agent.
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

- `order` (intake, build queue and merge queue): the pickup order, a JSON array of
  `"<key> <asc|desc>"` over `urgency`, `importance`, `size`, `complexity` and
  `created`.
- `archon-intake`: `action` (`opened` by default; `edited`, `reopened`, or `added`
  for a label), `label` and `label_actor` for a label event.
- `archon-build-queue`: `round_limit` (default `3`), the rounds after which a run
  that wants another also judges whether the rounds converge.
- `archon-merge-queue`: `limit` (default `10` items claimed) and `merge_method`
  (`squash` or `merge`).
- `archon-discoveries`: `since` and `until` (ISO-8601) and `limit` (default `20` runs
  per pass).

The build and merge queues change their checkout, so each run needs its own worktree.
A plain launch from a git checkout gets one.

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

A run claims the waiting item that sorts first and works it for one round. You cannot
point a run at a chosen item; ranking decides. Launch one run per item you want
worked at the same time.

A round ends one of three ways, recorded on the item:

- `done`: the pull request's latest review says Ready at its head. The merge queue
  takes it from there.
- `continue`: the issue already answers what stopped the round. The next run starts
  the next round from the recorded brief.
- `ask`: the run pauses as one attention item labelled `build: route`, `build: stop`
  or `build: scope`.

Launch another build-queue run to work the next round or the next item.

## Merge queue

A sweep claims every waiting item up to `limit` and merges what policy allows, one
at a time, through a gate that requires a Ready verdict and green CI at a head that
contains the default branch. Each merge moves the default branch, so a later pull
request needs a sync, and its new head needs CI before the gate passes. In practice
that pull request usually merges in a later sweep. After a batch the sweep waits for
the default branch's CI.

Run sweeps one after another, not in parallel: two sweeps would sync the same
branches. Start the next sweep once CI on the pull requests it synced has finished.

A sweep merges a clear pull request on its own. An unclear one, such as a very large
change, pauses as an attention item labelled `merge: pr` with the choices `merge`,
`return`, `park` and `other`. A red default branch pauses as `merge: dev` and holds
every merge until it is green.

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

The build and merge queues write the answer's text into the issue body as a dated
"Current scope" section, and later rounds work from it. Write the reason as a ruling a
later round can act on: what is in scope, what is not, and why.

- When the recommendation fits the user's standing direction, answer it yourself.
- When it is unclear, risky or not decided by anything the user has said, bring it to
  the user with the item's own summary.
- `other` exists on every pull-request and build item. Use it when no declared choice
  fits, and say exactly what to do instead.

## Merging by hand

A pull request the queues did not deliver has no work item, so the merge queue does
not take it. To merge one yourself:

1. Read the review verdict and the open review threads, including automated
   reviewers' inline comments.
2. Merge at the head you read: `gh pr merge <n> --squash --match-head-commit <sha>`.
   A push since your read makes the merge fail instead of landing unreviewed code.
3. Update your checkout to the new default branch.
