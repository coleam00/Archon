---
name: archon-cli-queues
description: Drive the SDLC pack: label intake, its ten stages, following an issue's item, answering what a stage asks, round limits, starting each stage by hand, and installing the bindings that chain the stages. Read when setting up, running or tending the pack.
---

# Driving the SDLC pack

The bundled SDLC pack turns a labelled issue into a merged pull request. Each stage is
one workflow that works on the issue's item, `issue-<number>`, ends with an outcome, and
leaves a question on the item (an ask) when a decision belongs to an operator. The
pack's bindings start the next stage when one ends. The pack keeps no record of its
own: what happened to an issue is its item's runs, outcomes, asks and answers.

| Workflow | One run | Ends with |
|---|---|---|
| `archon-triage` | Grounds the issue against the code, judges whether a run can start from it, and routes it. Posts questions for the author, what a blocked issue waits on, or closes a duplicate or delivered issue. | `investigate`, `plan`, `build`, `split`; `questions`, `blocked`, `close`, `not_triaged`; `ask` |
| `archon-link` | Decides whether the issue can be built now, records its `depends_on`, `part_of` and `duplicate_of` links, and places it or holds it until what it waits on lands. Triage's `plan` and `build` go through it. | `plan`, `build`; `waiting`, `fold`, `dropped`, `none`; `ask` |
| `archon-investigate` | Proves the cause of a symptom and decides the fix. | `rooted`; `refuted`, `inconclusive`; `ask` |
| `archon-split` | Builds a large issue whole, or files its next piece as an issue linked `part_of` the item and puts it in triage. | `split`; `plan`, `build`; `ask` |
| `archon-plan` | Chooses the approach and the verifiable steps. | `planned`; `ask` |
| `archon-build` | Builds, commits, pushes and opens a draft pull request; continues it in the same session when it comes back. | `built`; `replan`; `ask` |
| `archon-review` | Seven lenses and a simplify pass, three verifiers on the blocking findings, one verdict posted on the pull request; a smaller shape goes back to the builder. Also reviews any pull request by hand. | `approve`, `return`, `replan`, `ask`; by hand `ready`, `not_ready` |
| `archon-host` | Answers settled review threads, updates the description, reads CI once, takes the pull request out of draft. | `ready`, `return`, `ask` |
| `archon-land` | Judges the pull request against the land policy, merges it pinned to the head whose checks it read, records the merge on the item. | `merged`, `return`, `ask` |
| `archon-discoveries` | Files, tracks, drops or holds what the item's runs noticed outside their change. | `decided`, `ask` |

The pack's README, `.archon/workflows/sdlc/README.md` (on GitHub:
`https://raw.githubusercontent.com/coleam00/Archon/dev/.archon/workflows/sdlc/README.md`),
says which outcome starts which stage, and holds the setup guide.

## Intake is a label

Work starts only when a maintainer adds the label `archon-triage` to an issue. Opening or
editing an issue starts nothing, and an issue nobody labelled reaches no agent. To
triage an issue again, for example after its author answered triage's questions,
remove the label and add it again. On an install with no webhooks the GitHub source sees
labels by observing; a label already on an issue when the binding is first seen starts
nothing.

## Following an item

```bash
archon workflow runs --item issue-<n>          # every run, its outcome, open asks, queued starts
archon workflow runs --item issue-<n> --json   # the same, with each run's result and startLimits
```

`archon workflow get <run-id> --json` gives one run's result at
`terminal_record.returns.value`; each stage's result names its report by path. With the
item tracker on (`itemTracker` in `~/.archon/config.yaml`), the engine keeps a status
comment on the issue and posts each ask and the result there.

Rough durations, so a slow run is not mistaken for a hang: triage about 2 minutes, a
plan 5 to 15, a build 15 to 40, a review 10 to 30, host and land a few minutes, longer
while land waits for CI. These are typical, not limits.

## Answering what a stage asks

An ask is on the item, with no paused run behind it:

```bash
archon workflow attention
archon workflow answer --ref ask:<id> --choose <option> --text "<why>"
```

The answer starts the next stage, so you don't relaunch. Which one depends on the
option:

- An ask from triage, link, investigate, split, plan, build or discoveries starts that
  same stage again with the answers as decisions made. Its options are the stage's own;
  link offers `wait`, `start-anyway`, `drop`, `keep-this` and `keep-other`.
- An ask from review or host offers `send-back` (the builder continues with your
  answer), `take-as-is` (the next stage takes the change as it is), `replan` (back to
  planning) and `stop` (nothing more runs; you land or close the change by hand). At
  the round limit it offers `one-more-round` in place of `send-back`.
- An ask from land offers `land` (approves the pull request at the head the ask names;
  land runs again and merges it), `send-back` and `stop`.

An answer that chose no bound option, such as text alone, starts nothing, and the
answer command says so. Every later stage reads every answer on the item, oldest first.

Answer as `managing-runs.md` ("Answering a decision well") describes. When the
recommendation fits the user's standing direction, answer it yourself; when it is
unclear, risky or not decided by anything the user has said, bring it to the user with
the ask's own summary.

## Waiting items

An item that waits on another holds a `depends_on` link to it, recorded by the link
stage. When that item lands, or ends without landing (triage `close` or `split`,
investigate `refuted`), link starts again on every item that waits on it.
`archon workflow runs --item issue-<n>` lists an item's links.

## Round limits

A change goes back to its builder at most three times per way back (from review, host
and land) until the item is planned again. The stage that would send it back past the
limit asks instead, with `one-more-round`; choosing it allows one more start. The
item's limits are under `startLimits` in `archon workflow runs --item issue-<n> --json`.

## Starting a stage by hand

Every stage runs by hand on an item, with the issue number as `issue`. Launch from a
clone of the repository the pack works on, detached:

```bash
archon workflow run archon-triage --item issue-<n> --input issue=<n> --detach
archon workflow run archon-link --item issue-<n> --input issue=<n> --detach
archon workflow run archon-plan --item issue-<n> --input issue=<n> --detach
```

A stage that continues the change (review, host, land, and build after the first round)
runs on its branch: add `--branch <head-branch>`, or `--adopt <run-id>` to continue the
run that holds its checkout. A review of any pull request by hand runs on that pull
request's item and starts nothing after it:

```bash
archon workflow run archon-review --item pr-<n> --input pr=<n> --branch <head-branch> --detach
```

In a checkout whose `origin` is a fork, or that has several remotes and no `origin`,
add `--input repo_host=github.com --input repo_path=<owner>/<repo>`. A binding always
passes both.

## Setting up and installing the bindings

Follow the pack README's "Set it up" section in order. It checks the forge plugin
(`archon plugin add coleam00/Archon/plugins/forge-github`) and its operations, the one
setting (`ci` in `.archon/packs/sdlc.yaml`), the policy documents, and the models. Ask
the user before anything that writes to the tracker or the repository, starts a run,
or registers a binding.

```bash
archon trigger whoami
archon pack bindings sdlc --repo github.com/<owner>/<name> --host <host-id> \
  --run-as <user-id> --out ./sdlc-bindings
archon trigger add ./sdlc-bindings/<file>.json    # each run-ended and asks-settled file
archon trigger check
```

The label binding is an event binding: its object goes into the `bindings` of the
GitHub source plugin's config in the file `ARCHON_WEBHOOK_SOURCES` names, with
`"observe": { "everySeconds": 60 }` on an install with no webhooks. Keep
`archon workflow wake --watch` running (`archon workflow wake schedule install`), so
labels are observed and queued starts are admitted.

Policy documents at `.archon/sdlc/policy/<topic>.md` add to the pack's defaults rather
than replacing them; where a project line conflicts with the default, the project's
wins. A project that wants every merge asked says so in its `land.md`.

## Merging by hand

To merge a pull request the pack did not land:

1. Read the review verdict and the open review threads, including automated
   reviewers' inline comments.
2. Merge at the head you read: `gh pr merge <n> --squash --match-head-commit <sha>`.
   A push since your read makes the merge fail instead of landing unreviewed code.
3. Update your checkout to the new default branch.
