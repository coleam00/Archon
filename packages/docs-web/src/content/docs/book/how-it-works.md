---
title: How Archon Actually Works
description: Trace what happens under the hood when Archon runs a multi-step workflow.
category: book
part: orientation
audience: [user]
sidebar:
  order: 3
---

Let's trace exactly what happened when you ran `archon-fix-github-issue`. What looked like one command was actually multiple AI nodes running in a DAG, a shared workspace, and a chain of files passing context from phase to phase.

---

## The Workflow Definition

Here's the YAML you ran — it lives in Archon's bundled defaults:

```yaml
name: archon-fix-github-issue

nodes:
  # PHASE 1: CLASSIFY
  - id: classify
    command: archon-investigate-issue
    # Classifies issue type (bug/feature/etc), produces classification artifact

  # PHASE 2: INVESTIGATE or PLAN
  - id: investigate
    command: archon-investigate-issue
    depends_on: [classify]
    context: fresh
    # For bugs: analyzes root cause, creates investigation.md artifact

  # PHASE 3: IMPLEMENT
  - id: implement
    command: archon-fix-issue
    depends_on: [investigate]
    context: fresh
    # Implements fix from investigation, commits (no PR)

  # PHASE 4: CREATE PR
  - id: create-pr
    command: archon-create-pr
    depends_on: [implement]
    context: fresh
    # Pushes branch, creates draft PR linked to issue

  # PHASE 5: REVIEW
  - id: code-review
    command: archon-code-review-agent
    depends_on: [create-pr]
    context: fresh

  # PHASE 6: SELF-FIX
  - id: self-fix
    command: archon-self-fix-all
    depends_on: [code-review]
    context: fresh
    # Reads all review artifacts, fixes findings, pushes fix report
```

That's the shape of it. Each entry under `nodes:` references a markdown file — a **command** — that tells the AI what to do at that step. Nodes declare `depends_on` to express ordering; independent nodes can run concurrently.

---

## What Each Step Did

| Phase | Command | What the AI Did | Artifact Produced |
|-------|---------|-----------------|-------------------|
| Investigate | `archon-investigate-issue` | Read the GitHub issue, explored relevant code files, documented root cause and a fix plan | `investigation.md` |
| Fix | `archon-fix-issue` | Read `investigation.md`, made code changes, ran tests, committed the changes | `implementation.md` |
| Create PR | `archon-create-pr` | Pushed the branch, created a pull request linked to the issue with a full description | PR on GitHub |
| Review scope | `archon-pr-review-scope` | Gathered PR metadata and changed files | `.pr-number`, `scope.md` |
| Code review | `archon-code-review-agent` | Read the diff with full codebase context, produced structured findings | `review-findings.md` |
| Post review | `archon-post-review-to-pr` | Read `review-findings.md`, posted it as a comment on the PR | GitHub PR comment |
| Auto-fix | `archon-auto-fix-review` | Read all review artifacts, fixed the surfaced issues, pushed to the PR branch, posted a fix report | GitHub PR comment |

Each step is independent and focused. The investigation step doesn't know about PR creation; it just writes a file. The fix step doesn't know about code review; it just reads from `investigation.md` and makes changes. The workflow stitches them together.

---

## The Key Insight

Commands are **atoms** — each is a single focused task, written in plain markdown, with no knowledge of what comes before or after.

Workflows are **molecules** — YAML files that arrange commands into a graph with a clear purpose.

**Artifacts** are the connectors. They're files written to a shared directory (`$ARTIFACTS_DIR`) that each node can read. When the AI finishes investigating, it writes `investigation.md`. When the implement node starts, it reads that file. When the review node runs, it reads `implementation.md`. This is how information travels across nodes with fresh context.

You could run each command manually. Workflows automate the graph.

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

When you ran `archon-fix-github-issue --branch fix/my-first-run`, Archon:

1. Created a **worktree** at `~/.archon/workspaces/owner/repo/worktrees/fix/my-first-run`
2. Created an **artifacts directory** for this run inside `~/.archon/workspaces/owner/repo/artifacts/`
3. Ran all the nodes inside the worktree, with `$ARTIFACTS_DIR` pointing to that artifacts directory

Your main repo was never touched.

---

## Context and Memory

Notice that most nodes have `context: fresh`. This is deliberate.

Each AI node runs inside a Claude Code session. That session accumulates context — files read, tool calls made, conversation history. After investigating a complex codebase issue, that context can be thousands of tokens long, with lots of detail that's irrelevant to the next phase.

`context: fresh` starts a fresh session for that node. The AI comes in without the baggage of previous nodes — just the task instructions and whatever artifacts it reads explicitly.

This is why artifacts matter so much. They're the answer to "how does node 5 know what node 1 found?" The answer is: it reads a file. Fresh context, explicit file handoff.

> **The pattern**: Write important findings to an artifact. Start the next node with `context: fresh`. Have that node read the artifact. This keeps each node focused and prevents context from accumulating noise across phases.

---

Now you understand the system. In [Chapter 4: The Essential Workflows →](/book/essential-workflows/), we'll walk through all of Archon's built-in workflows so you know exactly which one to reach for and when.
