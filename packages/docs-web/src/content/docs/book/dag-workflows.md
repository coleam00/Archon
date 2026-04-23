---
title: DAG Workflows
description: Build workflows with conditional branching, parallel execution, and structured output routing using the DAG node format.
category: book
part: advanced
audience: [user]
sidebar:
  order: 8
---

In [Chapter 7](/book/first-workflow/) you built a workflow that runs commands in sequence, one after another. That covers a lot of ground — plan, implement, validate, review. But there's a class of problems sequential steps can't solve cleanly: "run this node only if the previous result was a bug, not a feature request" or "wait for three independent reviewers to finish, then merge their findings."

That's what **DAG workflows** (Directed Acyclic Graphs) are for. Instead of a straight line, you're describing a graph: which nodes exist, which depend on which, and under what conditions each node should run. Archon's `nodes:` format gives you that graph.

---

## When to Use DAG

| What you need | The solution |
|---------------|--------------|
| Simple sequence, one after another | Sequential `nodes:` with `depends_on` |
| Repeat until done | `loop:` node |
| Skip a node based on previous output | `when:` condition |
| Fan out to different handlers based on classified input | `output_format` + `when:` routing |
| Express exactly which nodes depend on which | `depends_on` edges |
| Run independent nodes at the same time | Nodes with no shared dependencies |

If your workflow needs an "if this, then that" branch — or if you want to express a dependency chain that's more complex than top-to-bottom — `nodes:` is your answer.

---

## Core Concepts

### Nodes and Dependencies

A **node** is the atomic unit of work in a DAG workflow. Each node has a unique `id`, something to run (`command:`, `prompt:`, or `bash:`), and optionally a list of nodes it depends on.

```yaml
nodes:
  - id: investigate
    command: investigate-issue

  - id: implement
    command: implement-changes
    depends_on: [investigate]
```

Archon won't start `implement` until `investigate` completes successfully. If `investigate` fails, `implement` is skipped.

### Parallel Execution

Nodes with no shared dependencies run **concurrently**. Archon groups nodes into topological layers and runs each layer in parallel:

```yaml
nodes:
  - id: scope
    command: create-review-scope

  - id: code-review
    command: code-review-agent
    depends_on: [scope]

  - id: security-review
    command: security-review-agent
    depends_on: [scope]

  - id: synthesize
    command: synthesize-reviews
    depends_on: [code-review, security-review]
```

Here, `code-review` and `security-review` both depend on `scope` but not on each other. They run in parallel. `synthesize` waits for both to complete before starting.

### Layers

Archon computes topological layers automatically. You describe the *what* (which nodes, which dependencies); Archon figures out the *when*. The workflow above has three layers:

```
Layer 1: scope
Layer 2: code-review  |  security-review   (concurrent)
Layer 3: synthesize
```

You don't configure layers explicitly — they emerge from your `depends_on` edges.

---

## Build It: Classify and Route

### The Goal

You want a workflow that accepts a bug report or feature request, figures out which it is, and then routes to the appropriate handler before implementing the fix or plan.

The challenge: you can't know at workflow-authoring time which branch you'll need. The classification happens at runtime, and the routing needs to follow it.

### Step-by-Step YAML

Create `.archon/workflows/classify-and-route.yaml`:

```yaml
name: classify-and-route
description: |
  Classify an issue as a bug or feature, then run the appropriate path.

  Use when: User reports a problem or requests a new capability.
  Produces: Code fix (bug path) or feature plan (feature path), then a PR.

nodes:
  - id: classify
    command: classify-issue
    output_format:
      type: object
      properties:
        type:
          type: string
          enum: [BUG, FEATURE]
      required: [type]

  - id: investigate
    command: investigate-bug
    depends_on: [classify]
    when: "$classify.output.type == 'BUG'"

  - id: plan
    command: plan-feature
    depends_on: [classify]
    when: "$classify.output.type == 'FEATURE'"

  - id: implement
    command: implement-changes
    depends_on: [investigate, plan]
    trigger_rule: none_failed_min_one_success

  - id: create-pr
    command: create-pr
    depends_on: [implement]
    context: fresh
```

### Run and Observe

```bash
archon workflow run classify-and-route --branch fix/auth-issue "Users can't log in after password reset"
```

Watch what happens:

1. `classify` runs and returns `{"type": "BUG"}`
2. `investigate` runs (condition passed); `plan` is skipped (condition failed)
3. `implement` runs — it has one successful dependency, which satisfies `none_failed_min_one_success`
4. `create-pr` runs in a fresh context

Run it again with a feature request:

```bash
archon workflow run classify-and-route --branch feature/dark-mode "Add dark mode support"
```

This time `plan` runs; `investigate` is skipped. The same workflow, two paths.

---

## Conditional Execution

### The `when` Clause

`when:` evaluates a condition before running a node. If the condition is false, the node is skipped:

```yaml
when: "$nodeId.output == 'VALUE'"
when: "$nodeId.output != 'VALUE'"
when: "$nodeId.output.field == 'VALUE'"   # JSON field access
```

If the expression is invalid or can't be evaluated, Archon fails open — the node runs rather than silently skipping.

### Accessing Node Output

Every completed node exposes its output via `$nodeId.output`. For nodes with `output_format`, you can access individual fields with dot notation:

```yaml
when: "$classify.output.type == 'BUG'"
```

You can also use `$nodeId.output` directly inside `prompt:` text to pass context downstream:

```yaml
- id: report
  prompt: "Summarize the investigation findings: $investigate.output"
  depends_on: [investigate]
```

### Structured Output with `output_format`

`output_format` tells Archon to enforce JSON output from an AI node. Pass a JSON Schema and Archon will ensure the node returns data in that shape:

```yaml
- id: classify
  command: classify-issue
  output_format:
    type: object
    properties:
      type:
        type: string
        enum: [BUG, FEATURE]
      severity:
        type: string
        enum: [low, medium, high]
    required: [type]
```

The result is available as `$classify.output` (full JSON string) or `$classify.output.type`, `$classify.output.severity` (individual fields).

> **Use `output_format` whenever you need routing.** Without it, `$nodeId.output` is a plain text string and field access won't work reliably.

### Trigger Rules

When a node has multiple dependencies and some might be skipped, `trigger_rule` controls the join behavior:

| Value | Behavior |
|-------|----------|
| `all_success` | Run only if all upstream deps completed successfully (default) |
| `one_success` | Run if at least one upstream dep completed successfully |
| `none_failed_min_one_success` | Run if no deps failed AND at least one succeeded (skipped deps are OK) |
| `all_done` | Run when all deps are in a terminal state (completed, failed, or skipped) |

The classify-and-route example uses `none_failed_min_one_success` on `implement` because exactly one of `investigate` or `plan` will be skipped. The default `all_success` would fail because a skipped node doesn't count as a success.

---

## Node Types

Archon supports seven node types:

| Type | Syntax | When to use |
|------|--------|-------------|
| **Command** | `command: my-command` | Load a command from `.archon/commands/my-command.md`. The standard choice. |
| **Prompt** | `prompt: "inline instructions..."` | Quick, one-off instructions that don't need a reusable command file. |
| **Bash** | `bash: "shell command"` | Run a shell script without AI. Stdout is captured as `$nodeId.output`. Deterministic operations only. |
| **Script** | `script: "..." runtime: bun\|uv` | TypeScript (via bun) or Python (via uv) — deterministic typed transforms where bash would need fragile quoting. Stdout is captured as `$nodeId.output`. See [Script Nodes](/guides/script-nodes/). |
| **Loop** | `loop: { prompt: "...", until: SIGNAL }` | Repeat an AI prompt until a completion signal appears in the output. See [Loop Nodes](/guides/loop-nodes/). |
| **Approval** | `approval: { message: "..." }` | Pause the run for human review before continuing. See [Approval Nodes](/guides/approval-nodes/). |
| **Cancel** | `cancel: "reason string"` | Terminate the run with a reason (useful as a `when:`-gated branch for safety checks). |

**Command** is the most common. Use it for anything you'll reuse across workflows.

**Prompt** is convenient for glue nodes — summarizing outputs, formatting data — where the logic is simple and workflow-specific.

**Bash** is powerful for deterministic operations: running tests, checking git status, reading a file, fetching an API. The AI doesn't run the bash command; your shell does. The output becomes a variable for downstream nodes:

```yaml
- id: check-tests
  bash: "bun run test 2>&1 | tail -20"

- id: fix-failures
  command: fix-test-failures
  depends_on: [check-tests]
  prompt: "Test output: $check-tests.output\n\nFix any failures."
```

**Loop** is for iterative tasks where you don't know how many steps it will take. The AI runs until it emits a completion signal:

```yaml
- id: implement-stories
  loop:
    prompt: |
      Read progress from .archon/progress.json.
      Implement the next incomplete story with tests.
      Update progress. If all stories done: <promise>COMPLETE</promise>
    until: COMPLETE
    max_iterations: 20
    fresh_context: true
```

---

## Best Practices

**Keep nodes focused.** A node that investigates a bug should investigate — not also implement the fix. Single responsibility makes debugging easier and conditional routing more reliable.

**Use `bash:` for deterministic operations.** Don't ask an AI to run tests and tell you if they passed. Run the tests yourself with `bash:` and feed the output to the AI. Shell commands are reproducible; AI summaries of shell commands are not.

**Use `output_format` for routing decisions.** Any time a `when:` condition reads a field value, the upstream node should have `output_format` defined. Without it, you're pattern-matching free text and that's fragile.

**Test with simple inputs first.** Before running your full workflow on real data, verify that each branch of a conditional routes correctly. Create a simple test input that's clearly a bug, confirm the BUG path runs. Then test with a clear feature request.

**Let DAG resume handle failures.** If a long workflow fails partway through, run it again. Archon automatically skips nodes that already completed and resumes from where it left off. No `--resume` flag required.

---

You now have the full DAG toolkit. The same commands you built in Chapters 6 and 7 work as nodes — `command:` is the bridge. The difference is the wiring between them: explicit dependencies, conditional paths, and parallel execution by default.

[Chapter 9: Hooks and Quality Loops →](/book/hooks-and-quality/) covers the next level: intercepting tool calls to inject guidance, create quality gates, or deny specific actions within a node.
