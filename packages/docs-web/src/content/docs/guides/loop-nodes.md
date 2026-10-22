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
**command file** (`loop.command`, resolved the same way
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
3. **Structured field** — the iteration's validated `output_format` payload has the
   `until_field` property set to `true`
4. **Max iterations reached** — the node fails with a clear error

A loop must declare **at least one** of `until` / `until_bash` / `until_field` — none
is required on its own. They are OR'd: whichever fires first ends the loop, and the
cheap channels are checked before `until_bash`, which is skipped once another one
fired (it cannot change the outcome, and skipping it avoids an extra run of a
side-effecting script).

Each iteration is a full AI agent invocation with tool access. Between iterations,
the executor checks for workflow cancellation.

### Choosing a completion channel

| Your completion condition | Declare |
|---|---|
| Externally checkable — tests pass, a file exists, a state field flipped | `until_bash` **only**. No prose is matched, so a sentinel the model happens to emit while reasoning about the criteria cannot end the loop early. |
| A judgment the model makes, with no answer asked for | `output_format` + `until_field`. The decision becomes a schema-validated boolean instead of a string match — the model cannot end the loop by mentioning a word. |
| An answer the run asks for between iterations | A `loop_group` whose body ends in a `wait: attention` node, with `until_bash` reading the answer. See [Pausing to ask inside the body](#pausing-to-ask-inside-the-body). |

Declaring more than one is fine and means "whichever fires first ends it".

## Configuration Fields

```yaml
- id: my-loop
  loop:
    prompt: "..."           # Inline prompt. Exactly one of `prompt` or `command` is required.
    # command: <name>       # Alternative to `prompt`: package-local or shared command name,
    #                       # loaded once per run and reused for every iteration.
    #                       # Never combine with `prompt` — the loader rejects both together.
    until: COMPLETE         # Prose completion signal.
    max_iterations: 10      # Required. Bounds autonomous iterations — node fails if exceeded.
    fresh_context: true     # Optional. Default: false.
    until_bash: "..."       # Bash script checked after each iteration; exit 0 = complete.
    until_field: done       # Property in this node's `output_format` whose validated
                            # value `true` ends the loop.
                            #
                            # At least ONE completion channel is required — any of
                            # until / until_bash / until_field. None is required alone.
```

`interactive`, `gate_message`, and `signal_completes` still load but are deprecated;
see [Legacy interactive loops](#legacy-interactive-loops-deprecated).

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
| `$LOOP_USER_INPUT` | Deprecated. The approve comment from a [legacy interactive loop](#legacy-interactive-loops-deprecated) gate, on the first iteration after the resume only. In a `loop_group`, read the answer to a terminal attention wait as `$LOOP_PREV.<wait-id>.output.text` instead. |
| `$LOOP_PREV_OUTPUT` | Cleaned output of the previous loop iteration. Empty string on the first iteration. Useful for `fresh_context: true` loops that need to reference what the previous pass produced or why it failed. |

`$USER_MESSAGE` is particularly important for `fresh_context: true` loops —
the agent has no memory of prior iterations, so the prompt must include all
context needed to continue the work. `$LOOP_PREV_OUTPUT` complements this by
exposing the previous iteration's own output without forcing the engine to
thread the session.

### `command`

Alternative to `prompt` — names a command file
whose body is loaded as the iteration prompt. **Exactly one of `prompt` or
`command` is required**; specifying both, or neither, is rejected at workflow
load time with a clear error.

The named command resolves exactly like a [`command:` node](/guides/authoring-commands/).
In a packaged workflow it resolves only from that workflow's `commands/`
directory, including after `include:` expansion. In a legacy workflow it uses
repo → home → bundled precedence. The same command-name safety
rules apply — no path separators, no `..`, no leading `.` — and unsafe names
are rejected at parse time. Static workflow validation also flags a
`loop.command` that points at a missing file, with guidance to create it in the
owning workflow's `commands/` directory for packaged workflows or in
`.archon/commands/` for legacy workflows, the same way it does for `command:`
nodes.

For an ordinary workflow, the file is **read once per run** when the loop node
starts. For a workflow composed through `include:`, Archon resolves and compiles
the command body during load-time composition so its node references and declared
inputs are proven before the child joins the parent's flat DAG. A matching file
that is unreadable fails closed; Archon never falls through to a lower-precedence
command with the same name. A missing, empty, or non-hermetic included command fails before a fresh AI turn.
If an admitted run cannot read its captured command on this host, Archon pauses
it for source continuation; a later host that can read the capture can resume it.

Once loaded, the text behaves identically to an inline `prompt`: all the
variable substitution above applies unchanged (including `$LOOP_PREV_OUTPUT`),
as do all the iteration semantics (`until`, `until_bash`, `max_iterations`,
`fresh_context`).

```yaml
- id: implement
  model: opus
  depends_on: [generate-prd]
  loop:
    command: archon-ralph-implement   # resolved repo → home → bundled (see precedence above)
    until: COMPLETE
    max_iterations: 15
    fresh_context: true
```

Use this when the iteration prompt is long enough that keeping it inline
obscures the shape of the pipeline — Ralph-style implement/build loops and
iterate-until-valid loops are the typical case. It is the loop-node parallel
of moving a `prompt:` node to a `command:` node.

### `until`

Deprecated prose completion signal. Prefer `until_bash` for deterministic checks or
`until_field` for model judgment. While `until` remains supported, the executor checks
each iteration's output for:

1. **Tag format (recommended):** `<promise>COMPLETE</promise>` — case-insensitive
   match (both tags and signal value), whitespace-tolerant. Prevents false
   positives from the AI mentioning the signal word in discussion.
2. **Plain signal (fallback):** A final line containing only `COMPLETE`, with
   surrounding line whitespace allowed. Inline mentions, including a final sentence
   ending in `COMPLETE`, do not complete the loop.

The `<promise>` tags are automatically stripped from output sent to the user
and to downstream nodes.

**Optional, like every completion channel.** Omit `until` entirely whenever another
channel decides completion — the executor then never matches prose at all, so the
signal cannot false-positive on a model that mentions its own exit criterion. What
the loader requires is that *at least one* channel is declared; a loop with none is
rejected at load.

### `max_iterations`

Bounds autonomous iterations. If the loop reaches this count without meeting any
declared completion channel, the node **fails** (not succeeds). This prevents runaway
loops from burning tokens indefinitely.

Only an explicit answer runs an iteration past the bound: a comment on a legacy
[interactive gate](#interactive-and-gate_message), or an accepted answer to a `loop_group`'s
[terminal attention wait](#pausing-to-ask-inside-the-body).
Each accepted answer permits one more iteration, and each further iteration needs
another accepted answer. A changed question can pause again in the same iteration.

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

A structured-output re-ask (see [`until_field`](#until_field)) does **not** disturb
threading. It runs in its own throwaway session so an invalid turn is not carried
forward as context, and that session is discarded — the next iteration still resumes
the conversation the loop was already threading. The repaired answer still reaches it
through `$LOOP_PREV_OUTPUT`.

### `until_bash`

Bash script executed after each iteration. If it exits with code 0, the loop
completes — even if the AI didn't output the completion signal. Optional when
`until` is set; **on its own it is the whole completion channel**, which is the
preferred shape whenever the condition is externally checkable:

```yaml
loop:
  prompt: "Fix the failing tests"
  max_iterations: 5
  until_bash: "bun run test"  # Loop ends when tests pass. No `until:` — nothing to
                              # false-positive on, and no dead field to invent.
```

`until_bash` runs only on iterations that no other completion channel already
ended, so a loop declaring more than one never pays for a redundant check.

The check uses the node's `timeout`: a positive, finite number of milliseconds,
with no limit when omitted. This applies to `loop:` and `loop_group:`, including the
completion recheck after a group continues past a terminal pause. It limits each check,
not the AI iteration or the group's body nodes. To bound a check, declare the budget on
the node:

```yaml
- id: fix-tests
  timeout: 900000             # The suite takes ~4 min; a hung check fails after 15 min.
  loop:
    prompt: "Fix the failing tests"
    max_iterations: 5
    until_bash: "bun run test"
```

:::caution[If your `until_bash` accumulates state]
The skip means the script does not run on an iteration another channel already
completed, so a check that *mutates* state each time it runs — a counter, an append,
a cursor — advances once fewer than it would have. The completion verdict is unaffected either way (the
channels are OR'd), and the loop ends on that same iteration, so
nothing observable differs. A [legacy interactive loop](#legacy-interactive-loops-deprecated)
is the exception: it can gate on a completed iteration and run another one when
approved with text, and that iteration's `until_bash` then sees state one increment behind.

Prefer a `until_bash` that only *reads* state — `test`, `grep`, a test suite — and
let a `bash:` node inside the loop own any mutation.
:::

This is useful for deterministic completion criteria: test suites, lint checks,
build success. The bash script supports the workflow variables and node output
references `prompt` does (`$ARTIFACTS_DIR`, `$nodeId.output`, etc.), but it reads a
declared input from the environment as `$INPUTS_<UPPER_SNAKE>`, not as `$INPUTS.<name>`.
Inside an included block `$INPUTS.<name>` is shorthand for that variable; a directly run
workflow leaves it literal (see
[Passing values into an included block](/reference/workflow-language/#passing-values-into-an-included-block)).
In `until_bash`, small output references are single-quoted inline; large outputs use
an unquoted file-read substitution. Assign each reference to a variable, then quote
that variable when using it. See the
[assignment-then-quote examples](/reference/variables#shell-quoting-in-bash-vs-script).

### `until_field`

Names a property in this node's [`output_format`](/reference/workflow-language/) schema.
The loop ends on the first iteration whose **validated** payload has that property
set to exactly `true`.

```yaml
- id: triage
  output_format:
    type: object
    properties:
      done: { type: boolean }
      remaining: { type: integer }
    required: [done]
  loop:
    prompt: |
      Work the next item in the backlog. Report whether the backlog is now empty.
    max_iterations: 20
    until_field: done
```

Use this when completion is a **judgment the model makes** and there is nothing on
disk to test. It replaces a prose sentinel with a schema-validated boolean, so the
model cannot end the loop by mentioning a word while reasoning about its criteria.

Four rules are checked at load time, so a mistake fails the workflow rather than
looping silently:

1. the node must declare `output_format`;
2. the property must appear in `output_format.properties`;
3. it must be listed in `output_format.required` — an optional property the model
   omits would read as "not complete" and burn `max_iterations`;
4. if it declares a `type`, that type must be `boolean`.

Termination is strict identity: `true` ends the loop, and nothing else does — not
`"true"`, not `1`. A payload that fails schema validation is a failure, not a
quiet "not done yet" (see below).

**The loop's output becomes the validated JSON.** With `output_format` declared,
`$loopId.output` is the payload rather than the prose, `$loopId.output.<field>` gets
the same strict field access every other producer enforces, and `$LOOP_PREV_OUTPUT`
carries the same value.

**Per-provider behavior is the same as any other node.** On a provider with
*enforced* structured output (Claude, Codex, OpenCode) the schema constrains
decoding. On a *best-effort* provider the model is asked for the schema (Pi through
a `structured_output` tool call, Copilot through the prompt), and a payload that fails
validation is re-asked up to three times **within the same iteration** — a reask does not consume a loop iteration. If those are
exhausted, the node **fails** with the validation errors; it is never treated as an
incomplete iteration. See
[provider capabilities](/reference/provider-capabilities/).

`until_field` is **not supported on `loop_group`**, and deliberately so: a group's
body node can already declare `output_format` and be read by a deterministic check,
which is the existing way to express the same thing.

```yaml
# loop_group equivalent — no new field needed
loop_group:
  max_iterations: 10
  until_bash: '[ $decide.output.done = "true" ]'
  nodes:
    - id: decide
      output_format:
        type: object
        properties: { done: { type: boolean } }
        required: [done]
      prompt: Is the backlog empty?
```

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
succeeds — whichever comes first.

**No channel vetoes another.** They are OR'd, so an AI that emits `TESTS_PASS`
while tests still fail ends the loop anyway — the bash check never gets to disagree. If the tests
are the real exit criterion, say so by dropping `until` and the sentence that
teaches the model to emit it:

```yaml
- id: fix-tests
  loop:
    prompt: Run the test suite. Read the failures. Fix them one at a time.
    max_iterations: 8
    until_bash: "bun run test"
    fresh_context: false
```

Now the only way out is a passing suite.

## Node Features

### What works on loop nodes

- `depends_on` — upstream dependencies
- `when` — conditional execution
- `trigger_rule` — join semantics
- `idle_timeout` — per-iteration timeout (default: 30 minutes)
- `provider` / `model` — node-level overrides are resolved and used for every iteration
- `allowed_tools` / `denied_tools` — passed to the selected provider on every iteration,
  just as on a `prompt:` node. Enforcement depends on the provider's tool-restriction
  support; Archon warns when the provider declares that it cannot enforce them
- `$nodeId.output` — downstream nodes receive the last iteration's output

### Asking for an answer between iterations

Apart from the deprecated `interactive` mode, a `loop:` node does not pause. To ask a
question after each pass and feed the answer into the next one, use a [`loop_group`](#cross-node-loops-with-loop_group) whose body
ends in a `wait: attention` node. See
[Pausing to ask inside the body](#pausing-to-ask-inside-the-body).

### What is NOT supported on loop nodes

- `context: fresh` — ignored. Session control is handled exclusively by `fresh_context` within the `loop:` config
- `hooks` — per-node SDK hooks are not passed through to loop iterations
- `mcp` — per-node MCP server configs are not loaded for loop nodes
- `skills` — skill preloading is not applied to loop iterations

These fields are discarded at parse time — the workflow still
loads but the fields have no effect. The drop is reported as a warning naming the
node and the fields, both in the loader log and in the author-facing output of
`archon validate workflows` and `archon workflow list`.

The loop executor manages its own AI sessions independently from the standard
node executor. If you need hooks, MCP, or skills, consider using a command node
that wraps the iterative logic in a command file.

## Output

A loop node's output (available via `$nodeId.output` to downstream nodes) is
the **last iteration's output only** — not a concatenation of all iterations.

If you need to accumulate results across iterations, write them to files in
`$ARTIFACTS_DIR` and have the downstream node read from there.

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Iteration fails | A transient, rate-limited or capacity (`overloaded`) failure retries the iteration. Any other failure fails the node (no more iterations) |
| Max iterations exceeded | Node fails with descriptive error |
| Workflow cancelled | Detected between iterations, node stops |
| Idle timeout per iteration | The iteration is retried as a transient failure, whether or not its provider produced output first |
| `retry` configured on node | Applies to each failed iteration; successful iterations are not replayed |

By default, each iteration gets two retries after its initial attempt, with a 3000 ms base delay that doubles on each ordinary transient retry. Configure the existing node-level `retry:` block to change the budget and base delay:

```yaml
nodes:
  - id: work
    retry:
      max_attempts: 1
      delay_ms: 0
    loop:
      prompt: "Complete the task and output <promise>DONE</promise>"
      until: DONE
      max_iterations: 5
```

`max_attempts` is required when declaring `retry:` and accepts integers 1–5, counting retries after the initial attempt. `delay_ms` accepts 0–60000 on loops and defaults to 3000 when omitted. Zero skips ordinary transient retry waits. The budget resets for each iteration; retries do not consume `max_iterations`.

Only `on_error: transient` or omission is supported on loops; `all` is a load error. Unknown, fatal and output-contract failures are not retried by this policy. Structured-output reasks have their own separate budget.

Rate limits and capacity retain the shared AI-node exceptions: at least five retries, regardless of `max_attempts`. Rate limits wait around 45 seconds with ±50% jitter and keep the larger budget for the rest of the iteration. Capacity waits use centers of 45, 90, 180, 300 and 300 seconds with ±50% jitter; its larger budget applies only while the current failure is capacity. `delay_ms: 0` does not bypass either schedule. See [Retry Configuration](/reference/workflow-language/#retry-configuration).

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
          bash: |
            if bun test; then
              printf 'green'
            else
              printf 'red'
            fi
          depends_on: [implement]
        - id: review
          prompt: Summarize the result; echo TESTS_PASS if tests are green.
          depends_on: [test]
```

The legacy prose `until:` channel cannot detect a signal when the node the
group's output is read from (see below) produces non-string structured output. The
loader rejects that combination when `until:` is the only completion channel, for
every node the output can be read from. Use `until_bash` to read that node's
structured field instead. Nodes without `output_format`, or with a string schema,
keep loading. Declaring `until_bash`
alongside `until:` also keeps loading, with the existing prose-channel deprecation
warning.

### How it works

- From the **outer DAG's** perspective, `fix-loop` is one node. The cycle is
  *encapsulated* inside it — the outer DAG stays acyclic.
- Each iteration runs the body's topological layers in full. Within a layer,
  ordinary nodes settle before nodes that can suspend, including nested groups
  containing interactions. Nodes within each phase can run in parallel. Before an
  interaction pauses the run, sibling work must either finish or reach its own
  interaction, including work inside nested groups. Any failure skips those
  interactions.
- The body is **sealed**: a body node's `depends_on` may only reference sibling
  body nodes, not outer-DAG nodes. Outer context is still reachable via `$nodeId.output`
  refs in body prompts.
- Loop-control and body lifecycle events use the namespaced step name
  `{groupId}.{nodeId}` in the persisted event log, with the iteration recorded in
  event data. Nested groups compose the prefix.
- A body node that **fails** fails the whole group immediately with that node's
  error (no further iterations run) — same semantics as a failed node in a
  top-level DAG. Runnable cleanup still runs, including independent branches inside
  nested groups. After a body failure, gates, waits, and interactive loops are
  skipped, even with `trigger_rule: all_done`. Nested groups containing interactions
  run their body once, then skip their interaction and further iterations. This applies at any depth
  and preserves the original failure without creating an attention item.
- `$fix-loop.output` (visible to the outer DAG) is the **final iteration's
  output**: the first completed, non-empty output among the body's terminal nodes,
  in body order. A terminal pause is read past, as described next.

### Pausing to ask inside the body

To ask for an answer after each pass, end the body in a
[`wait: attention`](/reference/workflow-language/#attention-waits) node. The run pauses
there until someone answers. On resume with the first answer, the engine compares the
current message, form, and options against the paused question. If they changed, it
discards the stale answer and asks again in the same iteration. This re-ask happens
at most once per occurrence chain: the next answer is accepted even if the question
changes again. See [attention waits](/reference/workflow-language/#attention-waits).
Once an answer is accepted, the group checks `until_bash`; if it does not pass,
the next iteration runs with the answer available as `$LOOP_PREV.<wait-id>.output`.

```yaml
- id: refine
  loop_group:
    max_iterations: 5
    until_bash: 'decision=$review.output.decision; [ "$decision" = approve ]'
    nodes:
      - id: draft
        prompt: |
          Write the release notes for this change: $USER_MESSAGE
          Feedback on the previous draft (empty on the first pass):
          $LOOP_PREV.review.output.text
      - id: review
        depends_on: [draft]
        wait:
          attention: "Approve these release notes, or reject with what to change: $draft.output"
          form: approval
```

- Once an answer is accepted, `until_bash` reads it as
  `$review.output.decision`. Approving ends the group;
  rejecting runs another draft, which reads any text sent with the answer through
  `$LOOP_PREV.review.output.text`. A reject is an answer, so it never cancels the run.
- Assign the reference, then quote the shell variable, as above. Archon already
  single-quotes a substituted value, so `"$review.output.decision"` compares
  `'approve'` with the quotes included and never matches. See
  [Shell Quoting in `bash:` vs `script:`](/reference/variables#shell-quoting-in-bash-vs-script).
- `$group.output` is the draft, not the answer (see below).
- Any [form](/reference/workflow-language/#attention-waits) works. A `message` wait
  produces only `{ text }`, so with it decide completion from the work instead of the answer.
- `max_iterations` bounds autonomous iterations. Each accepted answer to the terminal
  attention wait permits one more iteration even past that bound, so this loop runs
  until someone approves.
- The loader warns when the terminal attention wait has no `when:` and `until_bash`
  does not reference its `$<wait-id>.output`: the answers would be recorded but never
  end the loop.

A wait pauses the group only as the body's **sole terminal sink**: nothing depends on
it, and every other body node leads to it. Any other placement is a load error, because
resuming in the middle of an iteration would replay or skip sibling work. The group
compares the question on the first answer, with the one-reask bound described above.
If it asks again, the iteration stays paused; otherwise, if `until_bash` does not
pass, the next iteration
starts with the accepted answer available. A deprecated `approval:` gate is accepted
in the same place; see
[Migrating from approval gates](/guides/approval-nodes/#migrating-from-approval-gates).

A pause asks about the work; it is not the work. When the sink is an attention wait,
the iteration's output is read from the nodes the wait depends on, so `$group.output`
is the same whether the wait was skipped by its `when:` or answered. The answer stays
on the wait node: `until_bash` reads it as `$<wait-id>.output`, and the next iteration
reads it as `$LOOP_PREV.<wait-id>.output`. A skipped wait has no output, so an
`until_bash` that reads a wait its own `when:` can skip fails the group. To pause only
when needed, decide completion from the work instead:

```yaml
- id: plan
  loop_group:
    until_bash: 'blocked=$draft.output.blocked; [ "$blocked" = false ]'
    max_iterations: 5
    nodes:
      - id: draft
        prompt: |
          Draft the plan. Answer to your last question, if any: $LOOP_PREV.plan-question.output.text
          Set blocked to true only if you need an answer before you can continue.
        output_format:
          type: object
          properties:
            plan: { type: string }
            blocked: { type: boolean }
          required: [plan, blocked]
      - id: plan-question
        depends_on: [draft]
        when: "$draft.output.blocked == 'true'"
        wait:
          attention: "The draft needs a decision: $draft.output.plan"
```

When the draft is not blocked, the wait is skipped and the group completes. When it is
blocked, the answer reaches the next draft through `$LOOP_PREV`.
`$plan.output` is the latest draft either way.

### Reusing a block in the body

`include:` is valid in a `loop_group` body. Discovery expands the block before the run starts,
so each iteration executes ordinary namespaced body nodes — there is no child run or
runtime-resolved graph:

```yaml
- id: converge
  loop_group:
    until_bash: test $review.output.ready = "true"
    max_iterations: 5
    nodes:
      - id: review
        include: reusable-review
        with:
          request: $INPUTS.request
```

The block's `returns:` node supplies `$review.output`, including in `until_bash`. Internal
dependencies, inputs, gates, and namespacing behave the same as for a top-level include. A
`workflow:` node still cannot appear in a group body because it creates a separately governed
runtime sub-run rather than static composition.

### Cross-iteration references: `$LOOP_PREV`

A body node can reference a sibling's output from the **previous iteration**
with `$LOOP_PREV.<nodeId>.output` (and `$LOOP_PREV.<nodeId>.output.<field>`
for structured output):

```yaml
nodes:
  - id: fix-loop
    loop_group:
      # The terminal node's own verdict ends the loop; nothing here emits a
      # prose sentinel, so `until:` would run to max_iterations on a green run.
      until_bash: test $test.output = "green"
      max_iterations: 5
      nodes:
        - id: implement
          prompt: |
            Previous attempt's test output:
            $LOOP_PREV.test.output
            Fix what failed.
          depends_on: []
        - id: test
          bash: |
            if bun test; then
              printf 'green'
            else
              printf 'red'
            fi
          depends_on: [implement]
```

On iteration 1 (no prior iteration), `$LOOP_PREV.*` resolves to an empty
string. Field access uses the same strict semantics as `$nodeId.output.field`
(a field not in the producer's declared schema fails the consuming node rather
than silently degrading).

The group's `until_bash` sees current outputs through `$nodeId.output` and the
preceding iteration through `$LOOP_PREV.*`, including after a terminal pause is
answered. `LOOP_PREV_OUTPUT` contains the preceding iteration's chosen output with
completion tags removed. The next body iteration instead receives the answered
iteration's outputs as its previous snapshot.

A `command:` body node's command file gets the same `$LOOP_PREV.*` substitution as
the same text written as an inline `prompt:`.

A body node can also gate on the previous iteration's typed output with `when:`:

```yaml
- id: repair
  prompt: Repair the failing tests.
  depends_on: [test]
  when: "$LOOP_PREV.test.output == 'red'"
```

This is a condition reference, not text substitution. On iteration 1 it resolves to
`''`, so the non-empty equality is false. See [Condition Syntax](/reference/workflow-language/#when-condition-syntax).

An `include:` inside the body can use the same `$LOOP_PREV` condition to gate its
entire block. A false gate skips the whole block; when true, each node still follows
its own conditions and trigger rule. If the block contains a nested loop, the include's
gate still reads the previous iteration of the loop containing that include.

`$LOOP_PREV` works in a body node's `with:` binding **string values** too, with the
same text semantics as every other body surface: the previous iteration's output is
substituted into the value each pass (so `with: { prev: $LOOP_PREV.test.output }`
delivers last iteration's text, `''` on iteration 1 — never a typed value). It is
**not** a node reference, so a binding directive's `from:` cannot read it — the
loader rejects that at load and names the string form instead.

### Configuration fields

`loop_group` shares the same iteration-control fields as `loop`:
[`until`](#until), [`max_iterations`](#max_iterations),
[`fresh_context`](#fresh_context), and [`until_bash`](#until_bash), including the
at-least-one-of `until` / `until_bash` rule and the short-circuit between them. The
difference is the body: `loop` takes a single `prompt`; `loop_group` takes a
`nodes` array.

As with a `loop:` node (whose node-level `model`/`provider` are resolved and
applied to every iteration), `model` and `provider` set on a `loop_group` node
**are honored**: they become the default for every body AI node, overridable per
body node.

### Named owner sessions

A command or prompt in the body can continue a statically named pre-loop session:

```yaml
name: review-and-correct
description: Keep one implementation owner while independent reviews repeat
nodes:
  - id: implement
    prompt: Implement the requested change.
  - id: corrections
    depends_on: [implement]
    loop_group:
      max_iterations: 3
      fresh_context: true
      until_bash: 'test $review.output.done = true'
      nodes:
        - id: owner
          context: { resume: implement }
          prompt: Correct any remaining problems in the implementation.
        - id: review
          depends_on: [owner]
          context: fresh
          prompt: Review the change and report whether it is ready.
          output_format:
            type: object
            properties:
              done: { type: boolean }
            required: [done]
            additionalProperties: false
```

The owner's first executed turn immutably forks `implement`, preserving the source.
Subsequent iterations continue that private branch with the same session ID. Reviewers
start fresh and cannot replace the owner's cursor. Explicit named ownership also wins
over `fresh_context` and parallel-layer resets. Multiple owners fork separate branches;
a skipped owner keeps its cursor, or waits to fork until its first executed turn.

The source must be a command, prompt, or plain `loop:` node in an enclosing scope with
a dependency path proving it completes before the group starts. Unordered, non-session,
and loop-group sources are rejected. A source in the same body works differently; see
[Same-iteration sessions](#same-iteration-sessions). Nested groups get separate owner
cursors for each enclosing invocation. Nested pauses retain every enclosing
owner cursor and resume within the paused enclosing iteration before advancing.
The resolved provider must match the source and
support session resume and immutable forks. Missing context or a replacement owner
session ID fails the node rather than starting a new conversation.

### Same-iteration sessions

A command or prompt in the body can also continue a session produced earlier in the
same iteration, for example to ask an agent to finish a step it skipped:

```yaml
nodes:
  - id: rounds
    loop_group:
      max_iterations: 3
      until_bash: 'test $work.output.done = true'
      nodes:
        - id: work
          prompt: Review the change, write review.md, and report what you did.
          output_format:
            type: object
            properties:
              done: { type: boolean }
              wrote_report: { type: boolean }
            required: [done, wrote_report]
        - id: follow-up
          depends_on: [work]
          when: '$work.output.wrote_report != true'
          context: { resume: work }
          prompt: You did not write review.md. Write it now from your review.
```

In each iteration, `follow-up` forks that iteration's `work` session. It never continues
its own branch from an earlier iteration, and it has no owner cursor. The fork contract is
the same as for any named resume: the source session stays unchanged, the providers must
match and support immutable forks, and a missing source handle fails the node.

The source must be a command, prompt, or plain `loop:` node transitively upstream of the
consumer within the body. A body node that is not upstream, a node in a different
`loop_group` body, and a consumer that is not a command or prompt node are rejected when
the workflow loads.

### Resume

Suspension and failure have different recovery rules:

- **Resume after a terminal pause** (the body's terminal attention wait is
  answered): the engine compares the question on the first answer and may ask again
  in the same iteration. After one re-ask, it accepts the next answer even if the
  question changes again, as described [above](#pausing-to-ask-inside-the-body). Once an
  answer is accepted, the group rechecks `until_bash` against the answered iteration's
  current outputs and its own preceding snapshot. If historical ownership or full
  output bytes cannot be restored, the group fails restoration rather than treating
  the history as empty. Only iteration one has a known empty preceding snapshot;
  explicitly skipped nodes have no output. If the check does not pass, the group
  continues with the **next** iteration's whole body. With
  `fresh_context: false`, the body's AI session continues from where it paused (the
  session cursor is persisted across the pause). `$LOOP_PREV.*` refs on the first resumed
  iteration resolve to the prior iteration's real body outputs, restored from
  the persisted run history — the same as an un-paused next iteration would
  have seen.
- **Named owners after suspension**: terminal body waits and the deprecated
  interactive and approval gates persist private owner cursors independently of the ambient
  cursor. The next iteration continues each owner even with `fresh_context: true`.
  Missing or invalid owner state fails restoration. A wait that suspends again retains
  the same snapshot.
- **Same-iteration sessions after a nested pause**: a nested group's pause between a
  same-body source and its consumer resumes within the paused iteration, which re-runs
  the source. The consumer forks the re-run, matching the `$source.output` it reads.
- **Failure resume** (`/workflow resume <id>` after a crash/failure): there is
  no persisted iteration cursor — the loop_group node restarts from
  **iteration 1**. Per-body-node resume granularity is not supported in v1.

### What is NOT supported on loop_group nodes (v1)

- `until_field` / `output_format` — the group never calls the provider itself, so it
  has no payload of its own to read. Express the same thing with a body node that
  declares `output_format` plus `until_bash` reading `$node.output.field` — see
  [`until_field`](#until_field).
- `retry` (the loop manages its own iteration) — rejected at parse time.
- Cross-run `persist_session` for body AI nodes. In-run iterations use the ambient
  cursor governed by `fresh_context`, or explicit named owner cursors described above.
- Per-body-node resume (skip-to-failed-body-node) — the whole iteration re-runs.
- `$LOOP_PREV.<id>.output[N]` history indexing — only the immediately prior
  iteration is reachable.

Nested `loop_group` inside a `loop_group` body is supported by construction
(the body is a normal `nodes` array), but is not hardened in v1.

## Legacy interactive loops (deprecated)

`interactive: true` with `gate_message` on a `loop:` or `loop_group:`, the
`$LOOP_USER_INPUT` variable, and `signal_completes` still load and run unchanged, but the
loader warns once per workflow file, naming every node that uses them. Rewrite each one as
a `loop_group` whose body ends in a `wait: attention` node:

| Legacy | Replacement |
|---|---|
| `interactive: true` + `gate_message` | a terminal `wait: { attention: <message>, form: approval }` in the body (or another [form](/reference/workflow-language/#attention-waits)) |
| `$LOOP_USER_INPUT` | `$LOOP_PREV.<wait-id>.output.text` |
| approve with no comment to finalize | `until_bash` that checks the answer, e.g. `decision=$ask.output.decision; [ "$decision" = "approve" ]` |
| `signal_completes: true` | a `when:` on the wait so it pauses only when the work needs an answer, with `until_bash` deciding completion from the work |

See [Pausing to ask inside the body](#pausing-to-ask-inside-the-body) for both patterns and
[Migrating from approval gates](/guides/approval-nodes/#migrating-from-approval-gates) for
the other legacy pauses.

### `interactive` and `gate_message`

Runs already paused at a legacy loop gate stay answerable as before. The gate message
starts with a status line naming the completion channel that ended the iteration
(`✅ Completion condition met via ...`), or `⚠️ No completion condition met in this
iteration`, followed by an excerpt of the output and the `gate_message`.

- On a completed iteration, approving with no comment finalizes the node from the
  output already computed, with no re-run. Approving with a comment runs another
  iteration with the comment as `$LOOP_USER_INPUT`.
- On an iteration that did not complete, both forms run another iteration. On the final
  iteration (`max_iterations`), only a comment runs one more; approving with no comment
  fails the node with `max_iterations`.

The rule is the same on every surface: chat `/workflow approve <id> [comment]`,
`archon workflow approve <id> [comment]`, the HTTP endpoint (omit `comment` to
finalize), the console, and the `manage_run` chat tool (`accept: true` finalizes). A chat
message that asks the agent to approve passes your words as the comment, so it iterates;
see [Answering](/guides/approval-nodes/#answering). An orchestrating agent can read
`.metadata.approval.completionSignaled` from `archon workflow get <id> --json` before it
decides. `--json` records the decision without resuming; `archon serve`,
`archon workflow wake`, or `archon workflow resume` then continues the run.

A paused interactive loop resumes from the prompt template captured at the gate, so
editing the YAML or command file does not change a run that is already paused. The first
iteration after the resume sees the gated iteration's output as `$LOOP_PREV_OUTPUT`, and
`until_bash` sees it as `LOOP_PREV_OUTPUT`. A `loop:` node paused by an earlier Archon
release did not record that output, so its first resumed iteration sees both as empty.

### `signal_completes` — autonomous completion

By default a legacy interactive loop gates even on an iteration that met its completion
condition. `signal_completes: true` completes the node on that iteration instead, so the
gate appears only on iterations that did not complete. Setting it without
`interactive: true` has no effect and emits a loader warning. Replace it with a terminal
wait whose `when:` skips it on success, as in the second example under
[Pausing to ask inside the body](#pausing-to-ask-inside-the-body).

## See Also

- [Workflow language](/reference/workflow-language/): the full workflow reference
- [Per-Node Hooks](/guides/hooks/) — SDK hooks for command/prompt nodes
- [Per-Node MCP Servers](/guides/mcp-servers/) — external tool integration
- [Per-Node Skills](/guides/skills/) — skill preloading
