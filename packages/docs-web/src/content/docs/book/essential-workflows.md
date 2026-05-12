---
title: The Essential Workflows
description: A catalog of every built-in Archon workflow with usage examples and guidance on when to use each one.
category: book
part: core-workflows
audience: [user]
sidebar:
  order: 4
---

You now know how Archon works. The question becomes: which workflow do I reach for?

Archon ships with workflows for every major development activity. This chapter maps your intent to the right workflow — and gives you enough detail to use each one confidently.

---

## Which Workflow Should I Use?

```
What do you want to do?
│
├── Ask a question or explore the codebase
│   └── archon-assist
│
├── Fix a bug from a GitHub issue
│   └── archon-fix-github-issue
│
├── Build a new feature
│   ├── From an idea or description →  archon-idea-to-pr
│   ├── From an existing plan file  →  archon-plan-to-pr
│   └── Simple implement + PR       →  archon-feature-development
│
├── Review a pull request
│   ├── Adaptive (skips irrelevant agents)  →  archon-smart-pr-review
│   └── All agents, always                  →  archon-comprehensive-pr-review
│
├── Improve codebase architecture
│   └── archon-architect
│
├── Implement a PRD story by story
│   └── archon-ralph-dag
│
└── Resolve merge conflicts
    └── archon-resolve-conflicts
```

---

## Workflow Catalog

### For Questions and Exploration

#### `archon-assist`

The starting point for anything that doesn't fit elsewhere. It runs a single full-capability Claude Code session against your codebase.

**When to use it**: Questions about the codebase, debugging sessions, one-off tasks, general help when no other workflow applies.

```bash
archon workflow run archon-assist "What does the orchestrator do?"
archon workflow run archon-assist "Why are tests failing in the auth module?"
archon workflow run archon-assist "Explain the isolation system to me"
```

**What it produces**: A direct answer. No PR, no artifacts — just the AI working through your question with full access to your code.

---

### For Bug Fixes

#### `archon-fix-github-issue`

The workflow you ran in Chapter 2. Classifies the issue first (bug vs. feature vs. enhancement), then routes to investigation (bugs) or planning (features). Implements, validates, creates a draft PR, runs smart conditional review agents, auto-fixes findings, simplifies changes, and posts a completion report back to the GitHub issue.

**When to use it**: Any GitHub issue. This is your default for bugs, features, and enhancements alike.

```bash
archon workflow run archon-fix-github-issue --branch fix/login-crash "#142"
```

**What it produces**: A draft PR with the fix, conditional review (code review always runs; error handling, test coverage, docs impact, and comment quality run only when needed), auto-fixes applied, and a summary comment on the issue.

---

### For Feature Development

#### `archon-idea-to-pr`

End-to-end feature development from a description. Creates a plan, verifies it's still valid against the current codebase, implements, validates, creates a PR, runs five parallel review agents, fixes findings, and posts a final summary.

**When to use it**: You have a feature idea and want Archon to handle everything from plan to reviewed PR.

```bash
archon workflow run archon-idea-to-pr --branch feat/export-csv "Add CSV export to the reports page"
```

**What it produces**: A PR ready for merge — plan artifact, implementation artifact, validation results, five-agent review, and a decision matrix posted as a GitHub comment.

---

#### `archon-plan-to-pr`

The same pipeline as `archon-idea-to-pr` — but it skips the planning phase. It takes an existing plan file and executes it.

**When to use it**: You already have a plan (from a previous `archon-assist` session, an `.agents/plans/` file, or a planning workflow) and want to execute it.

```bash
archon workflow run archon-plan-to-pr --branch feat/export-csv "Execute .archon/plans/csv-export.md"
```

**What it produces**: The same PR and review output as `archon-idea-to-pr`, minus the planning step.

---

#### `archon-feature-development`

A lighter-weight alternative. Two steps: implement from a plan, then create a PR. No review pipeline.

**When to use it**: When you need a quick implement-and-ship without the full review overhead. Good for straightforward changes with an existing plan.

```bash
archon workflow run archon-feature-development --branch feat/update-readme "Implement .archon/plans/readme-update.md"
```

**What it produces**: A PR with committed changes.

---

### For Code Review

#### `archon-smart-pr-review`

Reviews the current PR with adaptive agent selection. Classifies the PR complexity first (trivial/small/medium/large), then runs only the agents that matter for that PR. A three-line typo fix skips test-coverage and docs-impact analysis.

**When to use it**: Most PR reviews. Faster than comprehensive because it skips irrelevant agents.

```bash
archon workflow run archon-smart-pr-review "Review PR #87"
```

**What it produces**: Synthesized review findings, auto-fixes for critical/high issues, and an optional push notification when complete.

---

#### `archon-comprehensive-pr-review`

Always runs all five review agents in parallel — code review, error handling, test coverage, comment quality, and docs impact — regardless of PR size.

**When to use it**: Pre-merge reviews on significant PRs where you want every angle covered. Also useful when you want a consistent baseline for a team review process.

```bash
archon workflow run archon-comprehensive-pr-review "Review PR #87"
```

**What it produces**: Parallel five-agent review, synthesized findings, and auto-fixes applied.

---

### For Codebase Health

#### `archon-architect`

Scans for complexity hotspots (large files, import fan-out, function length), analyzes them with an architectural lens, plans targeted simplifications, makes changes with quality feedback hooks, validates, and opens a PR.

**When to use it**: Periodic codebase health passes. When a specific area has grown unwieldy. When you want principled simplification, not just cleanup.

```bash
archon workflow run archon-architect --branch refactor/simplify-orchestrator "Focus on the orchestrator package"
```

**What it produces**: A PR with targeted simplifications, each justified and independently revertable.

---

### For PRD Implementation

#### `archon-ralph-dag`

Implements a **product requirements document** (PRD) story by story, in a loop, until all stories pass.

**When to use it**: Executing a PRD end-to-end with iterative progress tracking.

```bash
archon workflow run archon-ralph-dag "Implement .archon/ralph/notifications/prd.md"
```

**What it produces**: Committed stories one by one, a final PR when all stories pass.

---

### For Merge Conflicts

#### `archon-resolve-conflicts`

Fetches the latest base branch, analyzes conflicts, auto-resolves simple cases, and presents options for complex ones. Commits and pushes the resolution.

**When to use it**: Your PR has merge conflicts and you want help resolving them with full codebase context.

```bash
archon workflow run archon-resolve-conflicts "Resolve conflicts on PR #94"
```

**What it produces**: A committed conflict resolution pushed to the PR branch.

---

## Quick Reference

| Workflow | Use When | Creates PR? | Uses Isolation? |
|----------|----------|-------------|-----------------|
| `archon-assist` | Questions, exploration, debugging | No | No |
| `archon-fix-github-issue` | Fix a GitHub issue (smart routing) | Yes (draft) | Yes |
| `archon-idea-to-pr` | Feature from description | Yes | Yes |
| `archon-plan-to-pr` | Execute an existing plan | Yes | Yes |
| `archon-feature-development` | Implement + ship (lightweight) | Yes | Yes |
| `archon-smart-pr-review` | Review current PR (adaptive) | No | No |
| `archon-comprehensive-pr-review` | Review current PR (all agents) | No | No |
| `archon-architect` | Architectural sweep | Yes | Yes |
| `archon-ralph-dag` | PRD implementation loop | Yes | Yes |
| `archon-resolve-conflicts` | Resolve merge conflicts | No | No |

---

## Discovering More Workflows

To see all workflows available in your current directory:

```bash
archon workflow list
```

The list shows both Archon's bundled defaults and any custom workflows in your repo's `.archon/workflows/` directory. Custom workflows override bundled ones by name — if you create a workflow named `archon-assist`, it replaces the built-in.

Ready to build your own? In [Chapter 7: Creating Your First Workflow →](/book/first-workflow/), you'll build one from scratch — incrementally, version by version, until you've got a mini version of `archon-idea-to-pr`.

But first, let's cover the isolation system that makes parallel workflows safe. Continue to [Chapter 5: Isolation and Worktrees →](/book/isolation/)
