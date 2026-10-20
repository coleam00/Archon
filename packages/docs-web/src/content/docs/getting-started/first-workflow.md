---
title: Build your first workflow
description: Build a workflow that plans a change, waits for your approval, implements it and fixes failing tests, and check every route before it spends a token.
category: getting-started
audience: [user]
sidebar:
  order: 3
---

In this tutorial you build `build-change`, a workflow that takes a brief for a small change to your repository and:

1. plans the change and saves the plan as an artifact;
2. pauses until you approve the plan, or cancels if you reject it;
3. implements the approved plan;
4. runs your tests in a fresh agent session;
5. fixes the code if the tests fail.

Before you run it, you check it three ways that cost nothing: `archon validate workflows`, a dry run with stub outputs, and fixtures that `archon workflow test` replays on every change.

You need Archon installed and a provider added; see the [Quickstart](/getting-started/quick-start/). Work in a git repository that has a test command.

## Lay out the workflow folder

A workflow lives in its own folder under `.archon/workflows/<pack>/<workflow>/`, with the commands and fixtures it uses beside it. Create this layout in your repository:

```text
.archon/workflows/my-team/build-change/
├── build-change.yaml
├── commands/
│   └── run-tests.md
└── fixtures/
```

`my-team` is the pack name; choose your own. A command or script that `build-change.yaml` names resolves only from its own `commands/` and `scripts/` folders, so two workflows can each have a `run-tests.md` without colliding.

## Write a command

A command is a markdown file of instructions for an agent. Use one when the instructions are long or shared by several nodes. Create `commands/run-tests.md`:

```markdown
---
description: Run the project's tests and report whether they pass
---

# Run tests

Run this project's test suite. Find the test command in the project's own
files, for example `package.json`, `Makefile` or `pyproject.toml`. If you
cannot find one, report `passed: false` and say where you looked.

Do not fix anything. Report what you saw:

- `passed`: true only if every test passed
- `failures`: each failing test with its error message, or an empty string
```

## Write the workflow

Create `build-change.yaml`:

```yaml
name: build-change
description: |
  Plan a change from a brief, wait for you to approve the plan, implement it,
  then run the tests in a fresh session and fix what fails.
  Use when: you have a small, well-described change for this repository.

nodes:
  - id: plan
    prompt: |
      Read the brief below and the code it touches. Write an implementation
      plan to $ARTIFACTS_DIR/plan.md: the files you will change, the approach,
      and how you will know it works. Do not change any files yet.

      Brief:
      $ARGUMENTS
    output_format:
      type: object
      properties:
        summary: { type: string }
      required: [summary]
      additionalProperties: false

  - id: approve-plan
    depends_on: [plan]
    wait:
      attention: |
        $plan.output.summary

        Read the full plan with `archon workflow artifacts <run-id> plan.md`.
        Approve to implement it, or reject with what to change.
      form: approval

  - id: stop
    depends_on: [approve-plan]
    when: "$approve-plan.output.decision == 'reject'"
    cancel: The plan was rejected.

  - id: implement
    depends_on: [approve-plan]
    when: "$approve-plan.output.decision == 'approve'"
    prompt: |
      Implement the plan in $ARTIFACTS_DIR/plan.md. Reviewer notes, if any:
      $approve-plan.output.text
      Commit your changes with a clear message.

  - id: check
    depends_on: [implement]
    command: run-tests
    context: fresh
    output_format:
      type: object
      properties:
        passed: { type: boolean }
        failures: { type: string }
      required: [passed, failures]
      additionalProperties: false

  - id: fix
    depends_on: [check]
    when: "$check.output.passed == false"
    context: fresh
    prompt: |
      These tests fail after implementing $ARTIFACTS_DIR/plan.md:
      $check.output.failures
      Fix the cause, run the tests again, and commit the fix.
```

Each node does one kind of work:

- **`plan`** is an agent node. `$ARGUMENTS` is the brief you pass to the run, and `$ARTIFACTS_DIR` is a directory Archon creates for each run, outside your repository. `output_format` makes the agent return JSON matching the schema, so later nodes can read `$plan.output.summary` as a field. The node fails if the agent returns anything else.
- **`approve-plan`** is the gate. A `wait:` node with `attention:` pauses the run until someone answers it, and `form: approval` means the answer is `approve` or `reject` plus optional text. A paused run holds no process; answer it minutes or days later. Pause only where a person should decide. A check that code or another agent can make belongs in a node.
- **`stop`** cancels the run when you reject. A rejection is an answer, not a cancellation, so the workflow decides what happens next.
- **`implement`** runs only after an approval. `$approve-plan.output.text` passes on any notes you gave with the answer.
- **`check`** loads `commands/run-tests.md`. `context: fresh` starts a new agent session, so the agent reads the real test results instead of trusting what the implementer believed it wrote. Use it before any node whose job is to verify.
- **`fix`** runs only when `check` reports a failure.

Nodes without a dependency between them run at the same time. Here every node depends on the one before it, so they run in order.

## Validate it

```bash
archon validate workflows build-change
```

```text
  build-change                             ok

Results: 1 valid, 0 with errors
```

Validation loads the workflow the way a run would. It reports a misspelt key, a `when:` that references a field the producer never declares, a command file that does not exist, and a key that the node's type cannot use. For example, `timeout:` on a prompt node fails:

```text
ERROR [validation_error] DAG node validation failed: Node 'plan': 'timeout' 'timeout' is only supported on bash, loop, loop_group or script nodes, not on prompt node 'plan'.
```

## Dry-run it with stubs

A dry run walks the graph with outputs you supply instead of calling a model. It never creates a run, so it is free. Generate a stub file that has one entry per node that needs one:

```bash
archon workflow run build-change --dry-run --stubs-init stubs.yaml
```

Edit the values to describe the route you want to see. This one simulates failing tests:

```yaml
plan: { summary: "Add a --version flag that prints the version from package.json." }
implement: "Added the flag and a test."
check: { passed: false, failures: "version.test.ts: expected 1.2.0, got undefined" }
fix: "Read the version from package.json at startup."
```

Run the simulation:

```bash
archon workflow run build-change --dry-run --stubs stubs.yaml "Add a --version flag"
```

```text
STUBBED   plan (prompt)
PAUSED    approve-plan (wait) — durable wait
Simulation outcome: paused
```

The simulation stops at the gate, as a real run would. A stub for the wait node stands in for your answer. Add one and run it again:

```yaml
approve-plan: { decision: approve, text: "" }
```

```text
STUBBED   plan (prompt)
STUBBED   approve-plan (wait) — answered by stub
SKIPPED   stop (cancel) — when_condition_false
STUBBED   implement (prompt)
STUBBED   check (command)
STUBBED   fix (prompt)
Simulation outcome: completed
```

The trace also prints each agent node's resolved prompt and the provider and model it will run on. A dry run checks the wiring: routing, gates, `when:` conditions and variable substitution. It does not check what the model will write.

## Keep the routes as fixtures

A fixture is a stub file with an expected result, saved in the workflow's `fixtures/` folder. `archon workflow test` replays every fixture, so a later edit that breaks a route fails the test. Add one fixture per route.

`fixtures/approved.stubs.yaml`: the tests pass, so `fix` must not run.

```yaml
plan: { summary: "Add a --version flag that prints package.json's version." }
approve-plan: { decision: approve, text: "" }
implement: "Added the flag and a test."
check: { passed: true, failures: "" }
fixture:
  expect: completed
  reached: [implement, check]
```

`fixtures/red.stubs.yaml`: the tests fail, so `fix` runs and receives the failures.

```yaml
plan: { summary: "Add a --version flag that prints package.json's version." }
approve-plan: { decision: approve, text: "" }
implement: "Added the flag."
check: { passed: false, failures: "version.test.ts: expected 1.2.0, got undefined" }
fix: "Read the version from package.json at startup."
fixture:
  expect: completed
  reached: [fix]
  resolved-text-contains:
    fix: "expected 1.2.0, got undefined"
```

`fixtures/rejected.stubs.yaml`: you reject the plan, so the run is cancelled before any code changes.

```yaml
plan: { summary: "Rewrite the CLI parser." }
approve-plan: { decision: reject, text: "Too broad. Only add the flag." }
fixture:
  expect: cancelled
  reached: [stop]
```

The `fixture:` block holds the expectations. `expect` is the simulation outcome: `completed`, `failed`, `paused` or `cancelled`. `reached` lists nodes that must run. `resolved-text-contains` checks that a node's prompt received a value. A node the route reaches without a stub fails the fixture, so leaving out the stub for `fix` in `approved` is what proves `fix` stays skipped.

```bash
archon workflow test build-change
```

```text
✔ my-team/build-change/fixtures/approved.stubs.yaml → build-change
    Simulation outcome: completed
✔ my-team/build-change/fixtures/red.stubs.yaml → build-change
    Simulation outcome: completed
✔ my-team/build-change/fixtures/rejected.stubs.yaml → build-change
    Simulation outcome: cancelled

3 passed, 0 failed
```

`workflow test` never creates a run or calls a provider. Run it after every edit to the workflow, and in CI.

## Run it with a real brief

The brief is the input the whole run is measured against. A vague brief gets a confident plan for a change you didn't want. State the problem, why it matters, the outcome you want, what must not change, and how you will know it is done; see [The input is the contract](/getting-started/quick-start/#the-input-is-the-contract).

```bash
archon workflow run build-change --branch feat/version-flag "$(cat <<'BRIEF'
Problem: the CLI has no way to print its version, so bug reports never say
which release they were filed against.

Outcome: `mycli --version` prints the version from package.json and exits 0.

Invariants: no new dependency; every other flag behaves as before.

Acceptance: a test runs `mycli --version` and checks the output.
BRIEF
)"
```

The run works in its own git worktree on the branch `feat/version-flag`, so its edits stay out of your checkout. After `plan` finishes, the command prints `Workflow paused — waiting for approval.` and returns. Read the plan and answer:

```bash
archon workflow attention                       # paused runs that need you, with their IDs
archon workflow artifacts <run-id> plan.md      # print the plan
archon workflow approve <run-id> "Keep the flag handling in cli.ts"
```

Approving continues the run in your terminal until it finishes. To stop it instead, run `archon workflow reject <run-id> "Too broad"`. The answer's text reaches the next node as `$approve-plan.output.text`. Afterwards, `archon workflow get <run-id>` shows each node's status, and the commits are on `feat/version-flag`.

## Where to go next

- **Every field and node type:** [Workflow language](/reference/workflow-language/).
- **Repeat work until a check passes:** [Loop nodes](/guides/loop-nodes/).
- **Compute instead of asking an agent:** [Script nodes](/guides/script-nodes/).
- **Start a workflow from an event, such as a new issue:** [Proactive workflows](/guides/proactive-workflows/).
- **Write better commands:** [Authoring commands](/guides/authoring-commands/).
- **A full delivery pipeline to copy from:** the bundled `sdlc` pack; see [SDLC workflows](/reference/sdlc-workflows/).
