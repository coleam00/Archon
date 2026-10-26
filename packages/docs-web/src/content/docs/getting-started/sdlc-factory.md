---
title: Set up the SDLC factory
description: Take a GitHub repository from nothing to an issue built by the build queue and merged by the merge queue, and know everything the pack writes.
category: getting-started
audience: [user]
sidebar:
  order: 4
---

The bundled `sdlc` pack is a software factory made of four queues. You write an issue; intake triages it, the build queue works it to a reviewed pull request, and the merge queue merges it. When a run reaches a decision it can't make, it pauses as one attention item for you to answer. This page sets that up on one GitHub repository, runs it by hand once, and then shows how to let it run on its own.

| Queue | What it does |
|---|---|
| `archon-intake` | Checks the issue's author against your maintainer list, triages a maintainer's issue and labels its route |
| `archon-build-queue` | Takes one triaged issue through `archon-ship` rounds until its pull request is reviewed Ready |
| `archon-merge-queue` | Merges the Ready, green pull requests the build queue finished, and sends back what it can't merge |
| `archon-discoveries` | Files, tracks or drops what runs noticed outside their own task |

Every workflow in the pack is described in [SDLC pack workflows](/reference/sdlc-workflows/).

## Before you start

You need:

- Archon with at least one provider, from the [Quickstart](/getting-started/quick-start/).
- A local clone of a GitHub repository you can push to.
- The GitHub CLI signed in as the account the pack will act as: `gh auth login`. Every label, comment, push and merge is made as that account.
- CI that reports checks on pull requests. The merge queue merges only when the checks at the pull request's head are green, so a repository with no checks never merges.

## 1. Check the forge

```bash
archon workflow run archon-forge-check     # from the clone
```

It proves that `gh` is signed in and can read the repository the clone's remotes name. It proves read access only; the first write proves the rest. The pack talks to GitHub through `gh` by default. Setting `ARCHON_SDLC_FORGE=forge` routes it through `archon forge` and an installed [forge plugin](/reference/forge/) instead, and `archon-forge-check` then also checks that the plugin offers every operation the delivery workflows use. It does not check the merge queue's operations: the merge queue checks those itself when it starts and refuses a plugin without them before it claims any work. Stay on `gh` for the factory until the installed plugin offers them too.

## 2. Name your maintainers

Create `.archon/sdlc/policy/maintainers.json` and commit it to the default branch. The queues read it from the default branch's head on the remote, so a local copy does nothing.

```json
["your-login", { "login": "teammate", "merge_queue": "own-prs" }]
```

Each entry is a GitHub login, or an object naming one. With no file, every author is outside. The list decides three things:

- **Whose issues get triaged.** An issue from anyone else gets `archon-needs-maintainer` and starts no agent until a listed maintainer adds `archon-triage` or a route label to it.
- **Whose review verdicts count.** The merge queue trusts only a review comment written by a listed login. **The login that authors the pack's published review comment must be on the list on the default branch**, or that verdict is ignored. With the default `gh` source, this is the identity `gh` acts as; with the opt-in `forge` source, it is the forge plugin's credential identity, which may differ. Check the published comment's author when choosing which login to list.
- **Whose own pull requests enroll.** `"merge_queue": "own-prs"` enrolls that maintainer's own open, non-draft pull requests in the merge queue. A pull request a work item already names, such as one the build queue delivered, is not enrolled again.

## 3. Adjust policy and models (optional)

The queues decide clear cases on their own and ask about unclear ones. The pack's default policy for each decision lives in [`.shared/policy/`](https://github.com/coleam00/Archon/tree/dev/.archon/workflows/sdlc/.shared/policy):

| File | Decides |
|---|---|
| `triage.md` | What triage accepts, and what may close without a person |
| `build.md` | What the build queue continues on its own and what it asks |
| `merge.md` | Which pull requests merge on their own: by default small fixes, small features, tests and docs. Schemas, auth, large or partial work are asked |
| `rulings.md` | Answers your maintainers already gave, read before plan or review stops to ask |
| `discoveries.md` | When a discovery is filed, tracked or dropped |

To change one, put only the lines to add or override in `.archon/sdlc/policy/<file>`. The agent reads the default first, then your file, and your line wins where they conflict. A policy file can be a pointer to documents the project already has.

Each stage picks its model from a concern alias, falling back to the tier it has always used. With nothing set, you get the tier models.

| Alias | Nodes | Falls back to |
|---|---|---|
| `@triage` | triage | `medium` |
| `@planner` | plan | `large` |
| `@investigator` | investigate | `medium` |
| `@implementer` | implement | `large` |
| `@reviewer` | every review agent and simplify | each node's tier |
| `@review-<lens>` | one lens: `seams`, `code`, `tests`, `errors`, `docs` or `simplify` | `@reviewer`, then the lens's tier |

```bash
archon ai alias set @reviewer codex gpt-5.5                                   # every run
archon workflow run archon-build-queue --model @reviewer=codex/gpt-5.5 ...    # one run
```

## 4. Write an issue the factory can build

The issue body is the contract every round is measured against. State the problem, why it is worth solving, why now, the desired outcome, the invariants, and acceptance; see [The input is the contract](/getting-started/quick-start/#the-input-is-the-contract). The build queue asks you for a missing element instead of guessing it.

## 5. Run the queues by hand

Run each queue once yourself before you automate anything. Replace `acme/widgets` with your repository and `42` with the issue number.

Triage the issue:

```bash
archon workflow run archon-intake \
  --input repo_host=github.com --input repo_path=acme/widgets --input number=42
```

Intake labels the issue with its route (`archon-ready`, `archon-plan` or `archon-investigate`), its type and its size, creating any pack label the repository lacks, and records a work item. Read the item with `archon state get work/42`.

Build it:

```bash
archon workflow run archon-build-queue \
  --input repo_host=github.com --input repo_path=acme/widgets --input number=42 --detach
```

A round runs `archon-ship`: investigate or plan if the route needs it, implement, open a draft pull request, review it, fix the findings, wait for CI and mark it ready. When a round ends on something the contract already answers, such as a review finding or red CI the change caused, the queue starts the next round at once as a new detached run. The item is done when the pull request's latest review says Ready at its head. Follow it with `archon workflow runs` and answer anything it asks (step 6).

Merge it:

```bash
archon workflow run archon-merge-queue --input repo_host=github.com --input repo_path=acme/widgets
```

One sweep agent decides every pull request the build queue made ready. It never pushes, never builds or tests, and never waits for CI. Each merge goes through a gate script that reads the pull request fresh and refuses unless:

- the trusted review verdict says Ready for the current head (a push after the review voids it);
- CI is green at that head;
- the default branch's CI is not red (pending does not hold a merge);
- the head contains the default branch, or GitHub reports it merges cleanly.

The gate merges pinned to that head (`gh pr merge --match-head-commit`, squash by default; `--input merge_method=merge` for a merge commit). A conflict, a stale verdict, a review thread that raises a defect, or red the change caused goes back to the build queue with a brief. Red CI in code the pull request doesn't touch gets one rerun of its failed jobs. If the default branch is red, nothing merges, and the queue raises one `merge: base` item whose only choice is `hold`. A pull request it fails to read twice in a row is parked until the build queue readies it again.

Drain what the runs noticed outside their task:

```bash
archon workflow run archon-discoveries --input repo_host=github.com --input repo_path=acme/widgets
```

## 6. Answer what the factory asks

```bash
archon workflow attention --all --watch
```

Each item says what is being decided, why it matters, the agent's recommendation with its evidence and confidence, the choices and what each does, and what happens if nobody answers. Its label names the queue and decision, such as `build: scope` or `merge: pr`. Answer with the choice and a reason:

```bash
archon workflow respond <run-id> <choice> "why"
```

The reason matters. A build or merge queue answer is written into the issue body as a dated "Current scope" section, and later rounds work from it. Every build item and merge pull-request item offers `other`: its text says what to do instead and becomes the ruling. `park` stops the queue working that item. [Operate runs](/getting-started/operate/) covers answering, resuming and stopping runs in full.

## 7. Let it run on its own

The pack installs no trigger. Nothing starts until you start it, by hand as above or with a binding you add. A binding names the workflow, its inputs, the Archon user it runs as (`archon trigger whoami` prints the ID) and how starts may overlap.

- **Build, merge and discoveries** run on a schedule. Save the binding, fire it once, then install it:

  ```bash
  archon trigger fire --config ~/.archon/triggers/widgets-build-queue.json
  archon trigger schedule install --config ~/.archon/triggers/widgets-build-queue.json   # macOS
  ```

  On Linux or Windows, run the same `trigger fire` command from cron, systemd or Task Scheduler.
- **Intake** starts on GitHub issue and label events, through the GitHub source plugin on a running server. It needs a webhook, so it is the last piece most people add. Until then, run intake by hand for each new issue.

The pack's README has a binding for each queue: [Intake](https://github.com/coleam00/Archon/blob/dev/.archon/workflows/sdlc/README.md#intake), [Build queue](https://github.com/coleam00/Archon/blob/dev/.archon/workflows/sdlc/README.md#build-queue), [Merge queue](https://github.com/coleam00/Archon/blob/dev/.archon/workflows/sdlc/README.md#merge-queue) and [Discoveries](https://github.com/coleam00/Archon/blob/dev/.archon/workflows/sdlc/README.md#discoveries). [Workflow triggers](/guides/workflow-triggers/) covers schedules, webhooks, capacity and overlap.

## What the pack writes

Everything below is written as the `gh` account, to the repository the queues name.

| Where | What | Who |
|---|---|---|
| Labels | Creates the pack's own `archon-*` labels when missing. Adds and removes them on issues as a delta, so labels others add survive | Intake; `archon-triage` with `--input publish=true` |
| Issues | Closes a duplicate of an open issue, or an issue a merged change already delivered, with one comment linking the cause, and a link-back comment on the original (on `gh`, a write that landed but returned a retryable response (5xx, or a rate limit) or no response can leave a second one; the next upsert then refuses: inspect both and delete one). Intake closes issues by triage verdict, as `triage.md` allows, and a merged pull request closes the issue it names with `Closes #N` | Intake; merges |
| Issue bodies | Appends a dated "Current scope" section with your answer | Build queue, merge queue |
| New issues | Files an issue for a verified discovery, marked so a rerun never files it twice. Adds one evidence comment (on `gh`, a write that landed but returned a retryable response (5xx, or a rate limit) or no response can leave a second one; the next upsert then refuses: inspect both and delete one) to an open issue it tracks | Discoveries |
| Branches | Pushes `build/<issue>-<slug>-<run>`, or pushes onto an open pull request's existing head. Never force-pushes or rebases | Build queue rounds |
| Pull requests | Opens a draft, updates its description, posts one review comment and edits it in place (on `gh`, a write that landed but returned a retryable response (5xx, or a rate limit) or no response can leave a second one; the next upsert then refuses: inspect both and delete one), replies to and resolves review threads, marks it ready and back to draft. The description says `Closes #N` only when the review found every acceptance item met and no dated ruling on the issue keeps it open. Before merging, the merge queue rechecks the keyword against the review's stamped coverage and the issue's latest ruling, and corrects it in either direction | Build queue rounds; merge queue |
| CI | Reruns the failed jobs of a run once, when red is outside the change or on the default branch | Build queue rounds, merge queue |
| Merges | Merges through the gate, pinned to the reviewed head. Deletes no branch | Merge queue |
| Worktrees and branches | If you schedule it, removes each merged worktree with its local branch, including a branch Archon adopted. Remote branches stay, with a warning | `archon-worktree-cleanup` |

On your machine it keeps state documents (`archon state list --prefix work/`), worktrees and run artifacts under `~/.archon/`.

## Pause or stop it

- **Stop new runs.** Remove the schedules (`archon trigger schedule remove --config <file>`, or the cron or systemd entry) and the intake webhook bindings. Removing a schedule does not cancel work already accepted.
- **Stop runs in flight.** A build round that continues starts its next round as a new detached run, and answering `merge` on a merge item starts a sweep at once, so removing schedules alone does not stop a chain. List the runs with `archon workflow status --all` and `archon workflow cancel` or `archon workflow abandon` them.
- **Stop one item.** Answer its attention item with `park`. A paused run waiting on you does nothing until you answer.
