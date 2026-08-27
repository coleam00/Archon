# Node Reference

Mechanical reference: every node type, its fields, how nodes wire together, and
how to prove wiring with fixtures. For design judgment (gates, primitives,
prompting) read `authoring-workflows.md` in this folder first.

## Workflow-level fields

```yaml
name: my-workflow            # unique; user workflows may shadow bundled names
description: |
  What this does and when to use it. Shown by `archon workflow list`.
model: large                 # tier keyword (small|medium|large) or @alias — never a literal model id
inputs:                      # declared signature; callers pass via --input name=value
  work:
    default: ""
    description: Optional work override; prompts read $ARGUMENTS explicitly for fallback
returns: implement           # which node's output is the workflow's terminal output
outcome_field: green         # persist one authored boolean beside run status (e.g. green/ready/rooted)
interactive: false           # true REQUIRED if any approval gate exists (fresh launch cannot detach)
worktree:
  enabled: true              # pin worktree isolation. Bounds git files ONLY —
                             # not ~/.archon, env vars, database, or sessions
mutates_checkout: false      # declare when the workflow never touches the working tree
```

An input default does not fall back to the invocation message automatically.
When both are valid sources, give the model both values and state the precedence:

```yaml
- id: implement
  prompt: |
    Optional work override: $INPUTS.work
    Original invocation: $ARGUMENTS
    Use the work override when it is non-empty; otherwise use the original invocation.
```

## The eleven node types

Exactly one of these appears per node: `command`, `prompt`, `bash`, `script`,
`loop`, `loop_group`, `approval`, `cancel`, `wait`, `workflow`, `include`.

### command / prompt — AI nodes

```yaml
- id: plan
  command: plan              # loads <workflow-folder>/commands/plan.md — prefer files over inline prose
  depends_on: [investigate]
```
```yaml
- id: classify
  prompt: "Classify $ARGUMENTS. Set type to BUG or FEATURE."
  allowed_tools: []          # no tools needed for pure judgment
  output_format:             # declare ONLY when a machine consumes a field (gate/until_field/script)
    type: object
    properties:
      type: { type: string, enum: [BUG, FEATURE] }
    required: [type]
```

Key fields on AI nodes: `model`/`provider` (tiers), `output_format` (+ `output_type`
for typed artifact sidecars), `allowed_tools`/`denied_tools`, `effort`/`thinking`,
`retry` (default 2x on transient), `persist_session`, `idle_timeout`.

Session context is explicit when it matters:

- Omitted context inherits the prior compatible provider session in a sequential
  layer and starts fresh in a parallel layer.
- `context: fresh` always starts clean. Use it for independent verification.
- `context: shared` explicitly inherits the ambient session in a sequential
  layer. It is invalid where parallel structure makes that ancestry ambiguous.
- `context: { resume: plan }` forks the named completed upstream node's session.
  Use it when one exact ancestry matters; the provider must support session forks.

### bash — deterministic shell, no AI

```yaml
- id: test-gate
  bash: bun run test
  timeout: 300000            # ms; stdout captured as $test-gate.output
```
Exit code decides pass/fail. The same node shape verifies non-code work:
`bash: python3 scripts/reconcile.py --period 2026-08` (totals must balance),
or a script that checks every imported row has an owner. One-or-two-line glue
only; anything with branching is a script node.

### script — TypeScript (bun) or Python (uv), no AI

```yaml
- id: verify-report
  script: verify-report      # loads <workflow-folder>/scripts/verify-report.py
  runtime: uv
  depends_on: [implement, review]
  with:                      # typed value transport into INPUTS_<UPPER_SNAKE> env vars
    green: "$implement.output.green"
    prior: {from: "$review.output", if_skipped: "none"}
```

Prefer named script files over inline bodies. Python (`runtime: uv`) preferred,
TypeScript (`runtime: bun`) fine. `deps:` adds uv dependencies.

### loop — iterate ONE AI job

```yaml
- id: implement
  loop:
    command: implement
    until_field: done        # boolean in this node's output_format
    max_iterations: 5
  depends_on: [record-start]
  output_format:
    type: object
    properties:
      done: {type: boolean}
    required: [done]
```

Completion channels — declare at least one, pick by tier:

- `until_bash: "<exit-0 check>"` — completion externally checkable (deterministic)
- `until_field: <bool>` — completion is the model's judgment, via `output_format`
- `until: TOKEN` — prose sentinel; interactive gates a human reads ONLY (deprecated elsewhere)

Also: `fresh_context: true` (each iteration starts clean), `$LOOP_PREV_OUTPUT`
and `$LOOP_PREV.<nodeId>.output` inside body prompts for previous-iteration state.
A failed iteration fails the loop at `max_iterations` — bound exhaustion fails
truthfully rather than blessing a bad last attempt.

### loop_group — repeat a sub-DAG

```yaml
- id: fix-cycle
  depends_on: [review-findings]
  loop_group:
    nodes:
      - id: fix
        prompt: "Address findings: $review-findings.output"
      - id: recheck
        prompt: "Verify each finding is fixed with evidence."
        depends_on: [fix]
        context: fresh
        output_format: {type: object, properties: {ready: {type: boolean}}, required: [ready]}
    until_bash: 'test "$recheck.output.ready" = "true"'
    max_iterations: 5
```

Body is sealed (no external `depends_on`); outer outputs reach bodies via
`$nodeId.output`; previous iteration via `$LOOP_PREV.<body-id>.output`. A failed
body node fails the group immediately.

### approval — human gate

```yaml
- id: review-gate
  approval:
    message: "Review before proceeding"
    decisions:
      - {id: approve, label: Approve}
      - {id: needs-revision, label: Needs revision}
  depends_on: [plan]

- id: revise
  prompt: "Revise using this feedback: $review-gate.output.text"
  depends_on: [review-gate]
  when: "$review-gate.output.decision == 'needs-revision'"
```

Requires `interactive: true` at workflow level. The fresh launch cannot detach;
continuation actions on an already-paused run can. Use only for interactive
sessions or super load-bearing actions. Authored `decisions:` always produce
structured `{decision, text}` output. `capture_response` and `on_reject` are
compatibility-only; wire rework explicitly with `when:` as above, or put the gate
at the end of a `loop_group` when review and revision should repeat.

### cancel — terminate deliberately

```yaml
- id: refuse
  cancel: "This workflow handles bugs only."
  when: "$classify.output.type != 'BUG'"
```

### workflow / include — reuse another workflow

Use `workflow:` to start a governed child run with its own artifacts, gates, cost,
and audit trail. Use `include:` to flatten a reusable workflow block into the
current run at load time.

```yaml
- id: review-child
  workflow: archon-review
  with:
    scope: "$INPUTS.branch"
  isolation: worktree

- id: review-inline
  include: archon-review
  with:
    scope: "$INPUTS.branch"
```

The `workflow:` target name is static YAML but resolves when the node executes,
so a prior node may author the child workflow. `workflow:` also accepts `input:`
instead of `with:` and can declare `fan_out:`. A plain `include:` resolves and
expands fully at load time; the directive carries only structural graph fields
plus `with:` and has no execution surface of its own.

Put `fan_out:` on `include:` when runtime data determines how many copies of a
static block should run inside the parent run:

```yaml
- id: list-scopes
  bash: printf '["packages/cli","packages/workflows"]'

- id: review-each
  include: archon-review
  depends_on: [list-scopes]
  fan_out:
    items: "$list-scopes.output"
    as: scope               # required; each instance receives $INPUTS.scope
    max_parallel: 1         # serial escape when the included block may write
    join: all_done
```

This form creates no child runs. It returns an item-ordered JSON array under
`$review-each.output`. With `join: all_done`, a failed instance contributes an
`archon_failed` marker; `all_success` fails the node. To run instances
concurrently, the complete included block must declare `mutates_checkout: false`.
Approval gates, durable waits, and other suspension paths are not supported
inside composed fan-out; put them before or after the fan-out.

### wait — suspend durably

```yaml
- id: pause-for-ci
  wait:
    duration_ms: 300000
```

A wait declares exactly one bounded condition: `duration_ms`, an ISO timestamp
under `until`, or `event` plus `deadline_ms`. Archon persists the suspension and
releases the worker slot. Its fixed structured output includes `status`
(`satisfied` or `expired`) and `waited_ms`; event waits may also return `event`
and `payload`.

## Wiring nodes together

**`depends_on`** creates edges; independent nodes in one topological layer run
concurrently.

**Data flow** — declared values carry scalars, artifacts carry documents:

- `$nodeId.output` — whole text of an upstream node; unknown/skipped producer → `''`
- `$nodeId.output.field` — strict JSON access: missing key **fails the consumer**
  (never silent-empty); declared-optional field resolves to `''`
- `with:` bindings (#2637) — prompt/command files read bound values as
  `$INPUTS.<name>`; bash/script processes receive `INPUTS_<UPPER_SNAKE>` env vars.
  `{from, if_skipped}` discriminates skipped producers from ran ones; a failed
  producer fails the binding
- `$INPUTS.<name>` — declared workflow inputs, also delivered as
  `INPUTS_<UPPER_SNAKE>` to bash/script
- `$ARTIFACTS_DIR` — pre-created directory for reports/evidence humans read
- In bash/script sources, user-controlled values arrive as ENV VARS
  (`ARGUMENTS`, `INPUTS_*`, ...) — never text-substituted (injection guard).
  `$nodeId.output` refs ARE substituted; give prose producers an `output_format`
  before assigning their output directly in a script.

**`when:` conditions** skip a node when false (skipped propagates to dependants):

```yaml
when: "$classify.output.type == 'BUG'"
when: "$score.output.confidence >= '0.9' && $gate.output.proceed == true"
```

Operators: `==`, `!=`, `<`, `>`, `<=`, `>=` (numbers auto-parse, fail-closed on
non-numeric), compound with `&&`/`||` (`&&` binds tighter, no parentheses).
Malformed expression → node skipped + warning. Dot-access contract violation →
node FAILS loudly. Guard optional paths with `when:` or `trigger_rule`.

**`trigger_rule`** — join semantics over dependencies:

| Value | Behavior |
|-------|----------|
| `all_success` | all deps succeeded (default) |
| `one_success` | at least one dep succeeded |
| `none_failed_min_one_success` | none failed AND ≥1 succeeded (skips OK) |
| `all_done` | all deps terminal (completed, failed, OR skipped) |

## Fixtures — prove wiring without AI spend

Every authored workflow ships dry-run fixtures in
`<workflow-folder>/fixtures/<name>.stubs.yaml`:

```yaml
# Declared expectations + node stubs. Every non-reserved key is a node output.
fixture:
  expect: completed          # or failed / paused / cancelled
  fail-node: assert-changed  # required when expect: failed — must match exactly
  inputs:
    branch: task-42
implement:
  done: true
  green: true
  summary: "stub summary"
exec-code: false             # true executes bash/script nodes for real (clean tree!)
```

Run them:

```bash
archon workflow test                    # everything discovered
archon workflow test my-workflow        # one workflow's fixtures
```

Expected-red fixtures are the important ones: a guard that has never been seen
failing proves nothing. Prove reds red on a CLEAN tree — uncommitted edits
outside `.archon/` make deterministic change-detectors pass and turn your red
path green. Validate load-time errors with `archon workflow list`.
