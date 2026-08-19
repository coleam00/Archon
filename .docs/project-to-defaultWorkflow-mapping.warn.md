# WARN — Windows long-path prerequisite for `defaultWorkflows`

**Applies to:** any workflow dispatched via `defaultWorkflows:` (or run any other way) that
creates a git worktree, on Windows, against a project whose repository contains deeply
nested and/or long file/folder names.

## Symptom

Dispatching to the mapped project's workflow starts (`orchestrator.default_workflow_started`
logs correctly), then fails during isolation setup with an error like:

```
Command failed: git -C <repo> worktree add <worktree-path> <branch>
Preparing worktree (checking out '<branch>')
error: unable to create file <long relative path>: Filename too long
...
fatal: cannot create directory at '<long relative path>': Filename too long
```

The Slack/chat surface shows only a generic `⚠️ An unexpected error occurred. Try /reset to
start a fresh session.` — the real cause is buried in the server log, not surfaced to chat.

## Root cause

Windows enforces a 260-character `MAX_PATH` by default. Once Archon's worktree destination
(`~/.archon/workspaces/<owner>/<repo>/worktrees/archon/<branch>/`) is prepended to a
repository's own long nested relative paths, many resulting full paths exceed that limit.
`git worktree add`'s checkout step then refuses to create those files, and the whole
`worktree add` fails — not specific to any one file, the whole operation aborts.

This is **not** a bug in `defaultWorkflows`, its dispatch logic, or the `obs_entry` test
workflow. It is a pre-existing Windows/git limitation that this feature's live testing
happened to surface, because it was the first time a worktree was created against a
real-world project (an Obsidian vault) with unusually long, descriptive nested file names.

## Fix

```
git config --global core.longpaths true
```

Git for Windows has its own opt-in long-path support (via the `\\?\` path-prefix trick),
independent of any Windows OS-level setting. Setting it **globally** — not scoped to a
single repo — is recommended, since any future registered project could hit the same
limit.

Verify it took effect:

```
git config --global --get core.longpaths
# → true
```

No Archon restart or code change is required — the fix takes effect on the next `git`
invocation.

## Recommendation

Set this **before** the first `defaultWorkflows`-dispatched (or any worktree-creating) run
against a project with long nested paths, rather than discovering it via an opaque
mid-run failure. Consider documenting this as a general Windows setup step, not something
specific to this feature — any workflow with `worktree.enabled` (the default) can hit it
against the right repository shape.
