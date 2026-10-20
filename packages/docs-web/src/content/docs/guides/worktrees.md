---
title: Run work in parallel with worktrees
description: How Archon gives each repository run its own git worktree, and how to inspect, provision and clean up worktrees.
category: guides
area: workflows
audience: [user]
status: current
sidebar:
  order: 2
---

A run against a repository works in its own git worktree by default: a separate checkout of the same repository on its own branch. Two runs can edit `auth.ts` at the same time without seeing each other's changes, and a run's ordinary edits stay in its worktree instead of your checkout. If you don't like the result, close the pull request.

A worktree separates checkouts. It is not an execution or security sandbox: commands a run executes can still affect files outside it. For an isolated execution environment on a folder project, see [Container isolation](/guides/container-isolation/).

## Choose how a run is isolated

| Command | Behavior |
|---|---|
| `archon workflow run <name> "..."` | New worktree on a generated branch |
| `archon workflow run <name> --branch fix/login "..."` | Worktree on that branch, created or reused |
| `archon workflow run <name> --no-worktree "..."` | Runs in your current checkout |

Use `--branch` with a descriptive name for work that changes code; it makes worktrees and pull requests easy to identify. Use `--no-worktree` only for read-only work. A workflow can pin the choice with `worktree.enabled` in its YAML. Don't start two runs on the same branch at once: one branch maps to one worktree.

By default, worktrees live under `~/.archon/workspaces/<owner>/<repo>/worktrees/`. Set `worktree.path` in the repository's config for a repo-local location such as `.worktrees`, and add it to `.gitignore`.

A workflow can also start a child run with its own worktree by writing `isolation: worktree` on a `workflow:` node; see [Launching a separate governed run](/guides/authoring-workflows/#launching-a-separate-governed-run-with-workflow). Those branches have generated names such as `archon/task-3f9a1c2b-...-child-0`. A paused or failed child run resumes in its original worktree, so leave child worktrees alone until the whole run has finished.

## Provision new worktrees

Prepare dependencies and generated files before agents start, in the repository's `.archon/config.yaml`:

```yaml
worktree:
  copyFiles: ['.env']
  postCreate:
    - bun install --frozen-lockfile
  postCreateTimeout: 300000     # per command, in milliseconds
```

Commands run in order in the new checkout, after submodules and copied files. A command that exits nonzero, times out or cannot start stops worktree creation, and the error reports the exit code or timeout with the command's output. An existing worktree is reused without running setup again. Setup should provision the checkout, not leave a server running. Copied `.env` files are not loaded automatically. See [Configuration](/reference/configuration/) for every `worktree` option.

## Inspect and clean up

```bash
archon isolation list                         # active worktrees and containers
archon isolation cleanup                      # remove eligible environments older than 7 days
archon isolation cleanup 14                   # ... older than 14 days
archon isolation cleanup --merged             # remove environments whose branches merged
archon isolation cleanup --merged --include-closed   # also those whose PRs closed unmerged
archon complete fix/login                     # remove a branch's worktree and local branch; attempt remote deletion
```

Cleanup keeps live runs, resumable failed runs, worktrees with uncommitted changes and commits that exist on no remote. `--merged` and `archon complete` also attempt remote branch deletion. If it fails or times out, cleanup warns and can still finish local removal, leaving the remote branch behind. A completed run removes its own worktree when the worktree is clean and every commit is on a remote, keeping the branch.

Without a server, schedule merged cleanup with the SDLC pack's `archon-worktree-cleanup` workflow. A failed run keeps its worktree so you can resume it with `archon workflow resume <run-id>`, or mark it cancelled with `archon workflow abandon <run-id>` and let cleanup remove the worktree.
