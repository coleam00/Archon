---
title: Isolation and Worktrees
description: How Archon uses git worktrees to run multiple workflows in parallel without conflicts.
category: book
part: core-workflows
audience: [user]
sidebar:
  order: 5
---

You noticed in Chapter 4 that most workflows accept a `--branch` flag. That flag isn't just naming a branch — it's activating the **isolation** system, the feature that lets Archon run multiple tasks simultaneously without them stepping on each other.

---

## Why Isolation Matters

Imagine you're running `archon-fix-github-issue` on issue #42 and ask it to also start working on issue #43. Without isolation, both tasks share the same files in your repository. Task A edits `auth.ts`. Task B also edits `auth.ts`. You now have a conflict mid-run, and Archon can't make sense of which changes belong to which task.

With isolation, each task gets its own **worktree** — a completely separate directory with its own files. Task A works in one directory, Task B works in another. Neither one sees the other's in-progress changes. Your main repo is never touched during the run.

This is also how you can safely let Archon run overnight. A workflow that takes an hour and makes dozens of changes does it all in isolation. When it's done, you review the PR, and if you don't like it, you just close it — nothing in your working directory was ever affected.

---

## How Worktrees Work

A **worktree** is a Git feature that creates a separate checked-out directory linked to the same repository. It's not a clone — it shares Git history, objects, and remotes with your main repo. It's more like a second window into the same codebase, on its own branch.

When Archon creates a worktree for a workflow run, it lands here:

```
~/.archon/workspaces/
└── owner/repo/
    └── worktrees/
        ├── fix/issue-42/     <- task A's workspace
        └── feat/dark-mode/   <- task B's workspace
```

Each worktree is a fully functional checkout. The AI can read files, run tests, edit code, and commit — all inside that directory. When the task finishes and creates a PR, the worktree's branch gets pushed to GitHub. Then it's safe to clean up.

---

## When Isolation Happens

You control isolation behavior with flags on the `workflow run` command:

| Command Pattern | Behavior |
|-----------------|----------|
| `archon workflow run <name> "..."` | Auto-generates a branch name; runs in an isolated worktree |
| `archon workflow run <name> --branch my-branch "..."` | Uses your branch name; runs in an isolated worktree |
| `archon workflow run <name> --no-worktree "..."` | No isolation; runs directly in your current directory |

**The default is isolation.** If you don't pass `--no-worktree`, Archon creates a worktree for you.

Use `--no-worktree` only for tasks that don't modify code — questions, exploration, running `archon-assist`. For anything that touches files, isolation is the right choice.

> **Recommendation**: Always use `--branch` with a descriptive name for code-changing workflows. It makes it easy to identify worktrees later and creates clean branch names on GitHub.

---

## Managing Your Worktrees

Worktrees accumulate over time. Archon gives you a few commands to stay on top of them.

### Viewing Active Worktrees

```bash
archon isolation list
```

Shows all active worktrees: branch name, path, creation time, and status.

### Cleaning Up Stale Worktrees

```bash
archon isolation cleanup
```

Removes worktrees older than 7 days. Pass a number to customize the threshold:

```bash
archon isolation cleanup 14   # Remove worktrees older than 14 days
```

To remove worktrees whose branches have already been merged into your main branch:

```bash
archon isolation cleanup --merged
```

This also deletes the remote branches — a clean sweep after a round of PRs.

By default, branches with open or closed-without-merging PRs are skipped to avoid
accidental deletion. To also clean up abandoned (CLOSED) PRs:

```bash
archon isolation cleanup --merged --include-closed
```

### Completing a Branch Lifecycle

When a PR is merged and you want to remove everything — the worktree, the local branch, and the remote branch — use `complete`:

```bash
archon complete fix/issue-42
```

This is the full lifecycle close-out. Run it after merging and you're back to a clean state.

> **Safety note**: Archon won't remove a worktree that has uncommitted changes. If `cleanup` skips a worktree, check it with `archon isolation list` before deleting manually.

---

## Best Practices

**Always use `--branch` for code changes.** Auto-generated branch names work, but descriptive names like `fix/login-crash` or `feat/csv-export` are much easier to track.

**Clean up after merges.** Run `archon complete <branch>` or `archon isolation cleanup --merged` after a PR lands. A handful of worktrees is fine; dozens of stale ones get confusing.

**Use `--no-worktree` only for read-only tasks.** Questions, analysis, and exploration are safe without isolation. Anything that writes files belongs in a worktree.

**Don't run the same branch twice simultaneously.** Each branch name maps to exactly one worktree. Starting a second workflow on the same branch will conflict with the first.

---

Now that you understand how isolation protects your work, you're ready to start building. In [Chapter 6: Creating Your First Command →](/book/first-command/), you'll write the atomic unit of Archon — the command file — from scratch.
