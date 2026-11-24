---
title: SDLC pack workflows
description: Every workflow in the bundled sdlc pack, what starts it, what it takes and how it ends.
category: reference
audience: [user]
sidebar:
  order: 4
---

Archon bundles one workflow pack, `sdlc`. It takes an issue to a merged pull request in stages, one workflow each. Its source lives in `.archon/workflows/sdlc/` in the Archon repository, with a [README](https://github.com/coleam00/Archon/blob/dev/.archon/workflows/sdlc/README.md) that is also the guide to building a pack of your own. [Operate the SDLC factory](/guides/sdlc-operations/) says how to install the bindings, follow an item and answer what it asks.

## How the stages fit together

Every stage works on the issue's [item](/reference/cli/#items), `issue-<n>`, and ends with a named outcome. The pack's bindings, declared in `.pack/pack.yaml` and installed with [`archon pack bindings`](/reference/cli/#pack-bindings), start the next stage on the same item when a run ends with an outcome, or when the asks a run left are answered. A stage never pauses for you: a decision that is not its own becomes an ask on the item, and the run ends.

- Intake is a label: a maintainer adds `archon-triage` to an issue, and triage starts.
- From build on, each stage starts in the checkout the stage before it left, so the change stays on one branch.
- Each stage reads what earlier stages returned through `result_of` inputs, and every decision made on the item so far through `answers`. Reports travel as file paths in a stage's result, such as the plan's `plan.md`.
- The builder keeps one session across rounds (`context: same`). A change goes back to its builder at most three times per way back (from review, host and land) until the item is planned again; past that, the stage asks.

## Running a stage by hand

Every stage runs by hand on an item, with the issue's number:

```bash
archon workflow run archon-plan --item issue-42 --input issue=42
```

Review, host and land read a change that already exists, so by hand they run on the change's branch: add `--branch <head-branch>`, or `--adopt <run-id>` to continue the checkout a run left. A stage started by hand still ends with its outcome, and the pack's bindings, when installed, start the next stage from it. Every stage also takes `repo_host` and `repo_path`; left empty, the repository is the checkout's `origin` remote. `answers` defaults to `None.`.

## The stages

### `archon-triage`

Grounds one issue against the current repository: tracker history, current code, moved branches, stale assumptions and the project's direction. It judges whether the issue is a contract a run can start from, against the triage policy, and routes it. It writes only these to the tracker: area labels the repository already has, one comment of questions for the author, one comment naming what a blocked issue waits on, and for a duplicate or delivered issue a comment linking the cause and the close. The report is `triage.md` in the run's artifacts.

- **Started by** a maintainer adding the label `archon-triage`, or by its own answers.
- **Inputs**: `issue`.
- **Outcomes**: `investigate` and `split` start that stage. `plan` and `build` (small specified work, or an open pull request that already carries the outcome, which the builder continues) start the link stage, which places the issue in that stage once it can be built. `questions` (the author must answer; remove and add the label again once they did), `blocked`, `close` and `not_triaged` (a forge read it needed failed) start nothing. `ask` leaves an operator decision, such as an owner-level product call or a close the policy leaves to a maintainer; the answer starts triage again.

### `archon-link`

Decides whether an issue that should be built can be built now, and how it relates to the project's other work. The agent checks the state of what the issue would wait on, records its `depends_on`, `part_of` and `duplicate_of` links on the item itself with `archon workflow link`, and places the issue or holds it. Changes nothing in the checkout.

- **Started by** triage `plan` or `build`; an item it holds a `depends_on` link to that landed (land `merged`) or ended without landing (triage `close` or `split`, investigate `refuted`); or its own answers.
- **Inputs**: `issue` (empty when a blocker ended; the agent reads its own item), `ended`, the key of the item that just ended; reads triage's result and its own last result from the item.
- **Outcomes**: `plan` and `build` start that stage, by triage's route. `waiting` (it holds a `depends_on` link to each item it waits on), `fold`, `dropped` and `none` start nothing. `ask` offers `wait`, `start-anyway`, `drop`, `keep-this` and `keep-other`; every answer starts link again.

### `archon-investigate`

Establishes the proven causal chain from the symptom to the root cause, reproducing it where it can, and decides the fix. Changes nothing. The report is `investigation.md`.

- **Started by** triage `investigate`, or its own answers.
- **Inputs**: `issue`; reads triage's result from the item.
- **Outcomes**: `rooted` starts the build, with the investigation as the work order. `refuted` and `inconclusive` start nothing. `ask` leaves a product decision the fix hinges on.

### `archon-split`

Decides whether a large issue is built whole or as the fewest pieces that each prove something on their own, by its kind: a PRD splits into phases, an epic into vertical increments, a bundle into its tasks. It files only the piece that comes next as its own issue, marked so it is never filed twice, links it `part_of` the item, and adds `archon-triage` to it so it comes back through triage. One comment on the item holds the plan for the later pieces. A bundle is closed once its tasks are filed.

- **Started by** triage `split`, or its own answers.
- **Inputs**: `issue`; reads triage's result and its own last result from the item.
- **Outcomes**: `split` starts nothing on this item: each piece is triaged on its own. `plan` and `build` mean it is built whole, and start that stage. `ask`.

### `archon-plan`

Turns an issue whose outcome is decided into an implementable plan: the approach with rejected alternatives and what settled each call, verifiable steps, contract coverage and the validation. Changes nothing. The plan is `plan.md`; non-blocking questions are in `open_questions`.

- **Started by** link or split `plan`, a build or review that ended `replan`, a `replan` answer on a review or host ask, or its own answers.
- **Inputs**: `issue`; reads triage, split, and the last build and review from the item.
- **Outcomes**: `planned` starts the build. `ask` leaves each call that belongs to an operator; the answers start the plan again.

### `archon-build`

Implements the work with focused checks on what it changed, commits, pushes the branch and opens a draft pull request, written to the project's propose policy. When the change comes back from the review, the host, the land stage or an operator, the same node continues it in the session it last had on the item, on the same branch. The report is `implementation.md`, which records the disposition of every finding and review thread that came back.

- **Started by** plan `planned`, investigate `rooted`, link or split `build`; review, host or land `return`; a `send-back` answer; or its own answers.
- **Inputs**: `issue`, `returned` (the result of the stage that sent the change back; `null` on a first build); reads the latest plan, investigation, triage and split from the item.
- **Outcomes**: `built` starts the review on the commit it pushed. `replan` starts planning. `ask` leaves a decision that is not the builder's; the answers start the build again in the same session.

### `archon-review`

Reviews a change through parallel specialist lenses and ends in one evidence-based verdict. A scope agent fixes the commit under review and the accepted contract; a route agent picks the lenses the change earns (seams, code, tests, errors, docs, ux). Synthesis aggregates their reports and judges every acceptance item, invariant and steering constraint. When the verdict is not ready, three independent verifiers judge each blocking finding, and the verdict node demotes one two of them reject. A round after an earlier review of the item verifies the earlier findings and reviews only the delta since the commit that round reviewed. The report is posted on the pull request as one marked comment, edited in place each round, only while the pull request's head is the reviewed commit. Read-only.

Beside the lenses, a simplify pass judges whether the change delivers its outcome through more structure than it needs and writes `shape.md`. A smaller shape it names sends the change back to the builder even when the verdict is ready; the verdict's `simplify` field counts them and `shape` names the report.

- **Started by** build `built`. By hand on any pull request, on its own item, from a checkout of its head branch:

  ```bash
  archon workflow run archon-review --item pr-87 --input pr=87 --branch <head-branch>
  ```

- **Inputs**: `issue` (empty by hand), `pr` (by hand: the pull request's number or URL; empty means the builder's pull request, or the current branch's); reads the last build and review from the item.
- **Outcomes in delivery**: `approve` starts the host stage. `return` sends the change back to its builder; past the round limit it is `ask` instead, and `send-back` gives one more round. `replan` starts planning. `ask` offers the options the workflow declares under `returns.options`: `send-back` (the builder continues with your answer), `take-as-is` (the host stage starts on the change as it is), `replan` and `stop` (nothing more runs).
- **Outcomes by hand**: `ready` or `not_ready`; nothing starts.

### `archon-host`

Hands a reviewed pull request to its host in three agent steps: it answers and resolves the review threads whose disposition holds, listing the rest for the builder; brings the description in line with the change, including the `Closes #N` or `Refs #N` reference from the review's contract coverage and the issue's dated rulings; checks that it still merges with its base, reads the checks once without waiting for them, and takes it out of draft. Under `ci: none` it runs the project's full validation itself and records it. The result is in `ci.md`.

- **Started by** review `approve`, or a `take-as-is` answer on a review ask. By hand: `--branch <head-branch>`.
- **Inputs**: `issue`; reads the last build and review from the item.
- **Outcomes**: `ready` starts the land stage. `return` sends the change back to its builder for a red check it caused, a conflict, or an open thread; past the limit it asks, and `send-back` gives one more round. `ask` offers the declared `send-back`, `take-as-is` (the land stage judges it as it is), `replan` and `stop`.

### `archon-land`

One agent judges the ready pull request against the project's land policy: the base branch's CI, the review's verdict at the head, conflicts, CI at the head (waiting up to 30 minutes for pending checks, and rerunning red outside the change once), open threads, and whether the change is clear or must be asked. A clear one, or one an operator approved at its head, it merges with `pr.merge` pinned to the head whose checks it read, after setting the issue keyword. The merge records itself and its landing branch on the item. Land runs one at a time per repository.

- **Started by** host `ready`, a `take-as-is` answer on a host ask, or a `land` answer. By hand: `--branch <head-branch>`.
- **Inputs**: `issue`; reads the last host, review and land results from the item.
- **Outcomes**: `merged` starts the discoveries stage. `return` sends the change back to its builder. `ask` offers `land` (approve it at the head the question names; the land stage starts again), `send-back` and `stop`.

### `archon-discoveries`

Reads what the item's runs recorded outside their change, the review's accepted records and every run's raw `discoveries/` files, verifies each against the landing branch, and files, tracks, drops, holds or asks about it, under the discoveries policy. Files at most three issues a pass, marked so none is filed twice, and labels none: a maintainer decides what is triaged.

- **Started by** land `merged`, or its own answers.
- **Inputs**: `issue`; reads the latest review from the item.
- **Outcomes**: `decided`; `ask`.

## Removed workflows

`archon-intake`, `archon-build-queue`, `archon-build-pick`, `archon-deliver`, `archon-implement`, `archon-simplify` (now a pass inside `archon-review`), `archon-pr`, `archon-merge-queue`, `archon-merge-pick`, `archon-ship` and the `archon-metrics-*` workflows are gone. The changelog's entry for the rebuilt pack names what replaces each one, and the inputs that changed.

## Summary

| Workflow | Starts after | Ends with | Writes |
|---|---|---|---|
| `archon-triage` | the `archon-triage` label | `investigate`, `plan`, `build`, `split`, `questions`, `blocked`, `close`, `not_triaged`, `ask` | labels, issue comments, closes |
| `archon-link` | triage `plan` or `build`, a blocker that ended | `plan`, `build`, `waiting`, `fold`, `dropped`, `none`, `ask` | links on the item |
| `archon-investigate` | triage `investigate` | `rooted`, `refuted`, `inconclusive`, `ask` | nothing |
| `archon-split` | triage `split` | `split`, `plan`, `build`, `ask` | new issues, a comment, links |
| `archon-plan` | link or split `plan`, `replan` | `planned`, `ask` | nothing |
| `archon-build` | `planned`, `rooted`, `build`, any `return` | `built`, `replan`, `ask` | commits, a draft pull request |
| `archon-review` | build `built` | `approve`, `return`, `replan`, `ask`; by hand `ready`, `not_ready` | one review comment |
| `archon-host` | review `approve` | `ready`, `return`, `ask` | thread replies, the description, ready |
| `archon-land` | host `ready` | `merged`, `return`, `ask` | the merge |
| `archon-discoveries` | land `merged` | `decided`, `ask` | new issues, evidence comments |
