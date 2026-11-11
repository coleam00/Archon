---
title: Operate the SDLC factory
description: How each queue of the bundled sdlc pack picks up work, decides, asks and records, and the settings, bindings and state documents an operator works with.
category: guides
area: workflows
audience: [user, operator]
status: current
sidebar:
  order: 14
---

This page is the operator manual for the bundled `sdlc` pack. Set the pack up first, with the [setup guide in the pack's README](https://github.com/coleam00/Archon/blob/dev/.archon/workflows/sdlc/README.md#set-up-the-pack). [The SDLC factory](/getting-started/sdlc-factory/) says what the factory is and what it writes. [SDLC pack workflows](/reference/sdlc-workflows/) lists every workflow and what it produces. This page says how the queues behave once they run: what each one picks up, what it decides on its own, what it asks, and what it writes down.

## Pack settings

A project sets the pack's settings in `.archon/packs/sdlc.yaml`. The pack's README says what each setting means and how to choose it: [Choose the pack settings](https://github.com/coleam00/Archon/blob/dev/.archon/workflows/sdlc/README.md#6-choose-the-pack-settings).

## Bindings

The pack installs no binding and starts nothing by itself. Its README lists the bindings it recommends and how to write and register them with [`archon pack bindings sdlc`](/reference/cli/#pack-bindings): [Let it run on its own](https://github.com/coleam00/Archon/blob/dev/.archon/workflows/sdlc/README.md#10-let-it-run-on-its-own). Each queue's section below says why its binding has the capacity and overlap policy it has. [Workflow triggers](/guides/workflow-triggers/#choose-a-resource-capacity-and-overlap-policy) explains resources, capacity and overlap.

## Policy and models

The queues decide clear cases on their own and ask about unclear ones. The pack's default policy for each decision lives in [`.shared/policy/`](https://github.com/coleam00/Archon/tree/dev/.archon/workflows/sdlc/.shared/policy):

| File | Decides |
|---|---|
| `triage.md` | What triage accepts, and what may close without a person |
| `build.md` | What the build queue continues on its own and what it asks |
| `merge.md` | Which pull requests merge on their own: by default small fixes, small features, tests and docs. Schemas, auth, large or partial work are asked |
| `rulings.md` | Answers your maintainers already gave, read before plan or review stops to ask |
| `discoveries.md` | When a discovery is filed, tracked or dropped |
| `ui-check.md` | How review starts your app to use a user-facing change in a browser |
| `attention.md` | What an attention item tells the person who decides it |
| `review-lens.md` | How every review lens stays read-only and records findings and discoveries |

To change one, put only the lines to add or override in `.archon/sdlc/policy/<file>`. The agent reads the default first, then your file, and your line wins where they conflict. A policy file can be a pointer to documents the project already has.

Each stage picks its model from a concern alias, falling back to the tier it has always used. With nothing set, you get the tier models.

| Alias | Nodes | Falls back to |
|---|---|---|
| `@triage` | triage | `medium` |
| `@planner` | plan | `large` |
| `@investigator` | investigate | `medium` |
| `@implementer` | implement | `large` |
| `@reviewer` | every review agent and simplify | each node's tier |
| `@review-<lens>` | one lens: `seams`, `code`, `tests`, `errors`, `docs`, `ux` or `simplify` | `@reviewer`, then the lens's tier |
| `@review-route` | review's lens router | `small` |
| `@pr-prepare` | the pull request's title and body | `medium` |
| `@settle-threads` | delivery's answers to review threads | `medium` |
| `@ci` | delivery's CI hand-off | `medium` |
| `@update-pr-body` | delivery's final description update | `medium` |
| `@build-interpret` | the build queue's reading of a message | `large` |
| `@build-route` | the build queue's launch decision | `large` |
| `@build-answer` | the build queue's decision after a round | `large` |
| `@build-revisit` | the build queue's revisit of blocked items | `medium` |
| `@sweep` | the merge queue's sweep | `large` |
| `@discoveries` | the discoveries decision | `large` |
| `@split` | the split queue's slicing | `large` |
| `@test-value-judge` | the test-value metric's judge | `large` |
| `@review-eval-judge` | the review bench's judge | `large` |

```bash
archon ai alias set @reviewer codex gpt-6.1-sol                                   # every run
archon workflow run archon-build-queue --model @reviewer=codex/gpt-6.1-sol ...    # one run
```

The first alias your config defines wins; `aliases:` in `.archon/config.yaml` sets them too. A lens alias overrides only its lens: with `@reviewer` on Codex and `@review-seams` on Claude, seams runs on Claude and every other lens on Codex. An alias you do not define changes nothing: its node runs on the tier it falls back to.

## The forge and the repository

Every pull-request, issue and check read and write the pack makes goes through `archon forge` and an installed forge plugin. When the plugin cannot answer (no plugin for the host, no credential, a failed operation), the node refuses; nothing falls back to another tool. [Use the forge path in the SDLC pack](/reference/forge/#use-the-forge-path-in-the-sdlc-pack) covers the plugin, the credential order, which operations each stage needs, and the forge check that runs before delivery spends. Run that check alone with `archon workflow run archon-forge-check` from a checkout.

The queues take the repository from their `repo_host` and `repo_path` inputs, which a binding passes. Left empty, as in a run started by hand from a checkout, the repository is the one the forge's `resolve` operation finds for the checkout's remote: its only remote, or `origin` among several. A checkout whose remote resolves to no repository, or that has several remotes and no `origin`, refuses the run and says so. A checkout whose `origin` is a fork works on the fork; set both inputs to choose another repository.

Delivery decides which remote holds a repository by the remote's configured URL, never by its name. A fork checkout whose `origin` is the fork and whose `upstream` is the canonical repository fetches the base and pushes the head where they belong.

## Work items and claims

Each issue has a work item: the state document `work/<number>` in the project's state scope, read with `archon state get work/<number>`. The document is the item's state: its trust, stage, triage fields, the related work triage found (overlapping issues, earlier attempts and merged changes on the same surface), promotion, claim, a short history, and each queue's record under `facts`. The issue's pack labels mirror it. A label a person adds is a request, never the state.

Every queue claims an item with a conditional write, in one order: most urgent, then most important, then smallest, then oldest. An untriaged item sorts after triaged ones, oldest first.

A claim takes the work item's engine lease. The next pickup releases a claim whose lease the engine reports ended: its run completed, was cancelled or abandoned, or was deleted. A claim whose run is pending, running, paused or failed is never released, because a failed run can resume. Abandon the run to free its claim. There is no age timeout. A queue run that claims nothing while a stored item is stuck, because its document does not parse or its claim's run holds no engine lease, names the item and completes with a failed outcome, so the attention watch shows it.

A claim that carries no lease of its run is held, and an idle pass names it. Abandoning its run does not free it. Clear it by writing the document back with `claim` set to `null`, through a conditional `archon state put work/<number> --if-revision <n>`.

## Intake

`archon-intake` is the front of the pack. Trigger bindings start it on issue events.

- **Trust.** Intake reads `.archon/sdlc/policy/maintainers.json` at the head of the default branch and records once whether the issue's author is on it. The file is a JSON array of forge logins, compared without regard to case. No file means an empty list, so every author is outside. Any other shape refuses the run.
- **Outside items** get `archon-needs-maintainer` and nothing else. No agent runs and nothing is posted.
- **Promotion.** A listed maintainer promotes an outside item by adding `archon-triage`. The label binding takes who added it from the forge event. An event without an actor rejects the binding, and an empty or unlisted actor promotes nothing. A promotion pins the issue body's digest as it was when intake recorded the request. An edit after that demotes the item back to `archon-needs-maintainer`, and the history records both digests.
- **One request label.** `archon-triage` is how a person asks for a triage: on a maintainer's item it re-triages, and on an outside item it is also the promotion. Route and state labels are written by the pack and request nothing; one a person adds by hand starts no run and is removed as stale at the item's next intake write.
- **Run requests.** A pack run that sends an item back to intake records its own re-triage request on the work item, naming the run, and starts one intake pickup. The history names the run. The request re-triages a maintainer's item or a promoted outside item. On an outside item no maintainer promoted it is refused: a run's request never promotes.
- **Pickup.** A run started by an issue event, or by `archon-triage` being added, records the event as a request on its issue. Every run then claims the waiting item that sorts first. A request that arrives while its item is claimed waits for the next intake run. An open, edit or reopen adds no request while another one waits, since the pickup reads the live issue. An item keeps its newest 50 label requests.
- **A request label without a request.** An `archon-triage` label whose request no run has claimed may have a request on its way, so a run leaves it for the run that claims that request. It waits one pickup; the next pickup that still finds no request for it removes it.
- **Released claims.** A run clears its claim only after the item's labels are written. When a pickup releases an ended run's claim, it queues that run's requests again. The item then sorts after every other waiting item until an attempt finishes, so one item that cannot be read or labelled never starves the rest.
- **Questions.** Triage asks whether a run can start from the item and through which route; a missing element of a strong brief is not by itself a refusal, and an under-shaped item goes to plan. When no route can start, the item is labelled `archon-needs-contract` and intake posts triage's questions, at most five, as one marked comment. Triage never rewrites the author's text. The author answers by editing the issue or in a comment, and a listed maintainer adds `archon-triage` to have it triaged again. A triage that could not read the forge records no verdict: the run fails and the item stays untriaged.
- **Closing.** When triage's verdict is no action, the item is a duplicate of another open issue or a merged change already delivered it, and the triage policy lets it close without a person. Before writing anything, intake checks a duplicate's declared original: it must be another item, an issue rather than a pull request, open, and at the declared URL. When a check fails, the item is stored and labelled blocked with the reason, for a maintainer to decide. Otherwise intake writes the work item and labels, comments on the issue with a link to the original or the change, and closes it as `duplicate` or `completed`. A duplicate's original gets a comment linking back. Each comment is one marked comment, so a repeated run edits it instead of adding another. An item already closed for the verdict's reason still records the work item and its labels, but posts no comment and is not closed again. One closed for another reason fails the run before any comment. A demoted item and every other verdict close nothing.
- **Only intake closes.** `archon-triage` run alone, even with `publish`, only labels the item `archon-close`.
- **Closed issues.** Intake records the event and changes nothing else: no trust decision, no stage change, no label write.
- **Inputs.** `label_actor` is the one input that can create a promotion, never trust. Only the binding, or someone with access to the install, can supply it.

Two bindings in the GitHub source plugin's configuration start intake: `intake-issues` on an issue opened, edited or reopened, and `intake-labels` on `archon-triage` added. They share one resource with `overlap: queue`, so runs queue instead of overlapping. The label binding's predicate names that label only to save runs: intake ignores any other label, and the pack's own route-label writes start no intake run. A binding file written before this change still lists the route labels; write it again with `archon pack bindings sdlc --only intake-labels`.

## Build queue

`archon-build-queue` takes intake's triaged items to a reviewed, ready pull request, and stops only for decisions that belong to a person. It acts on its own when a case is clear and asks when it is not. The default policy for which is which is [`build.md`](https://github.com/coleam00/Archon/blob/dev/.archon/workflows/sdlc/.shared/policy/build.md), which a project extends with its own `.archon/sdlc/policy/build.md`.

### What a run picks up

- **The next item.** A run claims one item. An item waits for the build queue when its work item's stage is a ready route (deliver, continue, plan or investigate) and the queue has not recorded it, or recorded it as waiting for its next round. A `split` item is the split queue's. A re-triage after the queue's last decision starts the item over. The build queue's claim takes none of the item's intake requests, so an edit or label request recorded while it holds the item waits for intake's next pickup. The queue writes no labels.
- **A named item.** `--input number=<n>` makes the run claim that issue instead of the first in order. One launch per issue lets you choose what a run builds and, with the launch's config, which provider builds it. An issue that cannot be claimed refuses the run before any agent, with why: it has no work item, its work item belongs to another repository, another run holds it, or its stage and build status show it does not wait.
- **A message.** A run with no `number` and a message, such as `archon workflow run archon-build-queue "build the retry fix"`, has an agent resolve the message through the forge's reads to one typed decision:
  - build one issue, which the run then claims as a named item;
  - choose between several, which pauses as an attention item labelled `kind: pick`, recommending the issue the message most likely means, and claims the issue you pick;
  - write a [work order](#work-orders) for several issues to build, claiming none of them;
  - file new work no issue covers, such as a pasted brief or a file, as an issue, and hand it to `archon-intake` detached, so the run builds nothing;
  - refuse the run with the agent's reason.

  A message that explicitly asks for several issues to be built together, such as "build #122 and #123 in one pull request", files one combined issue carrying each original's contract. Its `Delivered together` section lists the originals, and the delivery's pull request references and closes them with it. The agent never groups issues the message did not ask to group. Scripts claim, write and file only what the agent declared. A run with a `number` ignores its message.
- **Blocked items.** Intake's blocked verdict can go stale while work lands in parallel: a blocker's outcome can arrive another way while its issue is still open. With `revisit_blocked` set to `true`, a run with no `number` also revisits the blocked items, beside the item it builds. It lists the unclaimed blocked items not revisited in the last six hours, and records the revisit on each as it lists it, so runs that are live at once never judge the same item and a scheduled queue does not judge the same items every run. One agent reads each issue, what it waits on and the default branch, and names the items that no longer look blocked. Each of those gets the run's own re-triage request and one `archon-intake` pickup. No label is written and no maintainer is credited. Intake stays the judge: its verdict decides whether the item now waits for the build queue. An item whose pull request create is unresolved is still revisited.

### How a round runs

- **Route.** The route agent is the one judge before a round spends. Intake triaged the item, and the round does not triage it again. The agent checks that a run can start from the issue body, read with its dated "Current scope" sections, and that triage's verdict still holds on the current checkout, asking for a re-triage when it does not. It proves a bug's symptom before the item's first round, declares the round's route, and writes the brief the round starts from. A bug that needs a browser is reproduced with the playwright-cli skill. The route is triage's on the item's first round. A later round that continues its pull request is `continue`, and goes back to `plan` only when a review asked for a different design or the scope changed.
- **The pull request.** The queue reports the open pull request in the item's repository as the candidate, and the route agent declares whether the round continues it, unless a dated scope section or a recorded answer supersedes it. Delivery finishes a continued pull request whichever route the round takes, pushing onto its head so the same pull request updates. A superseded one is never checked out or pushed to: the round starts fresh, refusing a checkout that is not on the default branch, and its brief asks for the old pull request to be closed as superseded once the replacement opens. A closed or merged pull request, or one from a fork, is asked about; a round launched anyway never continues it. A round that continues none opens its pull request from `build/<issue>-<slug>-<run>`, a name never reused.
- **One round.** A round is `archon-ship` after its triage: investigate or plan when the route needs it, then the delivery tail.
- **The decision.** An agent reads how the round ended and decides:
  - `done` when the pull request's latest review says Ready at its head commit and no check that no round can run is still outstanding. A dated scope section records such a check as met; otherwise the queue asks for it once.
  - `continue`, with a brief, when the contract already answers what stopped the round: a correctable finding, CI red the change caused, a false blocker naming a later step.
  - `ask`.

  Before any `continue`, the agent compares the whole change with the contract's shape, and asks when a correction would add machinery the contract does not name. It never continues a pull request that changed nothing material since its last review, no commits or only cosmetic edits; that round ends as done or ask by the same rules.
- **The next round.** A `continue` starts the item's next round at once by firing your build-queue binding (`build_queue_binding`) with the item's `number`, keyed so one run starts at most one next round per item. The binding's resource, capacity and overlap policy apply, as for a scheduled pass. When the fire is skipped or refused, or no binding is set, the run's summary says why and the item waits for the next queue run.
- **Round cap.** When a round ends wanting another and `round_limit` rounds (default 3) have run since the item's scope last changed, by a re-triage or a maintainer's answer, the agent also compares their reviews. Each round finding new defects asks the scope question instead of running another round.
- **Writes.** The queue refuses an attention item without the choice it recommends, pushes the commits the round left unpushed (never forcing, and reading the remote head back), then records the decision on the work item and releases the claim, in one conditional write. A run that asks keeps its claim while it is paused.
- **An already reviewed pull request.** When the route agent finds the pull request already reviewed Ready at its current head, the queue takes it out of draft without another round, checking the head before and after. A head that changed in between fails the run and puts the pull request back to draft. If that correction fails too, the failure reports the observed head, state and draft status: inspect the pull request, restore draft if it is still open and ready, and review its current head before marking it ready. The merge queue still owns the exact-head review and merge checks.
- **Dead rounds.** When a pickup releases the claim of a run that ended before recording its round, the newest pull request from that run's branch, open, closed or merged, is recorded as the run's round, and the next round sees it as its candidate. A round that failed after publishing still records its pull request.
- **An unresolved pull request create.** When a round's pull request create was submitted but no pull request could be verified, the delivery reports `pr_create_unresolved`. The build queue then refuses to select another pull request or branch for the item until a newer triage settles it: it names the reconciled pull request, or names none and the next round opens one.
- **Closed issues.** An item whose issue was closed is parked without an agent.

### What it asks

An unclear decision pauses the run as one attention item labelled `stage: build` and `kind: route`, `kind: stop` or `kind: scope`, with the issue number as `item` and its pull request's as `pr`. The deciding agent writes the item, and it reaches you as written: a question whose first sentence names the issue and the decision and which carries the evidence, what happens if nobody answers and the links; the options and what each does; and a recommendation with its reason and confidence. No script checks the item first. One the wait cannot ask, because two options share an id or the recommendation names no option, fails the run after the item is recorded as asking: abandon that run and re-triage the item.

The answer is one declared choice, or `other`, which every item offers: its text says what to do instead and becomes the ruling, and the item continues from it. The queue never reads the answer's prose for a decision. It writes the choice's ruling and your words into the issue body as one dated "Current scope" section, reads it back, and records the answer.

- A `continue` choice starts the item's next round at once through the build-queue binding. If the round does not start, the item waits for the next queue run.
- A `ready` choice hands the pull request to the merge queue as it stands, as after a maintainer finished it by hand. The merge gate still checks it. An item with no pull request refuses the answer.
- A `park` choice stops working the item until a re-triage.

A run cancelled while it waits leaves the item asking, and only a re-triage starts it over.

### What it records

The work item's `facts.build` holds the item's status, which says who owns it: the build queue, the merge queue, or no queue when it is parked. It also holds the brief the next round starts from, the item's last ten rounds, each with the route it took, and its last twenty decisions with any maintainer's answer.

### Its binding

A schedule keeps items moving, because a run works one item and a continuation waits for the next run when no binding is set. Each run changes its checkout, so every run needs its own worktree: the `build-queue` binding launches in a worktree, with `overlap: skip`.

The binding's `build_queue_binding` input names the binding's own file, so a run's follow-up rounds start through the same binding. One run of the queue holds a slot of the resource while it fires its follow-up, so the follow-up needs a free slot. Under `overlap: skip`, a follow-up fired while every slot is busy is dropped, and the item waits for the next scheduled run. Without the input, every follow-up waits for the next scheduled run.

To start a run as soon as intake routes an item, add a label binding on the same resource, with intake's label selector narrowed to the route labels the build queue works (`archon-ready`, `archon-plan`, `archon-investigate`) and the same launch.

### Work orders

A work order is the set of work items you approved for the factory, so the queue's schedule can stay on while you choose what builds. Set `"orders_only": "true"` in the binding's `launch.inputs`, and a run that names no item claims only a waiting item that is a member of an open order, in the usual pickup order. With no open order it claims nothing. A named item (`number`) is claimed either way, so a member's follow-up rounds still start. The default, `"false"`, picks from every waiting item.

An order is one state document, `work-order/<id>`, in the project's state scope, whose key is the repository's `owner/repo`. The easiest way to write one is to name its members in a build-queue run's message:

```bash
archon workflow run archon-build-queue "build #123, #130 and the Pi login fixes" --detach
```

The agent resolves the message to issues and declares the order's `id`, its members and the parts of the message it could not resolve, with why. An order written this way has at least two members. The run writes the document as `open`, approved by the run's Archon user (its id, which `archon user list` names) at the time of the write; a run with no recorded user refuses. The write is conditional on the document not existing, so an `id` already taken refuses the run and leaves that order as it was. A member intake has never seen gets an `archon-intake` run started detached. The run claims none of the members, and its summary lists the order, the members sent to intake and the unresolved parts. The scheduled build queue, with `orders_only` on, builds them over its next runs.

Members are built separately, one pull request each. To build several issues as one item instead, say so in the message ("build #123 and #130 together"): the run files a combined issue for intake instead of writing an order. The originals keep their own work items, so with `orders_only` off the queue can still pick one up on its own; park or close them, or keep `orders_only` on.

You, or your agent, can also write the document by hand:

```bash
printf '%s' '{
  "version": 1,
  "members": [123, 130, 131],
  "approved": { "by": "<login>", "at": "2026-11-06T12:00:00Z" },
  "status": "open",
  "done_at": null
}' | archon state put work-order/after-0.14 --if-revision 0 --project acme/widgets
```

`members` are issue numbers whose work items intake has recorded. A member is still built only once it waits for the build queue: triaged ready and not already decided. Each member merges on its own, through the merge queue.

While `orders_only` is on, each run that names no item first marks done every open order whose members are all finished, setting `status` to `done` and `done_at`. A member is finished when its work item's latest decision is a merge, with no build or re-triage recorded after it. A member closed without a merge, or with no work item, keeps its order open until you remove it from `members`. To drop an item, or add one, replace the document at its current revision.

A malformed order, including an `open` one with a `done_at` or a `done` one without, refuses a run that names no item, with the order's name, so the queue never builds something no order chose.

## Split queue

`archon-split` breaks a large item into the fewest pieces that each prove something on their own, and files only the piece that comes next. A large item, such as a PRD, an epic or a bundle of tasks, is built as one work item by default. Triage routes it `split` only when building it whole would not work, and its summary says why.

The default triage policy, [`triage.md`](https://github.com/coleam00/Archon/blob/dev/.archon/workflows/sdlc/.shared/policy/triage.md), says when splitting is right, how each kind splits, and what a PRD is: a release that tests a hypothesis, held to its hypothesis, its signal with the command that measures it, and its threshold and window, whether it is split or built whole. A PRD missing any of them gets `archon-needs-contract`, naming the gap. A project refines the bar in its own `.archon/sdlc/policy/triage.md`.

- **Pickup.** A run claims one item. An item waits for the split queue when its stage is `split` and no split finished on it, or a re-triage came after the last one. `--input number=<n>` claims that issue instead, and refuses the run with why when it cannot. The claim takes none of the item's intake requests.
- **Slice.** One agent reads the issue, triage's reason, the triage policy, the project's direction and the current code. It checks triage's judgment first: when one work item would work, it answers `whole` with a build route (plan or deliver) and why. Otherwise it judges the item a PRD, an epic or a bundle. A PRD splits into phases, each proving a desired outcome; an epic into vertical increments, each leaving the product working; a bundle is not sliced, and every task is filed as written. Only the current phase or increment is filed. The agent writes the comment for the item: the plan, with each later phase and what the earlier work must show before it is filed. An open issue that already owns a piece is listed as existing instead of being filed again.
- **Publish.** Each filed issue carries a hidden marker naming the item and the piece, and is recorded on the work item before the next is filed. A piece already recorded is never filed again, and one whose issue was filed but not recorded is recovered by its marker. So a run that stops part way, or the next phase's split after a re-triage, files no issue twice. Each existing issue the agent listed is read to prove it is an open issue of the repository. The item then gets one marked comment: the agent's text as written, with the issues filed from the item listed under it. A PRD is labelled `archon-prd` and stays open until its hypothesis has a verdict; an epic stays open until its increments merge; a bundle is closed as completed. An issue closed before its split finishes is recorded and files nothing more.
- **Next phase.** When the earlier work shows its signal, re-triage the item. It routes `split` again, and the agent files the next phase from the plan in the comment, without filing again what is already filed.
- **Build whole.** On a `whole` answer, the item gets the agent's comment under the same marker and its route label in place of `archon-split`, and its stage moves to that route, where the build queue picks it up as one work item. Triage reads that comment on a later re-triage. An item an earlier split already filed issues from refuses a `whole` answer, since those pieces may be in flight.
- **Record.** The work item's `facts.split` holds the split's status, whether the item is a PRD, an epic or a bundle, every issue filed from it, and the existing issues it adopted with why, kept across phases. For an item built whole it holds only the route; the reason is in the item's history and the comment.
- **The filed issues** come back through intake like any other issue. They are opened by the install's own identity, so intake trusts them only when that login is on the maintainer list.

A schedule keeps items moving, as for the build queue. The run reads the checkout and writes only to the tracker and the state store, so the `split-queue` binding needs no worktree and runs in the launch checkout, with `overlap: skip`. To split an item as soon as intake routes it, add a label binding on the same resource, with intake's label selector narrowed to `archon-split` and the same launch.

## Merge queue

`archon-merge-queue` merges the pull requests the build queue finished, and stops only for decisions that belong to a person. It merges on its own when a case is clear and asks when it is not. The default policy for which is which is [`merge.md`](https://github.com/coleam00/Archon/blob/dev/.archon/workflows/sdlc/.shared/policy/merge.md), which a project extends with its own `.archon/sdlc/policy/merge.md`.

### What a sweep picks up

A run claims every waiting item, up to `limit`. An item waits for the merge queue when its build record is ready and the merge queue has not settled it: it never decided it, or left it waiting or asking. When the build queue readies an item again after the merge queue returned or parked it, it waits again. The pull request is the latest one a build round recorded, or, when no round recorded one, the one triage routed the item to continue. One already merged or closed is recorded without the agent.

The run refuses before it claims anything when the forge plugin lacks an operation the queue needs.

### What it reads

For each pull request the queue reads its head, how many commits of the default branch it lacks, whether it merges cleanly, CI and unresolved review threads at the head, and the review verdict. Every read that names a commit must name the head.

Only a review comment a listed maintainer wrote counts (`.archon/sdlc/policy/maintainers.json` on the default branch); verdicts from other authors are ignored. So the login that authors the pack's published review comment, the forge plugin's credential identity, must be listed. Two trusted review comments on one pull request give no usable verdict, and the gate refuses.

A failed pull-request read waits once. A second consecutive failure parks the item with the read error recorded, until the build queue readies it again. A successful read resets that sequence.

### How a sweep decides

One agent decides every pull request and orders them, least risk first. The queue never pushes, never changes its checkout and never waits for CI.

- **Merge.** A Ready pull request with green CI that the forge reports merges cleanly into the default branch merges, even when it is behind. The default branch's CI on the merge is the next sweep's first fact. Every pull request that can merge in a sweep merges in it.
- **Return.** What the build queue can fix goes back to it with a brief: a verdict that is not Ready or is for another commit (a push after the review), a conflict with the default branch, an unresolved thread that raises a defect in the change, and red the change caused. On a conflict the round merges the default branch in and resolves it, regenerating generated files with their owning script.
- **Rerun.** Red CI in code a pull request does not touch gets one rerun of its failed jobs, counted only when the forge reports it applied. The record stores the head it re-ran at, so the sweep never reruns twice at one head.
- **Ask.** An unclear pull request is asked about as soon as its verdict is Ready at its head, even while its CI is pending or it conflicts. The approval is pinned to that head and a later sweep merges it once the gate passes. An approval carries to a later head only when the sweep judges that everything since the approved head is merges of the default branch and their conflict resolutions, and the verdict is Ready at the later head. Any doubt voids it.

The sweep measures each diff with git against the merge base, not the forge's counts.

### The gate

Every merge goes through one gate script, which reads the pull request and the default branch fresh and refuses unless:

- the verdict says Ready for the head;
- what the [`ci` setting](#pack-settings) trusts passes at the head: green CI, or a passing validation recorded at that head;
- the default branch's CI is not red (pending does not hold a merge);
- the pull request is open, not a draft, into the default branch, at the head the sweep named;
- that head contains the default branch's head, or the forge reports it merges cleanly.

Open review threads are the sweep's judgment, not the gate's: the sweep holds a merge only for a thread that raises a defect in code the pull request changes or makes reachable. The gate merges pinned to that head, by squash unless `--input merge_method=merge` asks for a merge commit, and reports the commit the forge's own read-back says it landed as. A merge the forge cannot verify, as when it queues merges, fails the gate with the forge's outcome, and the sweep waits.

Before merging, the queue rechecks the pull request's closing keyword against the review's stamped contract coverage and the issue's latest ruling, and corrects it in either direction.

### The default branch

The sweep judges the default branch first. While its CI is red the gate refuses every merge, and the sweep always raises it to a maintainer, naming the pull requests merged since it was last green. It recommends a revert or fix-forward, or, when no recent merge touched the red code, a rerun of the failed jobs by hand: the forge's rerun acts only on a pull request, so the pack never reruns the default branch and never reports that it did.

A default branch that cannot be read permits no sweep or merge. The run still records what it can settle without the sweep, then fails with the read diagnostic. Items it left open keep their claims until the run ends: a failed run keeps them until it is resumed and finishes, or is abandoned.

### What it records

The queue reads every pull request back after the sweep: the forge, not the sweep, says what merged, at the head the forge merged.

- A sweep that says it merged a pull request the forge does not show merged fails the run after every other decision is written. That pull request is recorded as waiting, or parked if it was closed.
- A decision for a pull request this run did not claim is skipped and reported, because that item belongs to another run.
- A claimed pull request the sweep left undecided waits for the next sweep.
- A red default branch asks nobody. The sweep merges nothing and the run completes with a failed outcome, which the attention watch shows as a line that needs a look. Read the diagnosis in the `record` node's summary with `archon workflow get <run-id> --verbose`: the failing checks and what each points at, the pull requests merged since the branch was green, the one the sweep suspects, and whether to rerun, revert or fix forward. Every sweep repeats that line while the branch stays red. A sweep that also asked about a pull request ends only once that question is answered.
- A pull request that cannot be read waits for the next sweep. A work item that cannot be written is reported, so one bad item never loses the rest of the batch's record.

The work item's `facts.merge` holds the item's merge status, any approval pinned to the head it approved, and the last twenty decisions. A return sets the build record to waiting for its next round, with the brief. That round then starts at once through the build-queue binding (`build_queue_binding`), keyed by the item and the run, so a re-run of the same record starts it at most once. A round that does not start is named in the summary, and the next build-queue run picks the item up.

### After a merge

- **Merged issues.** A pull request that links its issue with `Refs #N` merges without closing it, and the issue keeps its intake stage, so the build queue could claim it again. With `retriage_merged` set to `true`, the run reads the issue of each build item whose pull request merged, in this run or before it. One still open gets the run's own re-triage request and one `archon-intake` pickup, started detached, outside any binding's capacity. Intake closes the issue as delivered or keeps it with what is still open. A closed issue is left alone. A failed read, request or launch is named in the summary and stops nothing else.
- **Discoveries drain.** When `discoveries_binding` names your [discoveries](#discoveries) binding, a sweep the forge shows merged at least one pull request fires it, keyed by the run, so one sweep starts at most one drain. A sweep that merged nothing fires nothing. A drain that does not start is named in the summary and fails nothing.

### What it asks

A run raises at most one attention item, labelled `stage: merge`: the first pull request the sweep asked about, labelled `kind: approve` with the issue number as `item` and the pull request's as `pr`. The sweep writes it as the build queue's agents write theirs, and it reaches you as written. Any other ask waits for a later sweep, which decides it again.

- **`merge`** approves the pull request at the head that was asked about. The answer starts a sweep at once through the merge-queue binding (`merge_queue_binding`), which merges it once the gate passes there.
- **`return`** hands the item back to the build queue, whose next round starts at once through the build-queue binding.
- **`park`** stops working the item until the build queue readies it again.
- **`other`** is offered on every pull-request item. When the sweep wrote a brief for the build queue, it returns the pull request with your text as the ruling. Without a brief, it records the text and parks the item; no build round starts. A pull request the sweep asks about without a brief offers no `return`.

An answer's ruling and your words are written into the issue body as a dated "Current scope" section.

### Its binding

A run never changes its checkout, and the claim keeps two runs off the same item, so the `merge-queue` binding runs in the launch checkout, with `overlap: queue`.

Its `merge_queue_binding` input names the binding's own file and `build_queue_binding` the build queue's, so an answer's follow-up starts through your own binding. The answering run still holds the merge queue's only slot when it fires the sweep, which is why the binding queues: the sweep a `merge` answer fires waits in line and starts as soon as the answering run ends, at the host's next drain. A server drains every few seconds; a CLI-only host needs `archon trigger drain` scheduled. A scheduled tick that finds a sweep running also waits in line instead of being dropped. With `overlap: skip` the answer's sweep would be skipped and the next scheduled sweep would merge the pull request. Without the inputs, follow-ups wait for the next scheduled run.

## Discoveries

`archon-discoveries` drains the discoveries finished runs recorded outside their own scope. A run's discoveries are its latest review verdict's certified records plus any discovery record a node wrote after that review. No delivery run files them itself.

- **Queue.** A pass lists this project's runs that ended (completed, failed or cancelled) inside `since` and `until`, oldest first, among the newest thousand, and claims up to `limit` of them that still have undecided records. A run's state document `discoveries/runs/<run-id>` is its memory and its work item: the records a pass decided for it, the questions a pass asked about it with their answers, and the claim of the pass working it. A record is decided once its run's document lists it. Claims follow [the same lease rule](#work-items-and-claims) as work items: a failed pass keeps its claims, since it can resume. A run whose records cannot be read is left queued and named on the pass's stderr.
- **Decisions.** One agent decides every queued record, under the project's direction document and the policy files `discoveries.md`, `triage.md` and `rulings.md`. It verifies each claim against the default branch's head, merges duplicates across runs, and searches the tracker before filing. There is no store of decisions across runs: a defect a later run finds again is judged again against the tracker. Each discovery ends in one decision:
  - file an issue with a full brief;
  - track it on the open issue that already covers it, with one marked evidence comment, only when it adds something;
  - drop it with a reason;
  - ask a maintainer;
  - wait, for a discovery about code still on an open pull request. Nothing is written, and its record stays undecided until a later pass decides it, after that pull request merged or closed.
- **Writes.** Before any write, the pass checks that every queued record is decided exactly once and that a tracking issue is open and in the repository. A filed issue's body begins with a hidden marker, and the create looks for that marker across every issue first; the evidence comment carries the same marker and is replaced in place. So a pass run again after a stop, or a discovery filed twice, never opens a second issue. Filed issues carry no labels: intake triages them like any other issue, which it does only when the install's forge identity is on `maintainers.json`.
- **Questions.** Every ask in a pass becomes one attention item labelled `stage: discoveries` and `kind: question`. The answer is stored on the asking run's document. The runs those records came from stay claimed by the asking run until it ends, so no other pass asks again; the next pass then decides them with the answer beside the records.

The `discoveries` binding starts a pass on a schedule, with `overlap: skip`: a start is skipped while a pass still runs, and a pass paused on a question gives its slot back. Naming the same binding file as the merge queue's `discoveries_binding` also starts a pass after each sweep that merged a pull request, when the records about the merged code can first be decided. A fired pass that finds one already running is skipped like a scheduled one, and the next merging sweep or scheduled tick starts it.

## Worktree cleanup

`archon-worktree-cleanup` runs [`archon isolation cleanup --merged`](/reference/cli/#isolation-cleanup-days) across every project registered on the install. It removes each merged worktree with its local branch, including a branch the worktree adopted instead of creating. Removal accepts Git base ancestry, patch equivalence, or one merged pull request head that covers every existing local tip (the worktree's HEAD and its branch ref). Cleanup finds that pull request by the local commits, so it counts even when its published branch name differs.

- A worktree with uncommitted changes, or one a run can still claim, stays and is reported. One with a commit the merge does not cover stays as ordinary unmerged work.
- With `include_closed: "true"` it also accepts a closed, unmerged pull request whose head covers every existing local tip. The default is `"false"`; any other value refuses the run.
- Remote branches are retained with a warning, including with force. On GitHub, enable **Automatically delete head branches** in repository settings, or follow the [remote branch recovery procedure](/reference/cli/#recovering-remote-branch-cleanup).
- It runs in place and creates no worktree of its own.

Who removes each checkout:

- Intake, triage, the split queue, discoveries, the merge queue, the forge check and cleanup create no worktree. They run in the launch checkout as it stands.
- A run that creates a worktree on its own run-named branch, such as a build round, removes it when the run completes, if the checkout is clean and every commit is on a remote; its pushed branch counts. The branch stays. Otherwise the run reports what removing it would lose, and the checkout stays listed by `archon isolation list`.
- A worktree launched with `--branch` waits for the merged sweep.

A server already runs a merged sweep on its cleanup schedule, so the `worktree-cleanup` binding is for installs that run only the CLI. Its resource is named for the host, not the repository, because one pass covers every project registered there: generated for two repositories, the two schedules share one slot and `overlap: skip` drops the second pass.

## Measure the factory

[SDLC factory metrics](/guides/sdlc-metrics/) lists the metrics the pack records about its pull requests, issues, review rounds and tests, and how to read them.
