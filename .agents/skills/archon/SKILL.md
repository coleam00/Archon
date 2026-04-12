---
name: archon
description: |
  Use when the user wants Codex to run or monitor Archon workflows, or when a task
  should be delegated from Codex into an Archon workflow instead of being handled
  directly in the current session.
  Triggers: "use archon", "run archon", "archon workflow", "archon assist",
            "codex archon assist", "have archon handle this", "use archon codex".
  Also use when the user wants help choosing the Codex-safe Archon workflow for a task.
  NOT for: Direct local implementation when the user wants Codex to do the work here
  without handing off to Archon.
---

# Archon For Codex

Archon runs long-form workflows through its own CLI and workflow engine. In Codex,
this skill exists to route work into the right Archon workflow and to avoid
Claude-specific workflow names or assumptions.

## First Step

Check the available workflows before suggesting or running one:

```bash
archon workflow list --json
```

If `archon` is unavailable, report that the Archon CLI is not installed or not on
`PATH`. Do not perform setup unless the user explicitly asks.

## Codex Naming Convention

Prefer Archon workflows ending in `-codex` when they exist. That suffix indicates
the workflow has been tuned or separated for Codex behavior.

Known Codex-specific lanes in this repo:

- `archon-assist-codex` for general Archon help, debugging, exploration, and
  one-off questions
- `archon-piv-loop-codex` for guided Plan-Implement-Validate workflows with
  Codex

If the user asks for a general Archon task and a Codex-specific workflow exists,
prefer that workflow over the Claude/default variant.

If the user explicitly names a Claude-tuned workflow, respect that request but
warn when the workflow includes Claude-only features that Codex ignores.

## Codex Limitations In Archon

Archon already warns when a Codex workflow node contains Claude-only features.
Plan around those limits instead of assuming they work:

- node-level `skills`
- node-level `hooks`
- node-level `mcp`
- node-level `allowed_tools`
- node-level `denied_tools`

When a workflow relies on those features, prefer a `-codex` workflow if one
exists. Otherwise tell the user the workflow may run with degraded behavior on
Codex.

## Running Workflows

Use explicit workflow names whenever possible.

General Codex assist:

```bash
archon workflow run archon-assist-codex --branch <branch-name> "<message>"
```

Guided Codex PIV:

```bash
archon workflow run archon-piv-loop-codex --branch <branch-name> "<message>"
```

Rules:

1. Use `--branch` unless the user explicitly wants `--no-worktree`.
2. Use descriptive branch names, for example `assist/codex-readme` or
   `piv/codex-auth-refactor`.
3. For read-only questions or exploration, `--no-worktree` is acceptable.
4. Prefer one Archon workflow per command rather than combining unrelated tasks.

## Monitoring

Use:

```bash
archon workflow status --json
```

When an interactive workflow pauses, relay the workflow's question clearly and
pass the user's answer back through the Archon approval or reject command rather
than trying to continue locally.

## Repo Guidance

Do not assume Codex auto-loaded `CLAUDE.md` even if a fallback filename is
configured globally. If repo conventions are load-bearing for the delegated task,
read `CLAUDE.md` explicitly before recommending or running the workflow.
