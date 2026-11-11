---
title: The SDLC factory
description: What the bundled sdlc pack's factory is, where its setup guide lives, everything it writes and how to stop it.
category: getting-started
audience: [user]
sidebar:
  order: 4
---

The bundled `sdlc` pack is a software factory made of five queues. You write an issue; intake triages it, the split queue files the issues a large item splits into when it can't be built as one, the build queue works it to a reviewed pull request, and the merge queue merges it. When a run reaches a decision it can't make, it pauses as one attention item for you to answer. This page says what the factory is, what it writes, and how to stop it. The setup steps are in the pack's README.

| Queue | What it does |
|---|---|
| `archon-intake` | Checks the issue's author against your maintainer list, triages a maintainer's issue and labels its route |
| `archon-build-queue` | Takes one triaged issue through build rounds until its pull request is reviewed Ready, or a maintainer's `ready` answer hands it to the merge queue |
| `archon-merge-queue` | Merges the Ready, green pull requests the build queue finished, and sends back what it can't merge |
| `archon-discoveries` | Files, tracks or drops what runs noticed outside their own task |
| `archon-split` | Files the issues a large item splits into when triage judged it can't be built as one work item, and sends them back through intake. Its agent can also hand the item back to be built whole. They are opened by the install's login, so that login must be in `maintainers.json`, or intake treats them as outside items |

Every workflow in the pack is described in [SDLC pack workflows](/reference/sdlc-workflows/).

## Set it up

The pack's README owns the setup: [Set up the pack](https://github.com/coleam00/Archon/blob/dev/.archon/workflows/sdlc/README.md#set-up-the-pack). It is an ordered guide with the command for each step, the check that proves it and the decisions that are yours, written so you can point your coding agent at it. It covers the forge plugin and credential, the maintainer list, the pack's settings, a first run of each queue by hand, answering what the factory asks, and the trigger bindings that let it run on its own.

Before the first run, write an issue the factory can build. The issue body is the contract every round is measured against: state the problem, why it is worth solving, why now, the desired outcome, the invariants, and acceptance; see [The input is the contract](/getting-started/quick-start/#the-input-is-the-contract). The build queue asks you for a missing element instead of guessing it.

Once it runs, [Operate the SDLC factory](/guides/sdlc-operations/) says how each queue behaves, and [Operate runs](/getting-started/operate/) covers answering, resuming and stopping runs.

## What the pack writes

Everything below is written as the `gh` account, to the repository the queues name.

| Where | What | Who |
|---|---|---|
| Labels | Creates the pack's own `archon-*` labels when missing. Adds and removes them on issues as a delta, so labels others add survive | Intake; `archon-triage` with `--input publish=true` |
| Issues | Closes a duplicate of an open issue, or an issue a merged change already delivered, with one comment linking the cause, and a link-back comment on the original. Intake closes issues by triage verdict, as `triage.md` allows, and a merged pull request closes the issue it names with `Closes #N` | Intake; merges |
| Issue bodies | Appends a dated "Current scope" section with your answer | Build queue, merge queue |
| New issues | Files an issue for a verified discovery, marked so a rerun never files it twice. Adds one evidence comment to an open issue it tracks | Discoveries |
| Branches | Pushes `build/<issue>-<slug>-<run>`, or pushes onto an open pull request's existing head. Never force-pushes or rebases | Build queue rounds |
| Pull requests | Opens a draft, updates its description, posts one review comment and edits it in place, replies to and resolves review threads, marks it ready and back to draft. The description says `Closes #N` only when the review found every acceptance item met and no dated ruling on the issue keeps it open. Before merging, the merge queue rechecks the keyword against the review's stamped coverage and the issue's latest ruling, and corrects it in either direction | Build queue rounds; merge queue |
| CI | Reruns a pull request's failed jobs once, when the red is outside the change. A red default branch is never rerun: it is raised as a `kind: base` item | Merge queue |
| Merges | Merges through the gate, pinned to the reviewed head. Deletes no branch | Merge queue |
| Worktrees and branches | If you schedule it, removes each merged worktree with its local branch, including a branch Archon adopted. Remote branches stay, with a warning | `archon-worktree-cleanup` |

On your machine it keeps state documents (`archon state list --prefix work/`), worktrees and run artifacts under `~/.archon/`.

## Pause or stop it

- **Stop new runs.** Remove the schedules (`archon trigger schedule remove --config <file>`, or the cron or systemd entry) and the intake webhook bindings. Removing a schedule does not cancel work already accepted.
- **Stop runs in flight.** Runs start follow-ups by firing the binding files directly: a build round that continues fires the next round, a merge-queue return fires a build round, answering `merge` fires a sweep, and a sweep that merged fires a discoveries pass. A run that sends an issue back to intake launches that intake run itself. So removing schedules alone does not stop a chain. List the runs with `archon workflow status --all` and `archon workflow cancel` or `archon workflow abandon` them.
- **Stop one item.** Answer its attention item with `park`, where the item offers it. A paused run waiting on you does nothing until you answer.
