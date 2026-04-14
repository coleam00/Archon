# Authoring Archon Command Files For Codex

Command files are Markdown prompt templates. They are shared Archon primitives,
not Claude-only assets.

## File Location

```text
.archon/commands/
├── my-command.md
├── review-code.md
└── defaults/
    └── archon-assist-codex.md
```

Commands are referenced by name without the `.md` extension from workflow YAML.

## File Format

```markdown
---
description: One-line description of what this command does
argument-hint: <expected arguments>
---

# Command Title

**Workflow ID**: $WORKFLOW_ID

User request: $ARGUMENTS
Artifacts: $ARTIFACTS_DIR

## Phase 1: Load

[Gather the needed context]

## Phase 2: Execute

[Do the work]

## Phase 3: Report

[Summarize or write artifacts]
```

The full file content, including frontmatter, becomes the prompt.

## Frontmatter Fields

| Field | Required | Description |
| --- | --- | --- |
| `description` | recommended | Human-readable description used in listings |
| `argument-hint` | optional | Expected argument shape such as `<issue-number>` or `(no arguments)` |

## Discovery And Priority

When a workflow references `command: my-command`, Archon resolves in this order:

1. `.archon/commands/my-command.md`
2. `.archon/commands/defaults/my-command.md`
3. bundled defaults shipped with Archon

First match wins.

## Variable Use

Most common variables:

- `$ARGUMENTS`
- `$ARTIFACTS_DIR`
- `$WORKFLOW_ID`
- `$BASE_BRANCH`

See `variables.md` for the full reference.

## Recommended Structure

For non-trivial commands, keep the prompt phased:

1. load context
2. analyze or execute
3. validate if relevant
4. report or write artifacts

Use short checklists when they materially help the workflow stay deterministic.

## Artifact Conventions

If downstream nodes need the result, write it into `$ARTIFACTS_DIR` instead of
leaving it only in free-form assistant output.

Common patterns:

- `$ARTIFACTS_DIR/plan.md`
- `$ARTIFACTS_DIR/investigation.md`
- `$ARTIFACTS_DIR/implementation.md`
- `$ARTIFACTS_DIR/validation.md`

## Authoring Rules For Codex

- keep commands provider-neutral unless a prompt truly depends on provider
  behavior
- do not assume Claude-only node controls such as per-node hooks or skills
- do not hardcode local-only paths when `$ARTIFACTS_DIR` is the intended output
  surface
- do not assume prior conversational memory when the calling node uses fresh
  context

## Anti-Patterns

- vague instructions that do not define expected outputs
- commands that produce no durable artifact when downstream nodes need one
- prompts that assume Claude-specific tools or behavior without saying so
- monolithic prompts with no clear responsibility

## Example

See `examples/command-template.md` for a Codex-safe starter template.
