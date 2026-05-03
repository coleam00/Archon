---
title: Global Workflows, Commands, and Scripts
description: Define user-level workflows, commands, and scripts that apply to every project on your machine.
category: guides
area: workflows
audience: [user]
status: current
sidebar:
  order: 9
---

Workflows placed in `~/.archon/workflows/`, commands in `~/.archon/commands/`, and scripts in `~/.archon/scripts/` are loaded globally -- they appear in every project and can be invoked from any repository. Workflows and commands carry the `source: 'global'` label in the Web UI node palette; scripts resolve under the same repo-wins-over-home precedence.

## Paths

```
~/.archon/workflows/
~/.archon/commands/
~/.archon/scripts/
```

Or, if you have set `ARCHON_HOME`:

```
$ARCHON_HOME/workflows/
$ARCHON_HOME/commands/
$ARCHON_HOME/scripts/
```

Create the directories if they do not exist:

```bash
mkdir -p ~/.archon/workflows ~/.archon/commands ~/.archon/scripts
```

> **Note on location.** These are direct children of `~/.archon/` -- same level as `workspaces/`, `archon.db`, and `config.yaml`. Earlier Archon versions stored global workflows at `~/.archon/.archon/workflows/`; see [Migrating from the old path](#migrating-from-the-old-path) below.

## Subfolders (1 level deep)

Each directory supports one level of subfolders for grouping, matching the existing `defaults/` convention. Deeper nesting is ignored silently.

```
~/.archon/workflows/
├── my-review.yaml              # ✅ top-level file
├── triage/                     # ✅ 1-level subfolder (grouping)
│   └── weekly-cleanup.yaml     # ✅ resolvable as `weekly-cleanup`
└── team/personal/too-deep.yaml # ❌ ignored — 2 levels down
```

Resolution is by **filename without extension** (for commands) or **exact filename** (for workflows), regardless of which subfolder the file lives in. Duplicate basenames within the same scope are a user error -- keep each name unique within `~/.archon/commands/` (or `<repoRoot>/.archon/commands/`), across whatever subfolders you use.

## Load Priority

1. **Bundled defaults** (lowest priority) -- the `archon-*` workflows/commands embedded in the Archon binary.
2. **Global / home-scoped** -- `~/.archon/workflows/`, `~/.archon/commands/`, `~/.archon/scripts/` (override bundled by filename).
3. **Repo-specific** -- `<repoRoot>/.archon/workflows/`, `<repoRoot>/.archon/commands/`, `<repoRoot>/.archon/scripts/` (override global by filename).

Same-named files at a higher scope win. A repo can override a personal helper by dropping a file with the same name in its own `.archon/workflows/`, `.archon/commands/`, or `.archon/scripts/`.

## Practical Examples

### Personal Code Review

A workflow that runs your preferred review checklist on every project:

```yaml
# ~/.archon/workflows/my-review.yaml
name: my-review
description: Personal code review with my standards
model: sonnet

nodes:
  - id: review
    prompt: |
      Review the changes on this branch against main.
      Check for: error handling, test coverage, naming conventions,
      and unnecessary complexity. Be direct and specific.
```

### Custom Linting or Formatting Check

A workflow that runs project-agnostic checks:

```yaml
# ~/.archon/workflows/lint-check.yaml
name: lint-check
description: Check for common code quality issues across any project

nodes:
  - id: check
    prompt: |
      Scan this codebase for:
      1. Functions longer than 50 lines
      2. Deeply nested conditionals (>3 levels)
      3. TODO/FIXME comments without issue references
      Report findings as a prioritized list.
```

### Quick Explain

A simple workflow for understanding unfamiliar codebases:

```yaml
# ~/.archon/workflows/explain.yaml
name: explain
description: Quick explanation of a codebase or module
model: haiku

nodes:
  - id: explain
    prompt: |
      Give a concise explanation of this codebase.
      Focus on: what it does, key entry points, and how the main
      pieces connect. Keep it under 500 words.
      Topic: $ARGUMENTS
```

### Personal Command Helpers

Commands placed in `~/.archon/commands/` are available to every workflow on the machine. Useful for prompts you reuse across projects.

```markdown
<!-- ~/.archon/commands/review-checklist.md -->
Review the uncommitted changes in the current worktree.
Check for:
- Error handling gaps
- Missing tests
- Surprising API shapes
- Unnecessary cleverness
Be terse. Report findings grouped by file.
```

A workflow in any repo can then reference it:

```yaml
nodes:
  - id: review
    command: review-checklist
```

## Syncing with Dotfiles

If you manage your configuration with a dotfiles repository, you can include your global content:

```bash
# In your dotfiles repo
dotfiles/
└── archon/
    ├── workflows/
    │   ├── my-review.yaml
    │   └── explain.yaml
    └── commands/
        └── review-checklist.md
```

Then symlink during dotfiles setup:

```bash
ln -sf ~/dotfiles/archon/workflows ~/.archon/workflows
ln -sf ~/dotfiles/archon/commands  ~/.archon/commands
```

Or copy them as part of your dotfiles install script:

```bash
mkdir -p ~/.archon/workflows ~/.archon/commands
cp ~/dotfiles/archon/workflows/*.yaml ~/.archon/workflows/
cp ~/dotfiles/archon/commands/*.md    ~/.archon/commands/
```

This way your personal workflows and commands travel with you across machines.

## CLI and Web Support

Both the CLI, the server, and the Web UI discover home-scoped content automatically -- no flag, no config option.

```bash
# Lists bundled + global + repo-specific workflows
archon workflow list

# Run a global workflow from any repo
archon workflow run my-review
```

In the Web UI workflow builder, commands from `~/.archon/commands/` appear under a **Global (~/.archon/commands/)** section in the node palette, distinct from project and bundled entries.

## Migrating from the old path

Pre-refactor versions of Archon stored global workflows at `~/.archon/.archon/workflows/` (with an extra nested `.archon/`). That location is no longer read. If you have workflows there, Archon emits a one-time deprecation warning on first use telling you the exact migration command:

```bash
mv ~/.archon/.archon/workflows ~/.archon/workflows && rmdir ~/.archon/.archon
```

Run it once; the warning stops firing on subsequent invocations. There was no prior home-scoped commands location, so `~/.archon/commands/` is new capability -- nothing to migrate.

## Troubleshooting

### Workflow Not Appearing in List

1. **Check the path** -- The directory must be exactly `~/.archon/workflows/` (a direct child of `~/.archon/`, not the old double-nested `~/.archon/.archon/workflows/`).

   ```bash
   ls ~/.archon/workflows/
   ```

2. **Check file extension** -- Workflow files must end in `.yaml` or `.yml`.

3. **Check YAML validity** -- A syntax error in the YAML will cause the workflow to appear in the errors list rather than the workflow list. Run:

   ```bash
   archon validate workflows my-workflow
   ```

4. **Check for name conflicts** -- If a repo-specific workflow has the same filename, it overrides the global one. The global version will not appear when you are in that repo.

5. **Check ARCHON_HOME** -- If you have set `ARCHON_HOME` to a custom path, global workflows must be at `$ARCHON_HOME/workflows/`, not `~/.archon/workflows/`.
