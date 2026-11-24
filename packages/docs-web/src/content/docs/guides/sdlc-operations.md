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

A project sets the pack's settings in `.archon/packs/sdlc.yaml`: what the merge gate trusts (`ci`), whether the build and merge queues act by themselves or ask first (`build_lane`, `merge_lane`), and the paths whose changes a maintainer approves before they merge (`protected_paths`). The pack's README says what each setting means and how to choose it: [Choose the pack settings](https://github.com/coleam00/Archon/blob/dev/.archon/workflows/sdlc/README.md#6-choose-the-pack-settings).

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
| `@merge` | the merge stage's judge | `large` |
| `@discoveries` | the discoveries decision | `large` |
| `@split` | the split queue's slicing | `large` |
| `@test-value-judge` | the test-value metric's judge | `large` |

```bash
archon ai alias set @reviewer codex gpt-6.1-sol                                   # every run
archon workflow run archon-build-queue --model @reviewer=codex/gpt-6.1-sol ...    # one run
```

The first alias your config defines wins; `aliases:` in `.archon/config.yaml` sets them too. A lens alias overrides only its lens: with `@reviewer` on Codex and `@review-seams` on Claude, seams runs on Claude and every other lens on Codex. An alias you do not define changes nothing: its node runs on the tier it falls back to.

## The forge and the repository

Every pull-request, issue and check read and write the pack makes goes through `archon forge` and an installed forge plugin. When the plugin cannot answer (no plugin for the host, no credential, a failed operation), the node refuses; nothing falls back to another tool. [Use the forge path in the SDLC pack](/reference/forge/#use-the-forge-path-in-the-sdlc-pack) covers the plugin, the credential order, which operations each stage needs, and the forge check the engine runs when a pack run starts.

The queues take the repository from their `repo_host` and `repo_path` inputs, which a binding passes. Left empty, as in a run started by hand from a checkout, the repository is the one the forge's `resolve` operation finds for the checkout's remote: its only remote, or `origin` among several. A checkout whose remote resolves to no repository, or that has several remotes and no `origin`, refuses the run and says so. A checkout whose `origin` is a fork works on the fork; set both inputs to choose another repository.

Delivery decides which remote holds a repository by the remote's configured URL, never by its name. A fork checkout whose `origin` is the fork and whose `upstream` is the canonical repository fetches the base and pushes the head where they belong.

## Work items and claims

Each issue has a work item: the state document `work/<number>` in the project's state scope, read with `archon state get work/<number>`. The document is the item's state: its trust, stage, triage fields, the related work triage found (overlapping issues, earlier attempts and merged changes on the same surface), promotion, claim, a short history, and each queue's record under `facts`. The issue's pack labels mirror it. A label a person adds is a request, never the state.

A run that works one issue is on that issue's engine item, `issue-<number>`: intake, re-triage, every build round, and every merge run. `archon workflow runs --item issue-<number>` lists them with their questions and answers. A pass over many issues (the split queue, a scheduled build pick, the merge stage's backstop) is on no item.

Intake and the split queue claim an item with a conditional write, in one order: most urgent, then most important, then smallest, then oldest. An untriaged item sorts after triaged ones, oldest first. The build queue and the merge stage claim nothing: each build run and each merge run is on its issue's item, and the engine [admits one run of a workflow per item](/guides/workflow-triggers/#one-run-of-a-workflow-per-item), so two runs never build one issue. `archon-build-pick` starts the builds in the same order.

A claim takes the work item's engine lease. The next pickup releases a claim whose lease the engine reports ended: its run completed, was cancelled or abandoned, or was deleted. A claim whose run is pending, running, paused or failed is never released, because a failed run can resume. Abandon the run to free its claim. There is no age timeout. A queue run that claims nothing while a stored item is stuck, because its document does not parse or its claim's run holds no engine lease, names the item and completes with a failed outcome, so the attention watch shows it. Each stuck item is reported once: the report is recorded in the item's history, and later idle runs leave the item out until something else changes it. A document that does not parse cannot carry that record, so every idle run reports it.

A claim that carries no lease of its run is held, and an idle pass names it. Abandoning its run does not free it. Clear it by writing the document back with `claim` set to `null`, through a conditional `archon state put work/<number> --if-revision <n>`.

## Intake

`archon-intake` is the front of the pack. Trigger bindings start it on issue events.

- **Trust.** Intake reads `.archon/sdlc/policy/maintainers.json` at the head of the default branch and records once whether the issue's author is on it. The file is a JSON array of forge logins, compared without regard to case. No file means an empty list, so every author is outside. Any other shape refuses the run.
- **Outside items** get `archon-needs-maintainer` and nothing else. No agent runs and nothing is posted.
- **Promotion.** A listed maintainer promotes an outside item by adding `archon-triage`. The label binding takes who added it from the forge event. An event without an actor rejects the binding, and an empty or unlisted actor promotes nothing. A promotion pins the issue body's digest as it was when intake recorded the request. An edit after that demotes the item back to `archon-needs-maintainer`, and the history records both digests.
- **One request label.** `archon-triage` is how a person asks for a triage: on a maintainer's item it re-triages, and on an outside item it is also the promotion. Route and state labels are written by the pack and request nothing; one a person adds by hand starts no run and is removed as stale at the item's next intake write.
- **Run requests.** A pack run that sends an item back to intake records its own re-triage request on the work item, naming the run, and starts one intake pickup. The history names the run. The request re-triages a maintainer's item or a promoted outside item. On an outside item no maintainer promoted it is refused: a run's request never promotes.
- **Pickup.** A run started by an issue event, or by `archon-triage` being added, records the event as a request on its issue. The run then claims its own issue. A run that recorded no request, or whose issue another run holds, claims the waiting item that sorts first. A request that arrives while its item is claimed waits for the next intake run. An open, edit or reopen adds no request while another one waits, since the pickup reads the live issue. An item keeps its newest 50 label requests.
- **A request label without a request.** An `archon-triage` label whose request no run has claimed may have a request on its way, so a run leaves it for the run that claims that request. It waits one pickup; the next pickup that still finds no request for it removes it.
- **Released claims.** A run clears its claim only after the item's labels are written. When a pickup releases an ended run's claim, it queues that run's requests again. The item then sorts after every other waiting item until an attempt finishes, so one item that cannot be read or labelled never starves the rest.
- **Questions.** Triage asks whether a run can start from the item and through which route; a missing element of a strong brief is not by itself a refusal, and an under-shaped item goes to plan. When no route can start, the item is labelled `archon-needs-contract` and intake posts triage's questions, at most five, as one marked comment. Triage never rewrites the author's text. The author answers by editing the issue or in a comment, and a listed maintainer adds `archon-triage` to have it triaged again. A triage that could not read the forge records no verdict: the run fails and the item stays untriaged.
- **Closing.** When triage's verdict is no action, the item is a duplicate of another open issue or a merged change already delivered it, and the triage policy lets it close without a person. Before writing anything, intake checks a duplicate's declared original: it must be another item, an issue rather than a pull request, open, and at the declared URL. When a check fails, the item is stored and labelled blocked with the reason, for a maintainer to decide. Otherwise intake writes the work item and labels, comments on the issue with a link to the original or the change, and closes it as `duplicate` or `completed`. A duplicate's original gets a comment linking back. Each comment is one marked comment, so a repeated run edits it instead of adding another. An item already closed for the verdict's reason still records the work item and its labels, but posts no comment and is not closed again. One closed for another reason fails the run before any comment. A demoted item and every other verdict close nothing.
- **Only intake closes.** `archon-triage` run alone, even with `publish`, only labels the item `archon-close`.
- **Closed issues.** Intake records the event and changes nothing else: no trust decision, no stage change, no label write.
- **Inputs.** `label_actor` is the one input that can create a promotion, never trust. Only the binding, or someone with access to the install, can supply it.
- **Handoff.** A run that routes its issue to a build ends with that route as its outcome (`investigate`, `plan`, `deliver` or `continue`). The `build-after-intake` run-ended binding then starts the issue's first build round on the issue's item, with no node firing anything. A run that leaves its issue on a build route that waits for no round, such as one started by an edit to an issue already built, ends `unchanged` and starts nothing. A start that finds every slot busy is skipped, and the next pick starts the issue. The start names the issue, so it is built whatever `orders_only` says: an install that builds only work orders does not register this binding.

Two bindings in the GitHub source plugin's configuration start intake: `intake-issues` on an issue opened, edited or reopened, and `intake-labels` on `archon-triage` added. They share one resource with `overlap: queue` and a capacity of 10: each run triages one issue and changes no checkout, so up to ten issues are triaged at once and a later event queues behind them. The label binding's predicate names that label only to save runs: intake ignores any other label, and the pack's own route-label writes start no intake run. A binding file written before this change still lists the route labels; write it again with `archon pack bindings sdlc --only intake-labels`.

## Build queue

`archon-build-queue` takes one of intake's triaged items to a reviewed, ready pull request, one round per run, and stops only for decisions that belong to a person. It acts on its own when a case is clear and asks when it is not. `archon-build-pick` chooses which issues build and starts their runs. The default policy for what the queue decides alone is [`build.md`](https://github.com/coleam00/Archon/blob/dev/.archon/workflows/sdlc/.shared/policy/build.md), which a project extends with its own `.archon/sdlc/policy/build.md`.

### What gets built

- **Waiting items.** An item waits for the build queue when its work item's stage is a ready route (deliver, continue, plan or investigate) and the queue has not recorded it, or recorded it as waiting for its next round. A `split` item is the split queue's. A re-triage after the queue's last round began starts the item over, and the merge queue leaves such an item alone until that round ends. The queue writes no labels.
- **One run, one issue.** A build run builds the issue `--input number=<n>` names and must be on that issue's item: `archon workflow run archon-build-queue --input number=42 --item issue-42`. The engine admits one build run per item, so a second start for the issue waits or is skipped. One launch per issue lets you choose what a run builds and, with the launch's config, which provider builds it. A run refuses before any agent, with why, when it is on another item or none, the issue has no work item, its work item belongs to another repository, or its stage and build status show it does not wait.
- **The pick.** `archon-build-pick` lists every waiting item in pickup order and fires your `build-queue` binding once for each, on the issue's item. The binding admits as many as its capacity has free slots and skips the rest, and the engine skips an issue a build run already holds, so a pick holds no build slot and an item still building, or one that found no slot, is fired again by the next pick. A pick runs on its schedule, and the engine starts one when a build run ends (`build-pick-after-build`), so a freed slot and an item's next round do not wait for the schedule. A build run that failed or was cancelled no longer holds its item, so the next scheduled pick starts the item again.
- **A message.** A pick with a message, such as `archon workflow run archon-build-pick "build the retry fix"`, has an agent resolve the message through the forge's reads to one typed decision:
  - build one issue, whose build run the pick starts, refusing with why when the issue does not wait;
  - choose between several, which pauses as an attention item labelled `kind: pick`, recommending the issue the message most likely means, and starts the build of the issue you pick;
  - write a [work order](#work-orders) for several issues to build, starting none of them;
  - file new work no issue covers, such as a pasted brief or a file, as an issue, and hand it to `archon-intake` through your `intake` binding, so the run builds nothing;
  - refuse the run with the agent's reason.

  A message that explicitly asks for several issues to be built together, such as "build #122 and #123 in one pull request", files one combined issue carrying each original's contract. Its `Delivered together` section lists the originals, and the delivery's pull request references and closes them with it. The agent never groups issues the message did not ask to group. Scripts claim, write and file only what the agent declared. A run with a `number` ignores its message.
- **Blocked items.** Intake's blocked verdict can go stale while work lands in parallel: a blocker's outcome can arrive another way while its issue is still open. With `revisit_blocked` set to `true`, a pick with no message also revisits the blocked items. It lists the unclaimed blocked items not revisited in the last six hours, and records the revisit on each as it lists it, so runs that are live at once never judge the same item and a scheduled queue does not judge the same items every run. Each listed item carries when triage blocked it and the reason and blocker URLs that verdict declared; an item blocked before verdicts stored those carries the time and intake's summary. One agent reads each issue, what it waits on and the default branch, and names an item only when something it waits on changed state after that time, citing the change. A guess that an item is probably unblocked names nothing, because each re-triage is a full agent run. Each of those gets the run's own re-triage request and one `archon-intake` pickup. No label is written and no maintainer is credited. Intake stays the judge: its verdict decides whether the item now waits for the build queue. An item whose pull request create is unresolved is still revisited.

### How a round runs

- **Route.** The route agent is the one judge before a round spends. Intake triaged the item, and the round does not triage it again. The agent checks that a run can start from the issue body, read with its dated "Current scope" sections, and that triage's verdict still holds on the current checkout, asking for a re-triage when it does not. It proves a bug's symptom before the item's first round, declares the round's route, and writes the brief the round starts from. A bug that needs a browser is reproduced with the browser tool the UI check policy names (`playwright-cli`, or `agent-browser`, which Archon's Docker image ships). The route is triage's on the item's first round. A later round that continues its pull request is `continue`, and goes back to `plan` only when a review asked for a different design or the scope changed.
- **The pull request.** The queue reports the open pull request in the item's repository as the candidate, and the route agent declares whether the round continues it, unless a dated scope section or a recorded answer supersedes it. Delivery finishes a continued pull request whichever route the round takes, pushing onto its head so the same pull request updates. A superseded one is never checked out or pushed to: the round starts fresh, refusing a checkout that is not on the default branch, and its brief asks for the old pull request to be closed as superseded once the replacement opens. A closed or merged pull request, or one from a fork, is asked about; a round launched anyway never continues it. A round that continues none opens its pull request from `build/<issue>-<slug>-<run>`, a name never reused.
- **One round.** A round is `archon-ship` after its triage: investigate or plan when the route needs it, then the delivery tail.
- **The first review of a continued pull request.** A round that continues a pull request an earlier round already reviewed does not review it from the start. Its first review gets the report that round published. It checks that report's findings and reviews what changed since the commit it reviewed. Each published review is kept in its run's artifacts under `review/published/`: the report, its findings and the commit it reviewed. The queue finds that set in the artifacts of the item's earlier rounds: it must name the commit the pull request's review comment names and hold the report that comment shows. The first review reads the whole change when the pull request has no review comment from a maintainer account, when no earlier round on this machine kept that review (another install published it, a review run by hand replaced it, or the artifacts are gone), or when the pull request's history was rewritten after the review. To get a full review of a pull request the queue would continue, run `archon-review` on it yourself without `prior_report`: its report replaces the comment, so the queue's next round reviews the whole change too.
- **The decision.** An agent reads how the round ended and decides:
  - `done` when the pull request's latest review says Ready at its head commit and no check that no round can run is still outstanding. A dated scope section records such a check as met; otherwise the queue asks for it once.
  - `continue`, with a brief, when the contract already answers what stopped the round: a correctable finding, CI red the change caused, a false blocker naming a later step.
  - `ask`.

  Before any `continue`, the agent compares the whole change with the contract's shape, and asks when a correction would add machinery the contract does not name. It never continues a pull request that changed nothing material since its last review, no commits or only cosmetic edits; that round ends as done or ask by the same rules.
- **The next round.** A `continue` leaves the item waiting for its next round. The run ends with the decision as its outcome (`continue`, `ready`, `parked` or `asked`), the `build-pick-after-build` binding starts a pick, and the pick starts the round. Without that binding the item waits for the scheduled pick.
- **Round cap.** When a round ends wanting another and `round_limit` rounds (default 3) have run since the item's scope last changed, by a re-triage or a maintainer's answer, the agent also compares their reviews. Each round finding new defects asks the scope question instead of running another round.
- **Writes.** The queue pushes the commits the round left unpushed (never forcing, and reading the remote head back), then records the decision on the work item in one conditional write.
- **An already reviewed pull request.** When the route agent finds the pull request already reviewed Ready at its current head, the queue takes it out of draft without another round, checking the head before and after. A head that changed in between fails the run and puts the pull request back to draft. If that correction fails too, the failure reports the observed head, state and draft status: inspect the pull request, restore draft if it is still open and ready, and review its current head before marking it ready. The merge queue still owns the exact-head review and merge checks.
- **Dead rounds.** A run that ended before it recorded its round, by failing or being cancelled, leaves the item waiting, and the next round does not know a pull request that run opened. Resume a failed run with `archon workflow resume <run-id>` so it records its own round. After a run you abandoned, re-triage the item: triage looks for the pull request and routes the item to continue it.
- **An unresolved pull request create.** When a round's pull request create was submitted but no pull request could be verified, the delivery reports `pr_create_unresolved`. The build queue then refuses to select another pull request or branch for the item until a newer triage settles it: it names the reconciled pull request, or names none and the next round opens one.
- **Closed issues.** An item whose issue was closed is parked without an agent.

### What it asks

An unclear decision ends the run `asked`, with one ask left on the issue's item, so a question that waits overnight holds no run. The deciding agent writes the ask, and it reaches you as written: a question that names the issue and the decision; its context, with the evidence, what happens if nobody answers and the links; the options, what each does and costs; and a recommendation with its reason. An ask the engine cannot open, because two options share an id or the recommendation names no option, fails the run at its end, after the item is recorded as asking: re-triage the item.

Answer it with `archon workflow answer --ref ask:<id>`. The answer is one declared choice, or `other`, which every ask offers: its text says what to do instead and becomes the ruling, and the item continues from it. Every answer starts the issue's next build run through the `build-after-answer` binding. That run reads the chosen option's effect by its id, never from the answer's prose, writes the choice's ruling and your words into the issue body as one dated "Current scope" section, reads it back, and records the answer, all before any agent reads the issue.

- A `continue` choice runs the next round in that same run.
- A `ready` choice hands the pull request to the merge queue as it stands, as after a maintainer finished it by hand. The merge gate still checks it. An item with no pull request refuses the answer.
- A `park` choice stops working the item until a re-triage.

A withdrawn ask starts nothing and leaves the item asking; only a re-triage starts it over. Without the `build-after-answer` binding an answer starts nothing either.

### What it records

The work item's `facts.build` holds the item's status, which says who owns it: the build queue, the merge queue, or no queue when it is parked. It also holds the brief the next round starts from, the item's last ten rounds, each with the route it took, and its last twenty decisions with any maintainer's answer.

### Its bindings

Five bindings run the queue. `build-queue` starts one build run for one issue and has no schedule: picks fire it. Each run changes its checkout, so it launches in a worktree, with `overlap: skip` and a capacity of 10. That number is how many issues are built at once, and it is a starting point: set `concurrency.resources.<resource>` in the install's config to what the machine and the provider's rate limits carry. `build-after-intake` starts the same workflow under the same resource when an intake run routes its issue, and `build-after-answer` when its question is answered, queued rather than skipped, since the answer is the only start the item gets. `build-pick` starts a pick every 30 minutes, and `build-pick-after-build` starts one when a build run ends. A pick that starts intake, for new work its message files, a work order's untriaged members or a blocked item it sends back, fires the fire-only `intake` binding, under intake's resource. The pack README's [Let it run on its own](https://github.com/coleam00/Archon/blob/dev/.archon/workflows/sdlc/README.md#10-let-it-run-on-its-own) says what to look at.

The pick's `build_queue_binding` input names the `build-queue` file, and the pick refuses to run without it. Its `intake_binding` input names the `intake` file; a pick node that would start intake refuses while it is empty. Pick files written before `intake` existed lack it: write `intake`, `build-pick` and `build-pick-after-build` again with `--only` and `--force`. A binding set written before the pick has a scheduled `build-queue` and no pick: write the four again with `archon pack bindings sdlc --only build-queue,build-after-intake,build-pick,build-pick-after-build --force`, remove the old `build-queue` schedule, schedule `build-pick`, and register the run-ended files with `archon trigger add`. A scheduled start of `archon-build-queue` names no issue and is refused.

A build round starts as soon as intake routes an issue only when the intake run is on the issue's item and `build-after-intake` is registered. Intake bindings written before the item mapping start runs on no item, which hand nothing on: write `intake-issues` and `intake-labels` again with `--only` and `--force`, replace their entries in the source plugin's configuration, and register `build-after-intake` with `archon trigger add`.

### Work orders

A work order is the set of work items you approved for the factory, so the pick's schedule can stay on while you choose what builds. Set `"orders_only": "true"` in the `launch.inputs` of both pick bindings, and a pick starts an item the queue never built only when it is a member of an open order, in the usual pickup order. An item the queue already has a build record for is started either way, so the next round of an issue that intake's handoff, a message or a merge-queue return started does not wait for an order. An issue a message names is started either way. Intake's handoff names its issue too, so an install that builds only work orders leaves `build-after-intake` unregistered. The default, `"false"`, picks from every waiting item.

An order is one state document, `work-order/<id>`, in the project's state scope, whose key is the repository's `owner/repo`. The easiest way to write one is to name its members in a pick's message:

```bash
archon workflow run archon-build-pick "build #123, #130 and the Pi login fixes" --detach
```

The agent resolves the message to issues and declares the order's `id`, its members and the parts of the message it could not resolve, with why. An order written this way has at least two members. The run writes the document as `open`, approved by the run's Archon user (its id, which `archon user list` names) at the time of the write; a run with no recorded user refuses. The write is conditional on the document not existing, so an `id` already taken refuses the run and leaves that order as it was. A member intake has never seen gets an `archon-intake` run started detached. The run starts none of the members, and the `order` node's summary lists the order, the members sent to intake and the unresolved parts. Later picks, with `orders_only` on, start them.

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

While `orders_only` is on, each pick with no message first marks done every open order whose members are all finished, setting `status` to `done` and `done_at`. A member is finished when its work item's latest decision is a merge, with no build or re-triage recorded after it. A member closed without a merge, or with no work item, keeps its order open until you remove it from `members`. To drop an item, or add one, replace the document at its current revision.

A malformed order, including an `open` one with a `done_at` or a `done` one without, refuses a pick with no message, with the order's name, so the queue never builds something no order chose.

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

`archon-merge-queue` is the merge stage: one run decides one issue's pull request, the one the build queue finished, and stops only for a decision that belongs to a person. It merges on its own when a case is clear and asks when it is not. The default policy for which is which is [`merge.md`](https://github.com/coleam00/Archon/blob/dev/.archon/workflows/sdlc/.shared/policy/merge.md), which a project extends with its own `.archon/sdlc/policy/merge.md`.

A merge run is on the issue's item, `issue-<number>`, like a build run, and the engine admits one merge run per item. It never pauses and never polls: it ends merged, returned, parked, asked or waiting, and the [bindings](#the-stages-bindings) start whatever follows.

### What a run takes

An item is the merge stage's when its build record is ready, no re-triage came after that build round began, and the stage has not settled it: it never decided it, or left it waiting or asking. When the build queue readies an item again after the stage returned or parked it, it is the stage's again. A run started by hand on a parked item is accepted too. A run on any other item refuses before it reads the forge, which is what keeps a merge run off an item the build queue would accept for another round. The pull request is the latest one a build round recorded, or, when no round recorded one, the one triage routed the item to continue. One already merged or closed is recorded without the agent.

The run refuses before it starts when the forge plugin lacks an operation the stage needs.

### What it reads

The run reads the pull request's head, how many commits of the default branch it lacks, whether it merges cleanly, CI and unresolved review threads at the head, and the review verdict. Every read that names a commit must name the head. Under [`ci: none`](#pack-settings) it also reads the latest validation the item's build rounds recorded: the commit and whether it passed.

Only a review comment a listed maintainer wrote counts (`.archon/sdlc/policy/maintainers.json` on the default branch); verdicts from other authors are ignored. So the login that authors the pack's published reviews must be on the list, and anyone on it can publish a verdict that passes the gate. A pull request with two trusted review comments has no verdict.

A failed read fails the run, and the item stays as it was. The [backstop](#the-stages-bindings) does not start an item whose newest merge run failed: the run stays in `archon workflow runs --open`, and you resume it with `archon workflow resume <run-id>` or end it with `archon workflow abandon <run-id>`, after which the backstop starts the item again.

### How a run decides

One agent decides the pull request. The stage never pushes, never changes its checkout and never waits for CI.

- **Merge.** A Ready pull request with green CI that the forge reports merges cleanly into the default branch merges, even when it is behind.
- **Return.** What the build queue can fix goes back to it with a brief: a verdict that is not Ready or is for another commit (a push after the review), a conflict with the default branch, an unresolved thread that raises a defect in the change, and red the change caused. On a conflict the round merges the default branch in and resolves it, regenerating generated files with their owning script.
- **Rerun.** Red CI in code a pull request does not touch gets one rerun of its failed jobs, counted only when the forge reports it applied. The record stores the head it re-ran at, so the stage never reruns twice at one head, and the run ends waiting for a check there. Red again after it counts as the change's, and the pull request goes back.
- **Ask.** An unclear pull request is asked about as soon as its verdict is Ready at its head, even while its CI is pending or it conflicts. The approval is pinned to that head and the run the answer starts merges it once the gate passes. An approval carries to a later head only when the agent judges that everything since the approved head is merges of the default branch and their conflict resolutions, and the verdict is Ready at the later head. Any doubt voids it.
- **Wait.** A pull request whose checks still run, or that a red default branch holds back, waits. The run ends and holds nothing; see [what it waits for](#what-it-waits-for).

The agent measures the diff with git against the merge base, not the forge's counts.

### The gate

The agent declares whether the pull request merges. A script node then reads the pull request and the default branch fresh and merges it through one gate, which refuses unless:

- the verdict says Ready for the head;
- what the [`ci` setting](#pack-settings) trusts passes at the head: green CI, or a passing validation recorded at that head;
- the default branch's CI is not red (pending does not hold a merge);
- the pull request is open, not a draft, into the default branch, at the head the agent named;
- that head contains the default branch's head, or the forge reports it merges cleanly;
- under `merge_lane: manual`, or when the pull request changes a path `protected_paths` matches, the work item holds a maintainer's approval at exactly that head.

Open review threads are the agent's judgment, not the gate's: it holds a merge only for a thread that raises a defect in code the pull request changes or makes reachable. The gate merges pinned to that head, by squash unless `--input merge_method=merge` asks for a merge commit. A merge moves the default branch, so the forge may not have computed the next pull request's merge yet: the script reads it again a few times before it refuses. A pull request the gate refuses, or whose merge the forge cannot verify, as when it queues merges, is recorded as waiting with the gate's reasons, and a later run decides it again.

The forge, not the agent, says what merged: a pull request that reads back merged after the agent ran is recorded merged at the head the forge merged, whatever was declared, and a closed one is parked.

Before merging, the agent rechecks the pull request's closing keyword against the review's stamped contract coverage and the issue's latest ruling, and corrects it in either direction.

### What it waits for

A run that cannot merge yet ends with outcome `waiting`. It holds no slot, no session and no claim while the item waits. When its checks are pending at its head under `ci: forge`, or the agent just re-ran them, the run leaves a `checks` [wait](/reference/workflow-language/#waits-what-an-item-waits-for-outside-archon) on the item about that head commit, and a completed check at exactly that commit starts the stage again.

A check at any other commit, such as an older head, meets no wait and starts nothing. Each completed check is its own event, so a run woken while other checks still run waits again without the agent. A red check wakes the agent. Each wait is expected within 60 minutes; past that the item is listed in `archon workflow attention` as an overdue wait, and the next backstop pass starts it.

A red default branch asks nobody. Nothing merges, the run's summary and a notice labelled `kind=base-red` carry the agent's diagnosis: the failing checks and what each points at, the pull requests merged since the branch was green, the one it suspects, and whether to rerun, revert or fix forward. It recommends a rerun by hand when no recent merge touched the red code: the forge's rerun acts only on a pull request, so the pack never reruns the default branch. A red default branch leaves no wait: every pull request it holds back would wait on the same commit, and the engine starts nothing for an event that meets waits on more than one item. The items wait for the backstop, which reads them after a rerun or a fix alike.

Everything else a pull request can wait for has no forge event the pack binds. The backstop covers it: every 30 minutes `archon-merge-pick` starts a merge run on each item the stage has, except one whose ask is open, one waiting on a check that is not yet overdue, one with a merge run already queued or running, and one whose newest merge run failed. That is how these get read:

- a review thread resolved;
- a draft marked ready;
- the forge finishing its computation of whether the pull request merges;
- a new review verdict, which is a comment and not a forge review;
- a validation recorded under `ci: none`;
- a red default branch, fixed by a new commit or a rerun;
- a hand-off or a check event that was lost.

The backstop reads no pull request and runs no agent. Each run it starts does.

### What it records

The work item's `facts.merge` holds the item's merge status, any approval pinned to the head it approved, and the last twenty decisions with any maintainer's answer. A return also sets the build record to waiting for its next round, with the brief. `archon workflow runs --item issue-<number>` shows the item's merge runs with their outcomes, its open waits and its asks.

### After a run

What follows a merge run is a binding on its outcome, not a step of the run:

- **`returned`** starts the issue's next build round through `build-after-merge-return`. A start that finds every build slot busy is skipped, and the next pick starts the issue.
- **`merged`** starts a discoveries drain through `discoveries-after-merge`, when the records about the merged code can first be decided. The drain is recorded as a run on the merged issue's item. A start that finds a drain running is skipped, and the next merge or scheduled pass starts one.
- **`merged_retriage`** is a merge that left its issue open, in a run with `retriage_merged` set to `true`. A pull request that links its issue with `Refs #N` merges without closing it, and the issue keeps its intake stage. The run recorded its own re-triage request on the work item, and `intake-after-merge` starts the intake run that takes it. Intake closes the issue as delivered or keeps it with what is still open. Set `retriage_merged` in the `launch.inputs` of each merge-stage binding file; without it nothing is re-triaged and no run ends with this outcome.

### What it asks

An unclear pull request ends its run with outcome `asked` and one [ask](/reference/workflow-language/#asks-decisions-a-run-leaves-on-its-item) on the issue's item. `archon workflow attention` lists it with no run behind it; answer it with `archon workflow answer --ref ask:<id> --choose <option> --text "<why>"`. The agent writes the question, what is at stake and its recommendation. The ask always has exactly three options, the same on every ask, and the answer starts the stage again through `merge-after-answer`:

- **`merge`** approves the pull request at the head that was asked about. The stage runs again and merges it if the gate still holds there, or ends waiting for its checks.
- **`return`** sends the pull request back. The run ends `returned`, which starts the issue's next build round, with your answer's words as what to change: they are written into the issue body as a dated "Current scope" section, and the round reads them as the contract.
- **`park`** stops work on the item. Nothing starts by itself, and the pull request stays open, until the build queue readies the item again or you start the merge stage on it by hand: `archon trigger fire --config <merge-queue file> --item issue-<number>`. That run judges the pull request like any other.

To ask for something else, choose the nearest option and say it in the text. Text alone, naming no option, starts nothing: the stage never reads an answer's words to guess what was meant, and the command says that nothing was started. A withdrawn ask starts nothing either. In both cases the item stays as asked until the build queue readies it again.

### The stage's bindings

Every start of the merge stage shares the resource `merge` with a capacity of 1 and `overlap: queue`. A run judges the default branch and merges against it, so a second run beside it would merge against a base it has not judged; pull requests therefore merge one at a time, in the order their starts arrived. A run never changes its checkout, so every binding runs in the launch checkout.

| Binding | Starts a merge run when |
| --- | --- |
| `merge-after-build` | a build round ends `ready` |
| `merge-after-checks` | a check completes at the head a `checks` wait names |
| `merge-after-answer` | the stage's ask is answered with `merge`, `return` or `park` |
| `merge-queue` | fired for one item: by the backstop, or by hand with `archon trigger fire --config <file> --item issue-<number>` |

`merge-pick` schedules the backstop every 30 minutes, with `overlap: skip`. `build-after-merge-return`, `discoveries-after-merge` and `intake-after-merge` are the bindings on the stage's outcome described above.

The check binding is an event binding for the GitHub source plugin, so it needs a server with a webhook subscribed to check runs and commit statuses, as intake's bindings do. Without it the stage still merges: a waiting item's wait goes overdue after an hour and the next backstop pass starts it.

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

The `discoveries` binding starts a pass on a schedule, with `overlap: skip`: a start is skipped while a pass still runs, and a pass paused on a question gives its slot back. The `discoveries-after-merge` binding also starts a pass after each merge, when the records about the merged code can first be decided. A pass started that way that finds one already running is skipped like a scheduled one, and the next merge or scheduled tick starts it.

## Worktree cleanup

The pack has no cleanup workflow. Merged worktrees are removed by the engine's merged sweep, [`archon isolation cleanup --merged`](/reference/cli/#isolation-cleanup-days), across every project registered on the install. A server runs it on its cleanup schedule. An install that runs only the CLI schedules the same sweep with [`archon isolation cleanup schedule install`](/reference/cli/#isolation-cleanup-schedule).

The sweep removes each merged worktree with its local branch, including a branch the worktree adopted instead of creating. A worktree with uncommitted changes, one a run can still claim, or one with a commit the merge does not cover stays. Remote branches are retained with a warning; on GitHub, enable **Automatically delete head branches** in repository settings, or follow the [remote branch recovery procedure](/reference/cli/#recovering-remote-branch-cleanup).

Who removes each checkout:

- Intake, triage, the split queue, discoveries, the merge queue and the forge check create no worktree. They run in the launch checkout as it stands.
- A run that creates a worktree on its own run-named branch, such as a build round, removes it when the run completes, if the checkout is clean and every commit is on a remote; its pushed branch counts. A branch with commits of its own stays; one still at the commit it was cut from is deleted with the worktree. Otherwise the run reports what removing it would lose, and the checkout stays listed by `archon isolation list`.
- A worktree launched with `--branch` waits for the merged sweep.

## Notices

Each queue says what it did on the attention stream, at the notices level. A notice asks nothing of anyone. Every notice carries `stage` and `kind`, and `item` or `pr` where it has one.

| `kind` | Said when | Labels |
| --- | --- | --- |
| `started` | a build round is about to start | `stage=build`, `item` |
| `ready` | the build queue hands a pull request to the merge queue | `stage=build`, `item`, `pr` |
| `continued` | the build queue starts another round on the item | `stage=build`, `item` |
| `parked` | a queue stops working an item | `stage`, `item` |
| `merged` | the merge queue merged a pull request | `stage=merge`, `item`, `pr`, `lane` (`manual` when a maintainer approved it at the merged head, else `auto`) |
| `returned` | the merge queue sent a pull request back to the build queue | `stage=merge`, `item`, `pr` |
| `base-red` | a merge run found the default branch red, with the agent's diagnosis | `stage=merge`, `item`, `pr` |
| `closed` | intake closed an issue triage found resolved | `stage=intake`, `item` |
| `blocked` | intake left an issue where no run can start | `stage=intake`, `item` |

```bash
archon workflow attention --notices --since 24h --label kind=merged     # what merged
archon workflow attention --notices --since 24h --label kind=started    # what started building
archon workflow attention --notices --since 30d --label kind=merged --count-by label:lane   # share merged without a person
archon workflow attention --watch --notices                             # as it happens
```

A notice the host refuses is reported on the node's stderr and never fails the run.

## Measure the factory

[SDLC factory metrics](/guides/sdlc-metrics/) lists the metrics the pack records about its pull requests, issues, review rounds and tests, and how to read them.
