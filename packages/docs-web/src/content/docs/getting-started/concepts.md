---
title: Core Concepts
description: Key concepts in Archon — workflows, nodes, commands, and isolation.
category: getting-started
audience: [user]
sidebar:
  order: 1
---

Archon orchestrates AI coding agents through four core concepts. Understanding these will make everything else click.

## Workflows

A **workflow** is a YAML file that defines a multi-step AI coding task as a directed acyclic graph (DAG). Each workflow lives in `.archon/workflows/` and has a name, description, and a set of nodes with declared dependencies.

```yaml
name: fix-issue
description: Investigate and fix a GitHub issue

nodes:
  - id: investigate
    command: investigate-issue

  - id: implement
    command: implement-issue
    depends_on: [investigate]
    context: fresh
```

Nodes without dependencies run immediately. Nodes in the same dependency layer run in parallel. This means a workflow with three independent review nodes will fan out and run all three concurrently, then converge at a downstream node that depends on all of them.

Archon ships with bundled default workflows. Run `archon workflow list` to see what's available, or browse `.archon/workflows/defaults/` for real examples.

## Nodes

Nodes are the building blocks of workflows. Each node does exactly one thing, and every node must specify exactly one of six types:

| Type | What it does |
|------|-------------|
| `command:` | Loads a command file from `.archon/commands/` and sends it to an AI agent |
| `prompt:` | Sends an inline prompt string to an AI agent |
| `bash:` | Runs a shell script (no AI). Stdout is captured as `$nodeId.output` |
| `loop:` | Runs an AI prompt repeatedly until a completion signal is detected |
| `approval:` | Pauses the workflow for human review (approve or reject) |
| `cancel:` | Terminates the workflow early with a reason string |

Nodes connect through `depends_on` to form a DAG. You can add conditional branching with `when:` expressions, control join behavior with `trigger_rule`, and override the AI provider or model per node.

```yaml
nodes:
  - id: classify
    command: classify-issue
    output_format:
      type: object
      properties:
        type: { type: string, enum: [BUG, FEATURE] }
      required: [type]

  - id: fix-bug
    command: fix-bug
    depends_on: [classify]
    when: "$classify.output.type == 'BUG'"

  - id: build-feature
    command: build-feature
    depends_on: [classify]
    when: "$classify.output.type == 'FEATURE'"
```

## Commands

A **command** is a markdown file in `.archon/commands/` that serves as an AI prompt template. When a workflow node references `command: investigate-issue`, Archon loads `.archon/commands/investigate-issue.md`, substitutes variables, and sends the result to the AI.

Commands support variable substitution. The most commonly used variables:

| Variable | Resolves to |
|----------|-------------|
| `$ARGUMENTS` | The user's input message |
| `$ARTIFACTS_DIR` | Pre-created directory for workflow artifacts |
| `$BASE_BRANCH` | The base branch (auto-detected or configured) |
| `$DOCS_DIR` | Documentation directory path (default: `docs/`) |
| `$WORKFLOW_ID` | Unique ID for the current workflow run |

See the [Variable Reference](/reference/variables/) for the complete list.

Archon ships with bundled default commands for common operations like investigation, implementation, and code review. Repo-level commands in `.archon/commands/` override bundled defaults with the same name.

## Isolation (Worktrees)

Every workflow run gets its own **git worktree** by default -- an isolated copy of your repository. This gives you three things:

1. **Your working branch stays clean.** Workflow changes happen in a separate directory.
2. **Multiple workflows run in parallel** without conflicting with each other.
3. **Failed runs don't leave a mess.** Clean up with `archon isolation cleanup`.

Worktrees live at `~/.archon/workspaces/<owner>/<repo>/worktrees/`. Each worktree gets its own branch, so you can inspect the work, create a PR from it, or discard it.

To opt out of isolation (run directly in your checkout), pass `--no-worktree`:

```bash
archon workflow run quick-fix --no-worktree "Fix the typo in README"
```

When you're done with a worktree's branch, clean up everything (worktree + local and remote branches) with:

```bash
archon complete <branch-name>
```

---

## Next Steps

- [Quick Start](/getting-started/quick-start/) -- Run your first workflow
- [Authoring Workflows](/guides/authoring-workflows/) -- Create your own multi-step workflows
- [Authoring Commands](/guides/authoring-commands/) -- Write effective prompt templates
- [Variable Reference](/reference/variables/) -- All supported variables
