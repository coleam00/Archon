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

Workflows placed in `~/.archon/workflows/`, commands in `~/.archon/commands/`, and scripts in `~/.archon/scripts/` are loaded globally -- they appear in every project and can be invoked from any repository. Repo-specific files take precedence over home-scoped files with the same name.

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

## Supported layouts

Shared commands/scripts and legacy grouped workflows support one grouping folder. Packaged workflows instead use exactly `<pack>/<workflow>/`, with one YAML file directly inside the workflow folder.

```text
~/.archon/workflows/
├── my-review.yaml              # ✅ top-level file
├── triage/                     # ✅ 1-level subfolder (grouping)
│   └── weekly-cleanup.yaml     # ✅ resolvable as `weekly-cleanup`
└── team/                       # ✅ packaged workflow
    └── personal/
        └── personal.yaml       # exactly one direct YAML is required
```

YAML nested below the workflow folder is not loaded. A package folder without exactly one direct YAML is reported as invalid rather than ignored silently.

Resolution is by **filename without extension** (for commands) or **exact filename** (for workflows), regardless of which subfolder the file lives in. Duplicate basenames within the same scope are a user error -- keep each name unique within `~/.archon/commands/` (or `<repoRoot>/.archon/commands/`), across whatever subfolders you use.

## Load Priority

1. **Bundled defaults** (lowest priority) -- the `archon-*` workflows/commands embedded in the Archon binary.
2. **Global / home-scoped** -- `~/.archon/workflows/`, `~/.archon/commands/`, `~/.archon/scripts/` (override bundled by filename).
3. **Repo-specific** -- `<repoRoot>/.archon/workflows/`, `<repoRoot>/.archon/commands/`, `<repoRoot>/.archon/scripts/` (override global by filename).

Same-named legacy/shared files at a higher scope win. Packaged commands and scripts resolve only within their owning package and never fall through to another scope.

## Installed workflow packs

A workflow pack published on GitHub installs for every project on this Archon with [`archon plugin install`](/reference/cli/#plugin). Installed packs are a fourth source next to bundled, global and project, outside the precedence above.

A pack repository holds one pack in the packaged layout, with an `archon-plugin.json` at its root (the repository root, or a subdirectory named in the install id):

```text
review-kit/                     # plugin root: owner/repo or owner/repo/<path>
├── archon-plugin.json
├── .shared/                    # modules the pack's scripts import
│   └── util.ts
├── review/                     # an entrypoint
│   ├── review.yaml
│   ├── commands/scope.md
│   └── scripts/check.ts
└── helper/                     # a support workflow
    ├── helper.yaml
    └── commands/summarize.md
```

```json
{
  "schemaVersion": 1,
  "kind": "workflow-pack",
  "name": "review-kit",
  "description": "Review workflows",
  "compatibility": { "archon": ">=0.11.0" },
  "entrypoints": { "review": "review/review.yaml" }
}
```

- **Identity.** An entrypoint is listed and run as `owner/plugin:entrypoint`: `owner` is the GitHub owner from the install id and `plugin` is the manifest `name`, so the pack above installed from `acme/review-kit` runs as `archon workflow run acme/review-kit:review`. The YAML `name:` is how workflows refer to each other inside the pack.
- **Support workflows.** Every workflow that is not an entrypoint is support. An entrypoint uses it with `include:` (by its YAML `name:`), and nothing else can run it: not the CLI, chat, the router, the API, another pack, or a project workflow. Inside a pack, a `workflow:` child run may launch another entrypoint of the pack by its YAML `name:`, but not a support workflow, because a child run is dispatch.
- **Names.** A qualified name matches exactly (ignoring case) and never by suffix or substring, and a project or global workflow that declares an installed name is not loaded.
- **Runs keep their revision.** A run freezes the pack at the commit it started with, and a `workflow:` child takes the packs its parent froze. `archon plugin update` or `remove` affects only runs that start afterwards.
- **Installed or copied.** An installed pack is read-only and changes only through `archon plugin update`. To change one for a single project, `archon plugin copy <id>` writes it to `.archon/workflows/<name>/`, where it is an ordinary project pack: its workflows run under their own `name:`, and `update` no longer touches it.

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

The CLI, server, and Web UI discover home-scoped content automatically -- no flag, no config option.

```bash
# Lists bundled + global + repo-specific workflows
archon workflow list

# Run a global workflow from any repo
archon workflow run my-review
```

In the Web UI workflow builder, add a command node and enter the command name in
the inspector. The builder does not currently provide source-grouped command
browsing.

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
