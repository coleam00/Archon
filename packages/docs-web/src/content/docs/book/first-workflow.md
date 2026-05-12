---
title: Creating Your First Workflow
description: Build a multi-step workflow from scratch, adding validation, parallel reviews, and self-fix incrementally.
category: book
part: customization
audience: [user]
sidebar:
  order: 7
---

In [Chapter 6](/book/first-command/) you built a `run-tests` command — a focused task the AI can execute on demand. A command is great for one thing. A workflow strings several commands together and runs them automatically, in order, without you having to supervise.

That's what this chapter is about. You'll build a complete workflow from scratch, starting with two steps and adding one piece at a time until you have something that plans, implements, validates, reviews, and self-corrects.

---

## Workflow Basics

A **workflow** is a YAML file in `.archon/workflows/`. When you run `archon workflow run my-workflow "do something"`, Archon finds the file, reads the nodes, and executes them in dependency order.

The minimum viable workflow looks like this:

```yaml
name: my-workflow
description: A short description of what this does

nodes:
  - id: first
    command: some-command
  - id: second
    command: another-command
    depends_on: [first]
```

That's it. Three fields at the top, a list of nodes below. Each node needs a unique `id`. Archon discovers workflow files recursively inside `.archon/workflows/`, so you can organize them in subdirectories if you want.

> **Where to put it**: Create `.archon/workflows/my-workflow.yaml` in your repository. Run `archon workflow list` to confirm Archon found it.

---

## Version 1: Plan and Implement

Let's build something real. The scenario: you want a workflow that takes a feature request, creates an implementation plan, and then implements it.

Create `.archon/workflows/my-workflow.yaml`:

```yaml
name: my-workflow
description: Plan a feature and implement it

nodes:
  - id: plan
    command: archon-create-plan
  - id: implement
    command: archon-implement-tasks
    depends_on: [plan]
```

Run it:

```bash
archon workflow run my-workflow --branch feature/auth-tokens "Add JWT refresh token support"
```

Archon runs `archon-create-plan` with your input, waits for it to finish, then runs `archon-implement-tasks`. The AI carries its full conversation context from the planning node into the implementation node — it knows what it planned and can act on it immediately.

This is the simplest useful workflow. Two nodes, no configuration, no coordination required from you.

---

## Version 2: Add Validation

Plans and implementations need validation. Let's add a third node that runs your test suite.

```yaml
name: my-workflow
description: Plan, implement, and validate a feature

nodes:
  - id: plan
    command: archon-create-plan
  - id: implement
    command: archon-implement-tasks
    depends_on: [plan]
  - id: validate
    command: run-tests
    depends_on: [implement]
    context: fresh
    prompt: "Run tests for the auth module"
```

Two changes here:

**`prompt:`** alongside `command:` passes extra instructions to the node — in this case, telling it to focus on the auth module.

**`context: fresh`** starts a fresh AI conversation at this node. The AI discards everything from the planning and implementation nodes and comes in with only the command instructions and its current view of the codebase.

Why use fresh context before validation? The implementation conversation may have convinced the AI that certain things are working. A fresh context means the AI actually reads the current test results rather than assuming they'll pass based on what it just wrote.

> **Rule of thumb**: Use `context: fresh` before any node whose job is to independently verify something. You want a fresh pair of eyes, not confirmation bias.

---

## Version 3: Add Parallel Reviews

After validation passes, it helps to get multiple perspectives on the code before creating a PR. Rather than running reviewers one after another, you can run them at the same time.

```yaml
name: my-workflow
description: Plan, implement, validate, and review a feature

nodes:
  - id: plan
    command: archon-create-plan
  - id: implement
    command: archon-implement-tasks
    depends_on: [plan]
  - id: validate
    command: run-tests
    depends_on: [implement]
    context: fresh
    prompt: "Run tests for the auth module"
  - id: code-review
    command: archon-code-review-agent
    depends_on: [validate]
    context: fresh
  - id: error-handling
    command: archon-error-handling-agent
    depends_on: [validate]
    context: fresh
  - id: test-coverage
    command: archon-test-coverage-agent
    depends_on: [validate]
    context: fresh
```

Nodes `code-review`, `error-handling`, and `test-coverage` all depend on `validate` but not on each other — Archon runs them concurrently. Each agent gets its own fresh AI session. Archon waits for all three to finish before moving to the next node.

The time savings add up quickly. Three review agents in parallel takes roughly the same time as one. Five agents takes the same time as two. Parallel execution is one of the most practical reasons to use a workflow.

---

## Version 4: Add Self-Fix

Review agents find problems. This last node reads all three review outputs and fixes what it can before the PR goes out.

```yaml
name: my-workflow
description: Plan, implement, validate, review, and self-fix a feature

nodes:
  - id: plan
    command: archon-create-plan
  - id: implement
    command: archon-implement-tasks
    depends_on: [plan]
  - id: validate
    command: run-tests
    depends_on: [implement]
    context: fresh
    prompt: "Run tests for the auth module"
  - id: code-review
    command: archon-code-review-agent
    depends_on: [validate]
    context: fresh
  - id: error-handling
    command: archon-error-handling-agent
    depends_on: [validate]
    context: fresh
  - id: test-coverage
    command: archon-test-coverage-agent
    depends_on: [validate]
    context: fresh
  - id: self-fix
    command: archon-implement-review-fixes
    depends_on: [code-review, error-handling, test-coverage]
    context: fresh
```

The `archon-implement-review-fixes` command reads the artifacts written by all three review agents, synthesizes their findings, and implements the recommended changes. `context: fresh` keeps it focused on the review findings rather than the full implementation history.

Run the complete workflow:

```bash
archon workflow run my-workflow --branch feature/auth-tokens "Add JWT refresh token support"
```

You've just built a mini version of `archon-idea-to-pr` — the same structure, condensed. That bundled workflow adds a few more nodes (scope confirmation, PR creation, final summary), but the core pattern is identical to what you built here.

---

## Workflow Options Reference

| Option | What it does | When to use |
|--------|-------------|-------------|
| `name` | Identifies the workflow in `archon workflow list` | Required |
| `description` | Shown in listings and used by the router | Required |
| `provider` | Sets the AI provider (any registered provider, e.g. `claude`, `codex`) | When you need a specific provider |
| `model` | Sets the model for all nodes (`sonnet`, `opus`, `haiku`) | When you want to override the config default |
| `context` | `fresh` starts a new session; `shared` inherits from prior node | Use `fresh` before verification nodes |
| `depends_on` | List of node IDs that must complete before this node runs | To express ordering and fan-in |
| `idle_timeout` | Per-node idle timeout in milliseconds (default: 5 minutes) | For long-running nodes |

These options apply at the node level (inside `nodes:`). `provider` and `model` can also be set at the top level of the YAML to apply to all nodes.

**Per-node model override:**
```yaml
nodes:
  - id: plan
    command: archon-create-plan
    model: opus        # use the more capable model for planning

  - id: validate
    command: run-tests
    depends_on: [plan]
    model: haiku       # fast and cheap for a mechanical check
    context: fresh
```

---

## When to Add Conditionals

The `nodes:` format you've been using covers most workflows. To add conditional routing on top of it, add `when:` conditions and `output_format`:

| Need | Solution |
|------|----------|
| Skip a node based on the output of a previous node | `when:` condition |
| Fan out to different handlers based on classified input | `output_format` + `when:` routing |
| Run a node only when at least one upstream succeeded | `trigger_rule: one_success` |
| Repeat a task until a signal appears | `loop:` node type |

If your workflow starts needing an "if this, then that" branch — or structured JSON output from one node to route into another — those features are covered in the next chapter.

[Chapter 8: DAG Workflows →](/book/dag-workflows/) covers conditionals, structured output routing, and trigger rules. Everything you've learned about commands and nodes carries directly over.
