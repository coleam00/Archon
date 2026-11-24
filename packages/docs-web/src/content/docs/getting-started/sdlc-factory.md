---
title: The SDLC factory
description: What the bundled sdlc pack's factory is, where its setup guide lives, everything it writes and how to stop it.
category: getting-started
audience: [user]
sidebar:
  order: 4
---

The bundled `sdlc` pack is a software factory made of stages. A maintainer labels an issue `archon-triage`; triage routes it, and the engine starts each next stage on the issue's item, `issue-<n>`, through to a merged pull request. When a stage reaches a decision it can't make, it ends and leaves the question on the item for you to answer, and your answer starts the next stage. This page says what the factory is, what it writes, and how to stop it. The setup steps are in the pack's README.

| Stage | What it does |
|---|---|
| `archon-triage` | Judges whether a run can start from the issue and routes it to investigate, plan, build or split; asks the author questions, or closes a duplicate or delivered issue |
| `archon-investigate` | Proves the root cause of a symptom and decides the fix |
| `archon-split` | Files the next piece of a large issue as its own issue and puts it in triage |
| `archon-plan` | Chooses the approach and breaks it into verifiable steps |
| `archon-build` | Builds the change and opens a draft pull request; continues it in one session when it comes back |
| `archon-review` | Reviews the change through specialist lenses and posts one verdict |
| `archon-host` | Answers review threads, updates the description, reads CI and takes the pull request out of draft |
| `archon-land` | Judges the pull request against your land policy and merges it, or asks |
| `archon-discoveries` | Files, tracks or drops what the runs noticed outside the change |

Every workflow in the pack is described in [SDLC pack workflows](/reference/sdlc-workflows/).

## Set it up

The pack's README owns the setup: [Set it up](https://github.com/coleam00/Archon/blob/dev/.archon/workflows/sdlc/README.md#set-it-up). It covers the forge plugin and credential, the one setting and the policy documents, a first run of each stage by hand, and the bindings that let the stages chain on their own.

Before the first run, write an issue the factory can build. The issue body is the contract every stage is measured against: state the problem, why it is worth solving, why now, the desired outcome, the invariants, and acceptance; see [The input is the contract](/getting-started/quick-start/#the-input-is-the-contract). Triage asks the author for what is missing instead of guessing it.

Once it runs, [Operate the SDLC factory](/guides/sdlc-operations/) says how to follow an item and answer what it asks, and [Operate runs](/getting-started/operate/) covers resuming and stopping runs.

## What the pack writes

Everything below is written as the forge account whose credential the pack uses, to the repository the bindings name.

| Where | What | Who |
|---|---|---|
| Labels | Adds area labels the repository already has. Adds `archon-triage` to a piece it filed from a split issue | Triage; split |
| Issue comments | One marked comment each for questions to the author, what a blocked issue waits on, a close, a split's plan, and evidence added to an issue a discovery belongs to | Triage; split; discoveries |
| Issues | Closes a duplicate of an open issue, or an issue a merged change already delivered. Closes a bundle once its tasks are filed. A merged pull request closes the issue it names with `Closes #N` | Triage; split; merges |
| New issues | Files a split's next piece, and up to three verified discoveries a pass, each marked so a rerun never files it twice | Split; discoveries |
| Branches | Pushes the change's branch, or onto an open pull request's head it continues. Never force-pushes or rebases | Build |
| Pull requests | Opens a draft, posts one review comment and edits it in place, answers and resolves review threads, updates the description, marks it ready and back to draft. The description says `Closes #N` only when the review found every acceptance item met and no dated ruling on the issue keeps it open | Build; review; host; land |
| CI | Reruns a pull request's failed jobs once, when the red is outside the change | Land |
| Merges | Merges pinned to the head whose checks it read, and records the merge on the item. Deletes no branch | Land |

With the item tracker turned on (`itemTracker` in `~/.archon/config.yaml`), the engine also keeps one status comment on the issue and posts each question and the result. On your machine Archon keeps the item's runs, worktrees and run artifacts under `~/.archon/`.

## Pause or stop it

- **Stop new work.** Remove the label binding from the GitHub source plugin's config, so a label starts nothing. `archon hold set` holds every new start on the install until `archon hold lift`.
- **Stop the chain.** Delete the pack's trigger files from `~/.archon/triggers/`: each one is a hand-off from one stage to the next, and a stage that ends with no file to start starts nothing.
- **Stop runs in flight.** List them with `archon workflow status --all`, then `archon workflow cancel` or `archon workflow abandon` them.
- **Stop one item.** Answer its question with `stop` where it offers it, or withdraw it: nothing more runs on the item until someone starts a stage again.
