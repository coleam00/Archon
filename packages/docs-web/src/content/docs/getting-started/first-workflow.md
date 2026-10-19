---
title: Build your first workflow
description: Write a command and a workflow that plans, implements, checks and reviews a change, one version at a time.
category: getting-started
audience: [user]
sidebar:
  order: 3
---

In this tutorial you write a command file and a workflow, then grow the workflow until it plans, implements, runs your tests with fresh eyes, reviews the change in parallel and fixes what the review found. You need Archon installed and a provider added; see the [Quickstart](/getting-started/quick-start/).

## Write a command

A command is a markdown file of instructions for an agent. Create `.archon/commands/run-tests.md` in your repository:

```markdown
---
description: Run the project's tests and report the results
---

# Run tests

Run this project's test suite. Find the test command in the project's own
files (for example `package.json`, `Makefile` or `pyproject.toml`).

Report:

- **Status:** PASSED or FAILED
- **Failures:** each failing test with its error message
- **Next step:** the most likely fix, if anything failed

If you can't find a test command, say so and list where you looked.
```

Before the agent sees a command, Archon replaces its variables. `$ARGUMENTS` holds the run's whole message, and `$ARTIFACTS_DIR` is a directory created for each run where nodes leave files for later nodes. See [Variables](/reference/variables/) for the full list.

## Version 1: plan and implement

Create `.archon/workflows/my-workflow.yaml`:

```yaml
name: my-workflow
description: Plan a change and implement it

nodes:
  - id: plan
    prompt: "Write an implementation plan for: $ARGUMENTS. Save it to $ARTIFACTS_DIR/plan.md."

  - id: implement
    depends_on: [plan]
    prompt: "Implement the plan in $ARTIFACTS_DIR/plan.md. Commit as you go."
```

Check that Archon finds it, then run it:

```bash
archon validate workflows my-workflow
archon workflow run my-workflow --branch feat/refresh-tokens "Add JWT refresh token support"
```

Archon runs `plan`, waits for it to finish, then runs `implement`. The run works in its own worktree on the branch `feat/refresh-tokens`, so your checkout is untouched.

## Version 2: check with fresh eyes

Add a node that runs your command in a new agent session:

```yaml
  - id: validate
    depends_on: [implement]
    command: run-tests
    context: fresh
```

`command: run-tests` loads the file you wrote. `context: fresh` starts a new session, so the agent reads the current test results instead of trusting what the implementer believed it wrote. Use `context: fresh` before any node whose job is to verify independently.

## Version 3: review in parallel

Add three reviewers that depend on `validate` but not on each other:

```yaml
  - id: review-code
    depends_on: [validate]
    context: fresh
    prompt: "Review this branch's changes for bugs. Write findings to $ARTIFACTS_DIR/review-code.md."

  - id: review-errors
    depends_on: [validate]
    context: fresh
    prompt: "Review this branch's error handling. Write findings to $ARTIFACTS_DIR/review-errors.md."

  - id: review-tests
    depends_on: [validate]
    context: fresh
    prompt: "Review this branch's test coverage. Write findings to $ARTIFACTS_DIR/review-tests.md."
```

Archon runs the three at the same time, each in its own session, and waits for all of them before any node that depends on them.

## Version 4: fix what the review found

```yaml
  - id: fix
    depends_on: [review-code, review-errors, review-tests]
    context: fresh
    prompt: "Read the findings in $ARTIFACTS_DIR/review-*.md and fix the real problems. Commit the fixes."
```

Validate and run the finished workflow:

```bash
archon validate workflows my-workflow
archon workflow run my-workflow --branch feat/refresh-tokens "Add JWT refresh token support"
```

This is a small version of the bundled `archon-deliver` workflow, which adds a pull request, a review that re-checks every correction, and a wait for CI.

## Where to go next

- **Pick a model per node.** Add `model: large` or `model: small` to a node to use a configured tier. See [Model configuration](/guides/authoring-workflows/#model-configuration).
- **Branch on output.** Give a node an `output_format` and gate later nodes with `when:`. See [Authoring workflows](/guides/authoring-workflows/#when-condition-syntax).
- **Loop until done.** A `loop:` node repeats a step until a check passes. See [Loop nodes](/guides/loop-nodes/).
- **Ask for approval.** A `wait:` node pauses for your decision. See [Approval nodes](/guides/approval-nodes/).
- **Write better commands.** See [Authoring commands](/guides/authoring-commands/).
