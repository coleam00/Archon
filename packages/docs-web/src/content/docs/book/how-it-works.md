---
title: How Archon Actually Works
description: Trace what happens under the hood when Archon runs a multi-step workflow.
category: book
part: orientation
audience: [user]
sidebar:
  order: 3
---

Let's trace exactly what happened when you ran `archon-ship`. What looked like one command was actually several workflows composed into one DAG, a shared workspace, and a chain of files passing context from stage to stage.

---

## The Workflow Definition

Here's the YAML you ran, abridged. It lives in Archon's bundled `sdlc` pack at `.archon/workflows/sdlc/ship/archon-ship.yaml`:

```yaml
name: archon-ship

nodes:
  # STAGE 1: TRIAGE. Check the issue against the current code and pick a route
  - id: triage
    include: archon-triage

  # STAGE 2: INVESTIGATE or PLAN, depending on the route triage chose
  - id: inv
    include: archon-investigate
    depends_on: [triage]
    when: "$triage.output.route == 'investigate'"

  - id: planned
    include: archon-plan
    depends_on: [triage]
    when: "$triage.output.route == 'plan'"

  # STAGE 3: DELIVER. Implement, open a draft PR, review, fix, validate, flip ready
  - id: deliver
    include: archon-deliver
    depends_on: [gate-direct, gate-rooted, gate-planned]
    trigger_rule: none_failed_min_one_success

  # STAGE 4: OUTCOME. Record whether a PR was delivered
  - id: outcome
    script: outcome
    depends_on: [triage, deliver]
```

That's the shape of it. Each `include:` node pulls in another bundled workflow, and each of those workflows is built from nodes that run a **command** (a markdown file that tells the AI what to do), a script, or a shell step. Nodes declare `depends_on` to express ordering, and `when:` skips a branch the route did not choose. The abridged file omits three small `gate-*` nodes that let `deliver` start only after a route actually succeeded.

---

## What Each Stage Did

| Stage | Workflow | What the AI Did | Artifact Produced |
|-------|----------|-----------------|-------------------|
| Triage | `archon-triage` | Read the issue, checked its claims against the current code, and chose a route | `triage.md` |
| Investigate | `archon-investigate` | For an unknown cause: reproduced the problem and proved the root cause | `investigation.md` |
| Plan | `archon-plan` | For an undecided shape: chose an approach and broke it into verifiable steps | `plan.md` |
| Implement | `archon-implement` (inside deliver) | Read the work order, made the changes, ran the project's checks, committed | `implementation.md` |
| Create PR | `archon-pr` (inside deliver) | Pushed the branch and opened a draft PR | Draft PR on GitHub |
| Review | `archon-review` (inside deliver) | Ran parallel review lenses; deliver then fixed the findings and re-reviewed each fix | PR comment |
| Validate | `archon-validate` (inside deliver) | Ran the project's checks; deliver then waited for CI and flipped the PR ready | `validation.md` |

Each stage is independent and focused. Triage doesn't know how the fix will be built; it writes a file. Deliver doesn't repeat triage's checks; it reads `triage.md` and whichever of `investigation.md` or `plan.md` the route produced. The workflow stitches them together.

---

## The Key Insight

Commands are **atoms** — each is a single focused task, written in plain markdown, with no knowledge of what comes before or after.

Workflows are **molecules** — YAML files that arrange commands into a graph with a clear purpose.

**Artifacts** are the connectors. They're files written to a shared directory (`$ARTIFACTS_DIR`) that each node can read. When triage finishes, it writes `triage.md`. When deliver starts, it reads that file. When implementation finishes, it writes `implementation.md` for the steps after it. This is how information travels across nodes with fresh context.

You could run each stage as its own workflow. `archon-ship` automates the graph.

---

## Where Things Live

Archon uses two directory trees:

```
~/.archon/                                  <- User-level data
├── workspaces/
│   └── owner/repo/
│       ├── source/                         <- Your cloned repo (or symlink)
│       ├── worktrees/                      <- Isolated workspaces per run
│       └── artifacts/                      <- Workflow outputs (never in git)
├── archon.db                               <- SQLite database (conversations, runs)
└── config.yaml                             <- Your global settings
```

```
your-repo/.archon/                          <- Repo-level config (checked into git)
├── commands/                               <- Your custom commands
├── workflows/                              <- Your custom workflows
└── config.yaml                             <- Repo-specific settings
```

When you ran `archon-ship --branch fix/my-first-run`, Archon:

1. Created a **worktree** at `~/.archon/workspaces/owner/repo/worktrees/fix/my-first-run`
2. Created an **artifacts directory** for this run inside `~/.archon/workspaces/owner/repo/artifacts/`
3. Ran all the nodes inside the worktree, with `$ARTIFACTS_DIR` pointing to that artifacts directory

Your main repo was never touched.

---

## Context and Memory

Notice that the stages hand each other files, not conversation history. This is deliberate.

Each AI node runs inside a Claude Code session. That session accumulates context — files read, tool calls made, conversation history. After investigating a complex codebase issue, that context can be thousands of tokens long, with lots of detail that's irrelevant to the next phase.

A node with `context: fresh` starts a fresh session. The review lenses inside `archon-review` all use it. The AI comes in without the baggage of previous nodes — just the task instructions and whatever artifacts it reads explicitly.

This is why artifacts matter so much. They're the answer to "how does node 5 know what node 1 found?" The answer is: it reads a file. Fresh context, explicit file handoff.

> **The pattern**: Write important findings to an artifact. Start the next node with `context: fresh`. Have that node read the artifact. This keeps each node focused and prevents context from accumulating noise across phases.

---

Now you understand the system. In [Chapter 4: The Essential Workflows →](/book/essential-workflows/), we'll walk through all of Archon's bundled workflows so you know exactly which one to reach for and when.
