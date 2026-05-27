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

A loop node's iteration prompt can live **inline** (`loop.prompt`) or in a
**command file** (`loop.command`, loaded from `.archon/commands/` the same way
[`command:` nodes](/guides/authoring-commands/) load their text). Provide
exactly one — both at once, or neither, is rejected at workflow load time.

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
    prompt: "..."           # Inline prompt. Exactly one of `prompt` or `command` is required.
    command: <name>         # Alternative to `prompt`: command name under .archon/commands/.
                            # Loaded once at node start; reused for every iteration.
    until: COMPLETE         # Required. Completion signal string.
    max_iterations: 10      # Required. Hard limit — node fails if exceeded.
    fresh_context: true     # Optional. Default: false.
    until_bash: "..."       # Optional. Bash script checked after each iteration.
    interactive: true       # Optional. Default: false. Pause after each non-completing
                            # iteration for user input via /workflow approve.
    gate_message: "..."     # Required when interactive: true. Message shown to the
                            # user at each pause with the run ID and approve command.
    signal_completes: true  # Optional. Default: false. Interactive loops only: a detected
                            # completion signal completes the node immediately (even on
                            # iteration 1) instead of gating for confirmation.
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

### `command`

Alternative to `prompt` — names a command file (under `.archon/commands/`)
whose body is loaded as the iteration prompt. **Exactly one of `prompt` or
`command` is required**; specifying both, or neither, is rejected at workflow
load time with a clear error.

The named command resolves with the same repo → home → bundled precedence as a
[`command:` node](/guides/authoring-commands/): `.archon/commands/<name>.md`
relative to the working directory first, then `~/.archon/commands/<name>.md`,
then the bundled defaults shipped with Archon. The same command-name safety
rules apply — no path separators, no `..`, no leading `.` — and unsafe names
are rejected at parse time. Static workflow validation also flags a
`loop.command` that points at a missing file (with "did you mean…" /
"create `.archon/commands/<name>.md`" guidance), the same way it does for
`command:` nodes.

The file is **read once when the loop node starts** and the loaded text is
reused for every iteration. Editing the file mid-run does not affect the
remaining iterations of that run. A missing, empty, or unreadable target
fails the node immediately with an actionable error — no iterations execute.

Once loaded, the text behaves identically to an inline `prompt`: all the
variable substitution above applies unchanged (including `$LOOP_PREV_OUTPUT`
and `$LOOP_USER_INPUT`), as do all the iteration semantics (`until`,
`until_bash`, `max_iterations`, `fresh_context`, `interactive` /
`gate_message`).

```yaml
- id: implement
  model: opus
  depends_on: [generate-prd]
  loop:
    command: archon-ralph-implement   # loads .archon/commands/archon-ralph-implement.md
    until: COMPLETE
    max_iterations: 15
    fresh_context: true
```

Use this when the iteration prompt is long enough that keeping it inline
obscures the shape of the pipeline — Ralph-style implement/build loops and
iterate-until-valid loops are the typical case. It is the loop-node parallel
of moving a `prompt:` node to a `command:` node.

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
values are shell-escaped when substituted into `until_bash`. The same
double-quoting footgun that applies to `bash:` nodes applies here — see
[Shell Quoting in `bash:` vs `script:`](/reference/variables#shell-quoting-in-bash-vs-script)
for the unquoted idiom to use.

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

In a continuous run, the first iteration sees `$LOOP_PREV_OUTPUT` substituted
to an empty string; iterations 2+ see the previous iteration's cleaned output
(after `<promise>` tags are stripped).

When a loop resumes from an interactive approval gate, the first executed
iteration after the resume also receives an empty `$LOOP_PREV_OUTPUT` even if
its numeric iteration is 2+ — the prior output lived in a different run and is
not carried across the gate.

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
- `provider` / `model` — node-level overrides are resolved and used for every iteration
- `$nodeId.output` — downstream nodes receive the last iteration's output

### `interactive` and `gate_message`

Set `interactive: true` to pause the loop between iterations and wait for human input.
After each iteration the executor:

1. Sends the gate message to the user along with the run ID and a `/workflow approve` command.
   The gate text is engine-generated: a status line — whether the iteration emitted the
   completion signal, plus a bounded excerpt of the iteration output — followed by your
   `gate_message`, so the gate always reports the real iteration outcome. The status line
   **leads the persisted gate message** (`metadata.approval.message`, also the
   `approval_requested` event data — what `workflow get --json` and `manage_run` read);
   the chat-delivered message wraps the same text in a `⏸ Input required (loop ..., iteration N):`
   prefix, so in chat the status line appears right after that prefix.
2. Pauses the workflow run
3. Waits — the workflow resumes when the user runs `/workflow approve <id> [feedback]`

The user's feedback is injected into the next iteration's prompt via `$LOOP_USER_INPUT`.

**Approve semantics (finalize vs iterate).** What an approve does depends on whether the
paused iteration emitted the completion signal:

- **Gate paused on a signal-bearing iteration** (the status line says "Completion signal
  detected"): `/workflow approve <id>` with **no feedback** *accepts the completion* — the
  node finalizes from the already-computed output and the workflow proceeds, with **no
  re-run**. Approving **with feedback** discards the signal and runs another iteration with
  your feedback as `$LOOP_USER_INPUT`.
- **Gate paused without the signal:** both forms run another iteration (there is nothing
  to finalize).

The same rule applies on every approve surface: chat `/workflow approve`, the CLI
(`archon workflow approve <id> [--json]` — omit the comment to finalize), the HTTP
endpoint (omit `comment`), the web console ("Accept & complete" with an empty comment
field), and the `manage_run` chat tool (no `message`, or `accept: true`).

> **Known limitation:** approving via a plain natural-language chat message (not the
> slash command) always counts as feedback and iterates. To finalize, use
> `/workflow approve <id>` with no comment, the CLI/web/`manage_run` surfaces above,
> or `signal_completes`.

### `signal_completes` — autonomous completion

By default an interactive loop **always gates first**, even when the very first iteration
emits the completion signal — the human confirms before the node completes. If you want
the signal itself to complete the node (no gate, no approve), set `signal_completes: true`:

```yaml
  - id: validate
    loop:
      prompt: |
        Run the validation suite. On PASS output <promise>VALIDATED</promise>.
        On failure, describe what failed and wait for instructions.
      until: VALIDATED
      max_iterations: 5
      interactive: true
      gate_message: Validation did not pass — review the failures above.
      signal_completes: true   # signal ⇒ node completes immediately, no gate
```

With `signal_completes: true` the gate only appears on iterations that did **not** signal —
the pattern for "pass through on success, pause for a human on failure". The flag has no
effect on non-interactive loops (the signal already completes them); setting it without
`interactive: true` emits a loader warning.

**AI approvers / relay steering.** An orchestrating agent can steer another run's gate:
read the structured gate state first (`archon workflow get <id> --json` →
`.metadata.approval.completionSignaled`, or the `manage_run` `get` action, which prints
`completionSignaled`, the iteration, and an output excerpt), then finalize with
`archon workflow approve <id> --json` (no comment) or `manage_run` approve with
`accept: true` — or iterate by passing feedback. The `--json` approve records the decision
without resuming; a later `resume` executes the finalize or the next iteration.

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

## Cross-Node Loops with `loop_group`

A `loop` node iterates a **single prompt**. A `loop_group` node iterates a
**multi-node sub-DAG** — a sealed body of nodes that re-runs in full each
iteration until a completion condition is met. Use it when "iterate until done"
needs a *pipeline* of steps (e.g. `implement → test → review`), not just one
repeated step.

```yaml
name: fix-until-green
description: Implement, test, and review until tests pass
nodes:
  - id: fix-loop
    loop_group:
      until: TESTS_PASS        # completion signal in the body's terminal output
      max_iterations: 5
      fresh_context: false      # false (default) = body AI sessions continue across iterations
      nodes:                    # sealed sub-DAG body — repeats as a unit
        - id: implement
          prompt: Fix the failing tests. Emit TESTS_PASS only when all pass.
          depends_on: []
        - id: test
          bash: bun test
          depends_on: [implement]
        - id: review
          prompt: Summarize the result; echo TESTS_PASS if tests are green.
          depends_on: [test]
```

### How it works

- From the **outer DAG's** perspective, `fix-loop` is one node. The cycle is
  *encapsulated* inside it — the outer DAG stays acyclic.
- Each iteration runs the body's topological layers in full (concurrent nodes
  within a layer run in parallel, same as a normal DAG).
- The body is **sealed**: a body node's `depends_on` may only reference sibling
  body nodes, not outer-DAG nodes. Outer context is still reachable via `$nodeId.output`
  refs in body prompts.
- Loop-control events (skip, trigger-rule, `when:` evaluations) are namespaced
  `{groupId}.{nodeId}` in the event log. Body node **lifecycle** events
  (`node_started`/`node_completed`/`node_failed`, tool events) currently use the
  raw body-node id — a known v1 limitation, so expect repeated step names across
  iterations in the event log.
- A body node that **fails** fails the whole group immediately with that node's
  error (no further iterations run) — same semantics as a failed node in a
  top-level DAG.
- `$fix-loop.output` (visible to the outer DAG) is the **final iteration's
  terminal-node output**.

### Cross-iteration references: `$LOOP_PREV`

A body node can reference a sibling's output from the **previous iteration**
with `$LOOP_PREV.<nodeId>.output` (and `$LOOP_PREV.<nodeId>.output.<field>`
for structured output):

```yaml
nodes:
  - id: fix-loop
    loop_group:
      until: TESTS_PASS
      max_iterations: 5
      nodes:
        - id: implement
          prompt: |
            Previous attempt's test output:
            $LOOP_PREV.test.output
            Fix what failed.
          depends_on: []
        - id: test
          bash: bun test
          depends_on: [implement]
```

On iteration 1 (no prior iteration), `$LOOP_PREV.*` resolves to an empty
string. Field access uses the same strict semantics as `$nodeId.output.field`
(a field not in the producer's declared schema fails the consuming node rather
than silently degrading).

### Configuration fields

`loop_group` shares the same iteration-control fields as `loop`:
[`until`](#until), [`max_iterations`](#max_iterations),
[`fresh_context`](#fresh_context), [`until_bash`](#until_bash),
[`interactive`](#interactive-and-gate_message), and `gate_message`. The
difference is the body: `loop` takes a single `prompt`; `loop_group` takes a
`nodes` array.

As with a `loop:` node (whose node-level `model`/`provider` are resolved and
applied to every iteration), `model` and `provider` set on a `loop_group` node
**are honored**: they become the default for every body AI node, overridable per
body node.

### Resume

Two distinct cases:

- **Interactive-gate resume** (`/workflow approve <id>`): the loop continues
  with the **next** iteration's whole body. With `fresh_context: false`, the
  body's AI session continues from where it paused (the session cursor is
  persisted across the gate). `$LOOP_PREV.*` refs, however, resolve to an empty
  string on the first resumed iteration — the prior iteration's body-output
  snapshot is **not** carried across the gate (same caveat as
  [`$LOOP_PREV_OUTPUT`](#retry-on-failure-with-loop_prev_output)).
- **Failure resume** (`/workflow resume <id>` after a crash/failure): there is
  no persisted iteration cursor — the loop_group node restarts from
  **iteration 1**. Per-body-node resume granularity is not supported in v1.

### What is NOT supported on loop_group nodes (v1)

- `retry` (the loop manages its own iteration) — rejected at parse time.
- `persist_session` for body AI nodes across iterations — body sessions reset
  per iteration (governed by `fresh_context`).
- Per-body-node resume (skip-to-failed-body-node) — the whole iteration re-runs.
- `$LOOP_PREV.<id>.output[N]` history indexing — only the immediately prior
  iteration is reachable.
- `$LOOP_PREV.*` across an interactive pause/resume boundary — resolves to an
  empty string on the resumed iteration.

Nested `loop_group` inside a `loop_group` body is supported by construction
(the body is a normal `nodes` array), but is not hardened in v1.

## See Also

- [Authoring Workflows](/guides/authoring-workflows/) — full workflow reference
- [Per-Node Hooks](/guides/hooks/) — SDK hooks for command/prompt nodes
- [Per-Node MCP Servers](/guides/mcp-servers/) — external tool integration
- [Per-Node Skills](/guides/skills/) — skill preloading
