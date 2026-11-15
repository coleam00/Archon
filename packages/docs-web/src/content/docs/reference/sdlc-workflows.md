---
title: SDLC pack workflows
description: Every workflow in the bundled sdlc pack, what it produces and when to use it.
category: reference
audience: [user]
sidebar:
  order: 4
---

Archon bundles one workflow pack, `sdlc`. It covers the software lifecycle from an incoming issue to a merged pull request. Its source lives in `.archon/workflows/sdlc/` in the Archon repository. [Operate the SDLC factory](/guides/sdlc-operations/) documents the queues' behaviour, settings and bindings, and [SDLC factory metrics](/guides/sdlc-metrics/) the metrics the pack records.

## How the factory runs

`archon-intake` triages each new issue, `archon-split` files the issues a large item splits into when it can't be built as one, `archon-build-queue` works it to a reviewed pull request, `archon-merge-queue` merges it, and `archon-discoveries` files what runs noticed on the way. Anything unclear pauses as one attention item with a recommendation. [The SDLC factory](/getting-started/sdlc-factory/) introduces them and points at the setup guide; the pack binds no trigger by default.

`archon-ship` itself is a graph of the stage workflows below. Triage picks a route; investigate or plan runs when the route needs it; then the delivery rounds implement, open a draft pull request, review it through specialist lenses, fix the findings and hand the pull request off ready without waiting for CI. Stages hand each other files in `$ARTIFACTS_DIR`, such as `triage.md`, `plan.md` and `implementation.md`, not conversation history.

## Which workflow to use

`archon-ship` is the default for taking an issue or request to a reviewed pull request. The [summary table](#summary) lists every workflow by when to use it. To ask a question or explore the codebase, ask in chat; no workflow is needed.

## Catalog

### End to end

#### `archon-ship`

Grounds an issue or request against the current repository before spending on it, then takes the least speculative path: investigate an unknown cause, plan an undecided shape, deliver an implementation-ready work order, continue an open PR that already carries the outcome, or stop when no work remains. Every actionable path ends in the same reviewed delivery tail as `archon-deliver`.

**When to use it**: A GitHub issue or request should go from a current-truth check to a reviewed PR. This is your default for bugs, features, and enhancements.

```bash
archon workflow run archon-ship --branch fix/login-crash "#142"
```

**What it produces**: A PR marked ready for review once its review passes, for the merge queue to judge its CI, or an explained stop, with a PR it opened left in draft. The stop says whether no work is owed (the outcome already holds, or an investigation found the cause outside this repository) or the requested work was not done and why. The run's result says whether it delivered; when it did not, such as on a question triage or the plan could not settle, an unrooted cause, or a delivery that ended not ready, [continue it with a note](#continuing-a-stage-that-ended-not-ready). The workflow never merges. Merge a pull request it opened yourself; the merge queue merges only what the build queue finished.

`--input pull_request=<number>` has delivery finish that open PR whichever route reaches delivery; a run that stops before delivery leaves it as it was, and a run whose triage names a different PR to continue fails before delivery. `--input branch=<name>` passes through to `archon-deliver`.

**Delivering one part of a multi-part plan**: When an approved plan splits the work into several PRs, tell the run which part it delivers and which contract items each part owns, quoting each item as the contract states it:

```bash
archon workflow run archon-ship --branch feat/export-csv-api \
  --input part='{"delivers":1,"parts":[{"part":1,"items":["The API returns CSV."]},{"part":2,"items":["The console offers a CSV download.","Users can export their data as CSV."]}]}' \
  "#142"
```

The review then treats an item that only later parts list as deferred: it is neither a blocking finding nor a discovery, and the PR says `Refs #N` instead of closing the issue. The required outcome is an item like any other, so list it under the part that completes it, as the example does with "Users can export their data as CSV." An item the input lists under no part is still reviewed as part of this PR, and the review still reports a change that contradicts a later part. The run never works out part ownership from the plan's prose; without this input, the PR is reviewed against the whole contract.

### One stage at a time

#### `archon-triage`

Reconciles an issue, plan, or request with the current code, tracker history, and stated direction, judges whether it is a contract a run can start from, then routes it to investigate, plan, deliver, split, or no action.

**When to use it**: An item may be stale or may prescribe an unverified solution, and you want to know what it needs next before paying for the work.

```bash
archon workflow run archon-triage "#142"
```

**What it produces**: A verdict with the recommended next step. It leaves the checkout unchanged. Pass `--input publish=true` to write the derived labels to the issue. An item that is blocked, or that no route can start from, ends the run not ready, with what it waits on or the questions for its author in the verdict; [continue it with a note](#continuing-a-stage-that-ended-not-ready) that answers it.

#### `archon-intake`

The standing front of the pack, started by trigger bindings on issue and label events rather than by hand. A script checks whether the issue's author is on the project's maintainer list (`.archon/sdlc/policy/maintainers.json`) before any model reads the text. A maintainer's issue is triaged and gets a route label; an outside issue gets `archon-needs-maintainer` and starts no agent until a listed maintainer adds `archon-triage`.

**When to use it**: You want new issues triaged as they arrive without letting anyone who can open an issue spend tokens. The pack's [setup guide](https://github.com/coleam00/Archon/blob/dev/.archon/workflows/sdlc/README.md#set-up-the-pack) runs it by hand and binds it. [Intake](/guides/sdlc-operations/#intake) covers trust, promotion, pickup and closing.

**What it produces**: A work item per issue (`archon state get work/<number>`) holding its trust, stage, triage fields, and history, and the labels that mirror it.

#### `archon-build-queue`

The stage after intake. Intake starts it for an item it routed, through the build-queue binding, and the binding's schedule picks up the rest. Each run claims the triaged item that sorts first, the issue `--input number=<n>` names, or the issue its message describes, runs one round on it from a brief, and reads how the round ended. A round is `archon-ship` without its triage, since intake already triaged the item. A clear case acts on its own: the item is done when its pull request is reviewed Ready at its head, and a correctable finding or a stop the issue already answers starts the item's next round at once through the build-queue binding. An unclear one pauses as one attention item with the agent's recommendation and declared choices; the answer is written into the issue body as a dated "Current scope" section. [Build queue](/guides/sdlc-operations/#build-queue) covers pickup, rounds, the questions it asks and [work orders](/guides/sdlc-operations/#work-orders), which limit a scheduled queue to the items you approved.

**When to use it**: You want triaged issues worked to reviewed pull requests without answering every routine stop yourself. The pack's [setup guide](https://github.com/coleam00/Archon/blob/dev/.archon/workflows/sdlc/README.md#set-up-the-pack) runs it by hand and binds it.

**What it produces**: Reviewed pull requests, the queue's record on each work item (`facts.build`: status, rounds and decisions), and attention items for the decisions that need a person.

#### `archon-merge-queue`

The stage after the build queue, started by a short schedule binding. Each run claims the items whose pull requests the build queue made ready, and one agent sweeps them: it orders them, merges each Ready pull request that passes the gate, hands back to the build queue what it can fix (a conflict, a stale or missing verdict, a review thread that raises a defect, red the change caused), and never pushes or waits for CI itself. Every merge goes through a gate script that reads the pull request fresh and merges pinned to its head. An unclear pull request, such as a very large change, is asked about as an attention item labelled `kind: approve`, and a red base branch ends the sweep as a failed outcome that names the diagnosis, with nothing merged and nobody asked. [Merge queue](/guides/sdlc-operations/#merge-queue) covers the gate's conditions, what a sweep returns or reruns, and what each answer does.

**When to use it**: You want reviewed, green pull requests merged without merging each by hand, while changes that need a person still wait for one. The pack's [setup guide](https://github.com/coleam00/Archon/blob/dev/.archon/workflows/sdlc/README.md#set-up-the-pack) runs it by hand and binds it.

**What it produces**: Merged pull requests, the queue's record on each work item (`facts.merge`: status and decisions), and attention items for the decisions that need a person.

#### `archon-discoveries`

Drains the discoveries finished runs recorded outside their own scope. One agent verifies each one against the default branch, merges duplicates across runs and with earlier decisions, and decides: file an issue with a full brief, track it on the open issue that already covers it, drop it with a reason, ask a maintainer, or wait when the code it is about is still on an open pull request, so a later pass decides it after that pull request merges or closes. Scripts perform only the writes it declared.

**When to use it**: Runs keep finding defects outside their change and nobody reads their `discoveries.md`. The pack's [setup guide](https://github.com/coleam00/Archon/blob/dev/.archon/workflows/sdlc/README.md#set-up-the-pack) runs it by hand and binds it. Naming its binding in the merge queue's `discoveries_binding` input also starts a pass after each sweep that merged a pull request. [Discoveries](/guides/sdlc-operations/#discoveries) covers the queue, the decisions and the writes.

**What it produces**: Filed issues and evidence comments, and one state document per drained run (`archon state list --prefix discoveries/runs/`) recording which of its records were decided and any question asked with its answer, so a record is decided once.

#### `archon-split`

Files the issues a large item splits into, when triage routed the item `split`. A large item, such as a PRD, an epic or a bundle of tasks, is built as one work item by default; triage splits it only when building it whole would not work, and says why. Triage passes a PRD only when it states a hypothesis, the signal that proves or disproves it with the command that measures it, and a threshold and window; otherwise it asks for that contract work. One agent checks triage's reason first and can hand the item back to the build queue whole, with why. Otherwise it files only the piece that comes next, each issue a contract of its own: a PRD's current phase, an epic's current increment, or every task of a bundle. The agent's comment on the item names the later phases, each with what the earlier work must show before it is filed. A script files each issue once and posts that comment with the filed issues listed under it. A PRD is labelled `archon-prd` and stays open; an epic stays open until its increments merge; a bundle is closed.

**When to use it**: Your issues include PRDs, epics or lists of tasks too large to build as one work item. The pack installs no binding; `archon pack bindings sdlc --only split-queue` writes the one it recommends. [Split queue](/guides/sdlc-operations/#split-queue) covers how an item is sliced and filed. By hand: `archon workflow run archon-split --input number=42` from the repository's checkout.

**What it produces**: The filed issues, which come back through intake, the agent's comment on the item with them listed under it, and the queue's record on its work item (`facts.split`: status, kind and filed issues, or the route when the item was built whole).

#### `archon-worktree-cleanup`

Runs `archon isolation cleanup --merged` across every registered project: each merged worktree goes, with its local branch, including a branch the worktree adopted rather than created. Git base ancestry, patch equivalence, or one merged PR head must cover every existing local tip. Cleanup can discover that PR by the local commits even when it was published under another branch name. Cleanup retains remote branches with a logged warning, including with force. Enable GitHub's **Automatically delete head branches** setting for merged pull requests, or follow [manual remote branch recovery](/reference/cli/#recovering-remote-branch-cleanup). A worktree with uncommitted changes, a live run, or commits the merge does not cover stays. Set `include_closed` to `true` to also accept a closed PR whose head covers every existing local tip.

**When to use it**: You run Archon without a server, whose cleanup schedule already does this, and merged worktrees pile up. The pack installs no binding; `archon pack bindings sdlc --only worktree-cleanup` writes the one it recommends. [Worktree cleanup](/guides/sdlc-operations/#worktree-cleanup) says who removes each checkout.

**What it produces**: The cleanup report on the node's output. It changes no code.

#### `archon-investigate`

Establishes the proven causal chain for a bug, unexplained behavior, or open question, down to the root cause whose fix prevents the symptom.

**When to use it**: The cause is not yet known and you want it proven before anyone writes a fix.

```bash
archon workflow run archon-investigate "Why does the workflow list spin forever when no workflows exist?"
```

**What it produces**: An evidence-backed report a fixer or planner can act on, with a verdict: `rooted` (a change is owed here and the fix is decided), `refuted` (no change is owed in this repository), or `inconclusive` (the cause is not established yet). The repository is left as it was found.

#### `archon-plan`

Turns decided intent, such as a feature request, an investigation report, or an idea, into an implementable plan: the chosen approach with rejected alternatives, verifiable steps, and the validation that proves it.

**When to use it**: You know what to build but not how.

```bash
archon workflow run archon-plan "Add CSV export to the reports page"
```

**What it produces**: A plan artifact. Pass `--input report=<path>` to build on a prior investigation report. The repository is left as it was found. Before it stops to ask a question, it checks whether the work order, the issue's comments, a project document, or a ruling your maintainers recorded in `.archon/sdlc/policy/rulings.md` already answers it; review synthesis does the same before it returns `replan` or `ask`. An addition that leaves every existing value meaning what it meant before is the plan's call, not a person's: the plan lists it under contract additions and the pull request body flags it for the reviewer. Changing what an existing value means, removing something shipped, or changing a persisted shape still stops to ask: the run ends not ready with the questions in the plan; [continue it with a note](#continuing-a-stage-that-ended-not-ready) that answers them. [Policy and models](/guides/sdlc-operations/#policy-and-models) describes the policy documents.

#### `archon-implement`

Implements a change and keeps working until it is complete and the project's own checks pass. It commits as it goes and opens no PR.

**When to use it**: The work is decided and needs building: a plan, review findings, a CI failure, or a plain description.

```bash
archon workflow run archon-implement --branch feat/export-csv "Implement the plan in .archon/plans/csv-export.md"
```

**What it produces**: Commits on the run's branch.

#### `archon-pr`

Opens a pull request for the committed work on the current branch. It neither merges the base nor runs checks: CI judges the pushed head. It uses the repository's PR template when one exists, pushes the branch, and reads the created PR back to verify it. It references a linked issue with `Refs #N`, never a closing keyword, because no review has judged the work yet.

**When to use it**: A branch has committed work and needs a PR. Run it with `--no-worktree` from the checkout that holds the branch.

```bash
archon workflow run archon-pr --no-worktree --input draft=false
```

**What it produces**: A pull request, draft unless you pass `--input draft=false`. On a pull request that already exists it leaves the description as its author wrote it, unless you pass `--input publish_description=true`. It never sweeps in unrelated changes, never rebases, and never force-pushes.

#### `archon-deliver`

The delivery tail, in capped rounds: implement the work with focused checks on what it changes, push and open (or update) a draft PR, and review it, with a structure pass beside the review that looks for a smaller shape; the next round's implementer adopts or declines its findings together with the review's. Once a round's review passes and the structure pass names nothing, an agent reads the checks once and hands the PR off ready without waiting for CI (the full validation): pending checks and red outside the change are the merge queue's to judge before it merges. A project with no CI (`ci: none`) gets the full validation from that agent instead, and a round ends ready only when the agent recorded one that passed at the head. Review findings, smaller shapes, a check already red because of the change, and a conflict with the base go back to the implementer for another round (it merges the base on a conflict, never rebasing), up to four rounds. Each correction is reviewed on its delta, leaving out code a merge of the base brought in, by the general code reviewer, which judges every prior finding, plus any lens the route agent adds because the delta reaches new ground in its area. Any other ending is not ready, with its reason. When the work requires content in the PR description, such as benchmark results, the round publishes it into a marked section of the description before review reads the PR, leaving the rest of the description as written. Finally it updates the PR description. The description closes its issue (`Closes #N`) only when the last review's contract coverage marks the required outcome and every acceptance item met and no dated ruling on the issue keeps it open; otherwise it says `Refs #N` and lists what is left or names the ruling. The description lists the contract items left open and names a ruling that keeps the issue open; the run's outcome carries the typed reason and the deciding node's summary. Before merging, the merge queue rechecks the keyword against the review's stamped coverage and the issue's latest ruling, and corrects it in either direction. `--input pull_request=<number>` continues that open PR instead of opening one. `--input prior_report=<path>` names the published review report of that PR from an earlier run's artifacts, so the first round's review continues from it. `--input branch=<name>` opens the PR from that branch instead of the checkout's, or updates the open PR that already has it as its head. `--input part=<json>` delivers one part of a multi-part plan, as described for `archon-ship`. When the rounds end not ready, the run ends with the reason; [continue it with a note](#continuing-a-stage-that-ended-not-ready) for another batch of rounds on the same PR. It never pauses for approval of a ready PR; your gate is PR review and merge.

Unresolved review threads on the pull request are work too, whoever opened them: a person, a review bot, or nobody in a project without outside reviewers. While any is open, a ready pull request goes back to draft and the round ends not ready. The next round's implementer fixes each thread or declines it with evidence, and the run posts the replies and resolves those threads. A thread about code the pull request doesn't change or make reachable, or one a dated ruling in the issue body already decided, is settled with a reply saying so. A thread no agent can settle ends the run asking. Threads gate delivery, not the review's own verdict.

A pull request counts as ready only at the commit its review comment stamps. The comment's first lines carry the reviewed commit, the verdict and the contract coverage, which the merge queue reads. Delivery never marks ready a head carrying commits the round's review did not cover. Commits pushed after a run ends, by hand or by another run, are reviewed by a continuation delivery of that pull request, or by `archon-review`. Either one reviews the whole change again unless you pass the earlier run's `review/published/report.md` as `prior_report`: then its first review checks that report's findings and reviews only what changed since the commit it reviewed. The build queue passes it for you, as [its guide](/guides/sdlc-operations/#how-a-round-runs) describes.

A workflow that includes `archon-deliver` keeps running after a failed delivery, because the delivery's report completes either way. Gate what follows on `$deliver.output.ready`.

**When to use it**: The work is decided, for example an approved plan, and should become a reviewed, ready-to-merge PR.

```bash
archon workflow run archon-deliver --branch feat/export-csv "Deliver the plan in .archon/plans/csv-export.md"
```

**What it produces**: A PR marked ready for review, with one canonical review comment.

### Review

#### `archon-review`

Reviews a change through specialist lenses and produces one evidence-based verdict. Every round, a quick route agent picks the lenses the change earns: seams (on unless the change touches no type, contract, state or boundary), code (which uses the configured `large` model tier), tests, errors, docs, and ux (for a change a person sees or does in a browser: it starts the app and uses the change, on the `large` tier). `--input errors=true` or `false` overrides its errors call. A continuation (`--input prior_report=<path>`) reviews the correction delta only (code a merge of the base brought in is left out). The general code reviewer always runs and judges whether each prior finding was resolved or validly declined; every lens that raised a blocker the previous round left open runs again to verify its findings and check the fix for new defects in its area; the route agent adds another lens only when the delta reaches new ground in its area. When the verdict is not ready, three independent verifiers judge each blocking finding, and one that at least two of them reject is demoted: to a discovery when it predates the change, to disproved when it is not real. Findings from the contract check are never demoted. The review also holds the change to its stated contract, taken from the PR description or a work order you pass: each stated acceptance item and invariant is met with cited evidence or raised as a blocking finding. `--input part=<json>` reviews one part of a multi-part plan, as described for `archon-ship`.

**When to use it**: A PR or your working diff needs judging. It never edits code. On a PR it posts or edits its review comment; it never changes the PR's draft state.

```bash
archon workflow run archon-review --input scope=87 --branch fix/login-redirect
```

Replace `fix/login-redirect` with the PR's head branch for a same-repository PR. `--branch` reuses an existing healthy worktree without advancing it. Before rerunning, locate it with `git worktree list` and check for local changes. Only when clean, run `git -C <worktree-path> pull --ff-only <base-clone-url> <PR-head-ref>` with the PR's actual values. Verify its HEAD equals the current PR head SHA before rerunning. Stop on local changes, divergence or an ahead checkout and reconcile them before retrying. For a fork PR, fetch its head into the launch repository first, then start a fresh review branch at that commit:

```bash
git fetch <fork-clone-url> <PR-head-ref>
archon workflow run archon-review --input scope=<PR-URL> --branch <fresh-review-branch> --from <PR-head-SHA>
```

Use the fork's actual clone URL, head ref and full head SHA, and choose a review branch absent locally, on the configured remote and from existing worktrees. `--from` only applies to a new branch; `--branch` alone cannot resolve a fork-only ref and would create it from the base. The review reads the checkout. If its commit differs from the PR head, the run still reviews the checkout but refuses to publish, naming both commits.

**What it produces**: A synthesized review report. When reviewing a PR whose head is the reviewed commit, the report is posted as one comment and edited in place on re-review. Empty `scope` selects the current branch's open PR first, otherwise the working diff. A Ready verdict leaves a draft PR a draft; take it out of draft on the forge.

### Maintenance

#### `archon-metrics-prs`

Records the outcomes of the pull requests the build queue opened as metrics: how many were opened, merged and abandoned, the merge rate, the review rounds each merged one took to reach Ready, and the issues the queue built and merged, by route. One run records the pull requests and issues that changed in the last seven days, or in the window `--input since=<date or Nd>` and `--input until=<date>` name. With `--input lines_since=<window>` it also records the test and production lines each merged pull request added. Each record is attributed to the build-queue runs that built its pull request, so `archon metrics --compare` splits pull requests by when those runs started. Pull requests a round only continued count in no metric. [SDLC factory metrics](/guides/sdlc-metrics/) defines every metric.

**When to use it**: You want current factory PR counts, merge rate and review rounds, or to compare them before and after a pack change. Run it on demand, or schedule it with the binding `archon pack bindings sdlc --only metrics-prs` writes; the pack installs none.

```bash
archon workflow run archon-metrics-prs
archon metrics sdlc.pr_merge_rate --since 2026-10-01
```

**What it produces**: Metric records on the node's output, read with [`archon metrics`](/guides/metrics/). It changes no code.

#### `archon-metrics-test-value`

Judges the tests in each factory pull request merged since a date, one `archon-metrics-test-value-judge` run per pull request, and records `sdlc.tests_added` and `sdlc.tests_unprotective`: how many tests it added or changed, and how many of them protect nothing on their own merits, as tests in the suite and not against what the pull request promised. [Test value](/guides/sdlc-metrics/#test-value) says what the judge reads, how to calibrate it and what its identity is.

**When to use it**: You want to see whether factory pull requests carry tests that protect nothing. Calibrate the judge first with `archon-metrics-test-value-calibrate`, which scores it against the pull requests you labeled by hand in `.archon/sdlc/metrics/test-value-cases.json`.

```bash
archon workflow run archon-metrics-test-value-calibrate
archon workflow run archon-metrics-test-value --input since=7d
archon metrics sdlc.tests_unprotective
```

**What it produces**: Metric records on the node's output. Each judged pull request costs one judge run on the `large` tier. It changes no code.

#### `archon-review-eval`

One sample of the review bench, which measures a change to the review itself: a prompt, a lens or a model. The bench plants known defects into real merged changes and runs the shipped review and the simplify pass on each, in a sealed checkout with no later history, so a lens can find a defect only by reading the change. A separate judge run (`archon-review-eval-judge`, on the `large` tier) scores what each lens found.

**When to use it**: You changed the review or want to compare models on it. The workflow is not meant to be run by hand: the bench script in the pack's source launches it, once per sample. It needs a source checkout of the pack and a case set, which the Archon repository keeps at `.archon/sdlc/eval/review/set.json`.

```bash
bun .archon/workflows/sdlc/review-eval/scripts/bench.ts run \
  --set .archon/sdlc/eval/review/set.json --batch <case> \
  --version <version.yaml> --judge <spec> --out <dir>
```

Each `--version` file names a label, the pack commit to run and the provider and model for each tier; pass several to compare them. `--judge` is the model that scores the samples. `--samples` repeats each case.

**What it produces**: One line per sample in the output directory and a page per case comparing the versions, with each sample's cost. Every sample costs one full review run and one judge run. It records no metric and changes no code.

## Continuing a stage that ended not ready

`archon-ship`, `archon-triage`, `archon-plan`, `archon-deliver` and `archon-review` never pause for a person when you run them yourself. Each ends with its outcome as the run's result. `archon workflow get <run-id>` shows whether it got there; `archon workflow get <run-id> --json` carries the stage's typed outcome, ready (delivered, for `archon-ship`) or not, in `terminal_record.returns.value`, and `archon workflow artifacts <run-id>` lists the reports that say why. To take one further, start it again in the same checkout with the original item and your note as the message, or repeat the `--input` that named the item, since a message that is only the note becomes the work:

```bash
archon workflow run archon-deliver --adopt <run-id> "#142: the flaky test is out of scope; skip it"
```

[`--adopt`](/reference/cli/#continuing-an-existing-estate) starts the new run in the prior run's worktree and branch, so a delivery continues its pull request. The prior run's artifacts stay in the directory `archon workflow artifacts <run-id> --json` reports as `artifactsDir`: name a report by that path in your note. A review continues only from an input: pass `--input prior_report=<artifactsDir>/review/published/report.md` to `archon-deliver` or `archon-review`, or the first review reads the whole change again. The checkout must be at a commit that descends from the one that report reviewed. Repeat any other `--input` the first run had. `archon-triage` runs in the launch checkout and has no worktree to adopt, so run it again the same way without `--adopt`. The queues compose these same workflows and raise their own attention items when they need you.

## Summary

| Workflow | Use When | Creates PR? | Changes code? |
|----------|----------|-------------|---------------|
| `archon-ship` | Issue or request to reviewed PR | Yes | Yes |
| `archon-triage` | Decide what an item needs next | No | No |
| `archon-intake` | Triage new issues as they arrive (trigger-started) | No | No |
| `archon-build-queue` | Work triaged issues to reviewed PRs (trigger-started) | Yes | Yes |
| `archon-merge-queue` | Merge reviewed, green PRs the build queue finished (trigger-started) | No | No |
| `archon-discoveries` | File, track or drop what finished runs discovered | No | No |
| `archon-split` | File the issues a large item splits into when it can't be built whole (trigger-started) | No | No |
| `archon-worktree-cleanup` | Remove merged worktrees on a schedule | No | No |
| `archon-investigate` | Root-cause a bug or question | No | No |
| `archon-plan` | Plan decided intent | No | No |
| `archon-implement` | Build decided work | No | Yes (commits) |
| `archon-pr` | Open a PR for committed work | Yes | No |
| `archon-deliver` | Decided work to reviewed PR | Yes | Yes |
| `archon-review` | Review a PR or the working diff | No (comments on a PR) | No |
| `archon-metrics-prs` | Count factory PRs, their merge rate and review rounds | No | No |
| `archon-metrics-test-value` | Count factory tests that protect nothing on their own merits | No | No |
| `archon-metrics-test-value-calibrate` | Score the test-value judge against hand labels | No | No |
| `archon-review-eval` | One sample of the review bench (launched by the bench script) | No | No |

## Workflows that no longer ship

Archon 0.12.0 stopped bundling the older `archon-*` workflows, such as `archon-fix-github-issue`, `archon-idea-to-pr`, `archon-smart-pr-review`, and `archon-assist`. Most have an `sdlc` replacement: use `archon-ship` for issue fixing and idea-to-PR work, `archon-review` for PR review, and `archon-plan` followed by `archon-deliver` for plan-to-PR. For questions, ask in chat.

To keep using one of the old workflows, copy its YAML from [`.archon/workflows/defaults/` at v0.11.1](https://github.com/coleam00/Archon/tree/v0.11.1/.archon/workflows/defaults) (most are in its `legacy/` folder) into your project's `.archon/workflows/`, and the commands it uses from [`.archon/commands/defaults/` at v0.11.1](https://github.com/coleam00/Archon/tree/v0.11.1/.archon/commands/defaults) into `.archon/commands/`. `archon-idea-to-pr`, `archon-plan-to-pr` and `archon-issue-review-full` also need `archon-review-block.yaml` from the same `legacy/` folder, because they include it. Keep its name: the `sdlc` pack's own review is `archon-review`, so the copy replaces nothing.

## Your own workflows

`archon workflow list` shows the bundled workflows and the ones in your repository's `.archon/workflows/`. A workflow you write overrides a bundled one with the same name.
