---
title: Loop Nodes
description: Configure iterative AI execution nodes that repeat until a completion condition is met.
category: guides
area: workflows
audience: [user]
status: current
sidebar:
  order: 3
---

DAG workflow nodes support a `loop` field that runs an AI prompt repeatedly
until a completion condition is met. Each iteration is a full AI agent session
that can read files, write code, run commands, and produce output.

Use loop nodes for autonomous multi-step work: implement N stories from a PRD,
iterate on a design until validation passes, or refine output until quality
criteria are met.

## Quick Start

```yaml
name: iterate-until-done
description: Implement stories one at a time
nodes:
  - id: setup
    bash: |
      echo "Found 3 stories to implement"

  - id: implement
    depends_on: [setup]
    loop:
      prompt: |
        Read the PRD and implement the next unfinished story.
        Validate your changes before committing.

        Setup context: $setup.output
        User request: $USER_MESSAGE

        When all stories are done, output: <promise>COMPLETE</promise>
      until: COMPLETE
      max_iterations: 10
      fresh_context: true

  - id: report
    depends_on: [implement]
    prompt: |
      Summarize what was implemented: $implement.output
```

## How It Works

A loop node iterates its prompt until one of these conditions is met:

1. **LLM completion signal** — the AI outputs `<promise>SIGNAL</promise>` where
   SIGNAL matches the `until` value
2. **Deterministic bash check** — an `until_bash` script exits with code 0
3. **Max iterations reached** — the node fails with a clear error

Each iteration is a full AI agent invocation with tool access. Between iterations,
the executor checks for workflow cancellation.

## Configuration Fields

```yaml
- id: my-loop
  loop:
    prompt: "..."           # Required. The prompt sent each iteration.
    until: COMPLETE         # Required. Completion signal string.
    max_iterations: 10      # Required. Hard limit — node fails if exceeded.
    fresh_context: true     # Optional. Default: false.
    until_bash: "..."       # Optional. Bash script checked after each iteration.
    interactive: true       # Optional. Default: false. Pause after each non-completing
                            # iteration for user input via /workflow approve.
    gate_message: "..."     # Required when interactive: true. Message shown to the
                            # user at each pause with the run ID and approve command.
```

### `prompt`

The prompt text sent to the AI each iteration. Supports all standard variable
substitution:

| Variable | Value |
|----------|-------|
| `$ARGUMENTS` / `$USER_MESSAGE` | Original user message |
| `$ARTIFACTS_DIR` | Workflow artifacts directory |
| `$BASE_BRANCH` | Repository base branch |
| `$DOCS_DIR` | Documentation directory path (default: `docs/`) |
| `$WORKFLOW_ID` | Current workflow run ID |
| `$nodeId.output` | Output from upstream nodes |
| `$LOOP_USER_INPUT` | User feedback provided via `/workflow approve <id> <text>` at an interactive loop gate. Only populated on the first iteration of a resumed interactive loop; empty string on all other iterations. |
| `$LOOP_PREV_OUTPUT` | Cleaned output of the previous loop iteration. Empty string on the first iteration. Useful for `fresh_context: true` loops that need to reference what the previous pass produced or why it failed. |

`$USER_MESSAGE` is particularly important for `fresh_context: true` loops —
the agent has no memory of prior iterations, so the prompt must include all
context needed to continue the work. `$LOOP_PREV_OUTPUT` complements this by
exposing the previous iteration's own output without forcing the engine to
thread the session.

### `until`

The completion signal string. The executor checks each iteration's output for:

1. **Tag format (recommended):** `<promise>COMPLETE</promise>` — case-insensitive
   match (both tags and signal value), whitespace-tolerant. Prevents false
   positives from the AI mentioning the signal word in discussion.
2. **Plain signal (fallback):** The signal at the very end of output (trailing
   whitespace and punctuation tolerated) or on its own line. More prone to
   false positives — prefer the tag format.

The `<promise>` tags are automatically stripped from output sent to the user
and to downstream nodes.

### `max_iterations`

Hard safety limit. If the loop reaches this count without a completion signal,
the node **fails** (not succeeds). This prevents runaway loops from burning
tokens indefinitely.

Choose based on the work scope:
- Simple refinement loops: 3–5
- Multi-story implementation: 10–15
- Long-running autonomous agents: 15–20

### `fresh_context`

Controls session continuity between iterations:

| Value | Behavior | Use when |
|-------|----------|----------|
| `true` | Each iteration starts a fresh AI session. No memory of prior iterations. | Work state lives on disk (files, git). Prevents context window exhaustion on long loops. |
| `false` (default) | Sessions thread — each iteration resumes the prior conversation. | Iterative refinement where the agent needs to remember what it tried before. |

The first iteration is always fresh regardless of this setting.

### `until_bash`

Optional bash script executed after each iteration. If it exits with code 0,
the loop completes — even if the AI didn't output the completion signal.

```yaml
loop:
  prompt: "Fix the failing tests"
  until: ALL_PASS
  max_iterations: 5
  until_bash: "bun run test"  # Loop ends when tests pass
```

This is useful for deterministic completion criteria: test suites, lint checks,
build success. The bash script supports the same variable substitution as
`prompt` (`$ARTIFACTS_DIR`, `$nodeId.output`, etc.). Note: `$nodeId.output`
values are shell-escaped when substituted into `until_bash`.

## Patterns

### Stateless agent (Ralph pattern)

Each iteration reads state from disk, does one unit of work, writes state back.
The prompt tells the agent it has no memory and must bootstrap from files.

```yaml
- id: implement
  depends_on: [setup]
  idle_timeout: 600000
  loop:
    prompt: |
      You are in a FRESH session — no memory of previous iterations.
      Read the PRD tracking file to find the next unfinished story.
      Implement it, validate, commit, update tracking.
      When all stories are done: <promise>COMPLETE</promise>

      Project context: $setup.output
    until: COMPLETE
    max_iterations: 15
    fresh_context: true
```

**When to use:** Multi-story implementation, long-running tasks where context
window exhaustion is a risk. The agent reads `.archon/ralph/*/prd.json` or
similar tracking files to know what's done and what's next.

### Retry-on-failure with `$LOOP_PREV_OUTPUT`

When `fresh_context: true` is needed (to keep each iteration's context window
small) but the agent still benefits from knowing what the previous pass said —
typical of implement→validate or generate→review loops — inject the previous
iteration's output via `$LOOP_PREV_OUTPUT`:

```yaml
- id: implement-and-qa
  loop:
    prompt: |
      Implement the plan, then run `bun run validate`.
      If checks fail, fix the failures.

      Previous iteration output (empty on first pass):
      $LOOP_PREV_OUTPUT

      Use the above to focus your fixes. When all checks pass output:
      <promise>QA_PASS</promise>
    until: QA_PASS
    fresh_context: true
    max_iterations: 3
```

The first iteration sees `$LOOP_PREV_OUTPUT` substituted to an empty string;
iterations 2+ see the previous iteration's cleaned output (after `<promise>`
tags are stripped).

### Accumulating context

The agent builds on its own prior work across iterations. Good for iterative
refinement where remembering previous attempts matters.

```yaml
- id: refine
  loop:
    prompt: |
      Review the current implementation and improve it.
      Run validation after each change.
      When validation passes with zero issues: <promise>DONE</promise>
    until: DONE
    max_iterations: 5
    fresh_context: false
```

**When to use:** Fix-iterate cycles, design refinement, test-driven development
where the agent needs to remember what it already tried.

### Deterministic exit with `until_bash`

Combine LLM work with a deterministic completion check:

```yaml
- id: fix-tests
  loop:
    prompt: |
      Run the test suite. Read the failures. Fix them one at a time.
      If all tests pass: <promise>TESTS_PASS</promise>
    until: TESTS_PASS
    max_iterations: 8
    until_bash: "bun run test"
    fresh_context: false
```

The loop ends either when the AI signals completion or when the bash check
succeeds — whichever comes first. This prevents the AI from falsely claiming
completion when tests still fail.

## Node Features

### What works on loop nodes

- `depends_on` — upstream dependencies
- `when` — conditional execution
- `trigger_rule` — join semantics
- `idle_timeout` — per-iteration timeout (default: 30 minutes)
- `$nodeId.output` — downstream nodes receive the last iteration's output

### `interactive` and `gate_message`

Set `interactive: true` to pause the loop between iterations and wait for human input.
After each non-completing iteration the executor:

1. Sends the `gate_message` to the user along with the run ID and a `/workflow approve` command
2. Pauses the workflow run
3. Waits — the workflow resumes when the user runs `/workflow approve <id> <feedback>`

The user's feedback is injected into the next iteration's prompt via `$LOOP_USER_INPUT`.

> **Note**: Interactive loop nodes require `interactive: true` at the **workflow level** as
> well. If only the loop node has `interactive: true`, a loader warning is emitted and the
> workflow will not pause correctly in web background mode.

```yaml
name: guided-refine
description: Refine output with human review between iterations.
interactive: true            # Required at workflow level for interactive loops
nodes:
  - id: refine
    loop:
      prompt: |
        Review the current draft and improve it based on this feedback: $LOOP_USER_INPUT

        When the output is satisfactory, output: <promise>DONE</promise>
      until: DONE
      max_iterations: 5
      interactive: true
      gate_message: Review the output above. Reply with your feedback or type DONE to finish.
```

### What is NOT supported on loop nodes

- `retry` — rejected at parse time. The loader fails the workflow if `retry:` is set on a loop node.
- `context: fresh` — silently ignored. Session control is handled exclusively by `fresh_context` within the `loop:` config
- `hooks` — per-node SDK hooks are not passed through to loop iterations
- `mcp` — per-node MCP server configs are not loaded for loop nodes
- `skills` — skill preloading is not applied to loop iterations
- `allowed_tools` / `denied_tools` — tool restrictions are not enforced on loop iterations
- `output_format` — structured JSON output is not supported for loop nodes
- `provider` / `model` — accepted in YAML without error but silently ignored at runtime. Loop nodes always use the workflow-level provider and model.

These fields (except `retry`) are silently discarded at parse time with a
loader warning — the workflow still loads but the fields have no effect.
`retry` is the exception: it causes a hard load error.

The loop executor manages its own AI sessions independently from the standard
node executor. If you need hooks, MCP, skills, or tool restrictions, consider
using a command node that wraps the iterative logic in a command file.

## Output

A loop node's output (available via `$nodeId.output` to downstream nodes) is
the **last iteration's output only** — not a concatenation of all iterations.

If you need to accumulate results across iterations, write them to files in
`$ARTIFACTS_DIR` and have the downstream node read from there.

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Iteration throws an error | Node fails immediately (no more iterations) |
| Max iterations exceeded | Node fails with descriptive error |
| Workflow cancelled | Detected between iterations, node stops |
| Idle timeout per iteration | Iteration completes with whatever output was collected; loop continues to next iteration |
| `retry` configured on node | Rejected at parse time — workflow fails to load |

## See Also

- [Authoring Workflows](/guides/authoring-workflows/) — full workflow reference
- [Per-Node Hooks](/guides/hooks/) — SDK hooks for command/prompt nodes
- [Per-Node MCP Servers](/guides/mcp-servers/) — external tool integration
- [Per-Node Skills](/guides/skills/) — skill preloading
