---
title: Asking for an Answer
description: Pause a workflow until it gets an answer with wait attention forms, and migrate legacy approval gates and interactive loops.
category: guides
area: workflows
audience: [user]
status: current
sidebar:
  order: 4
---

A workflow that needs input pauses at a `wait: attention` node. The run stops,
the question waits in the attention queue, and the run continues once someone
answers it in the form the node declares. Archon does not route the question or
care who answers: a person in the console or chat, an agent through the CLI, or a
handler workflow all use the same answer channel.

Use it to review a generated plan before expensive work, to pick between options
an agent produced, or to collect instructions mid-run.

## Quick start

```yaml
name: plan-review-implement
description: Plan, pause for review, then implement

nodes:
  - id: plan
    prompt: |
      Analyze the codebase and create a detailed implementation plan.
      $USER_MESSAGE

  - id: review
    depends_on: [plan]
    wait:
      form: approval
      attention: |
        Review the plan before implementation starts:

        $plan.output

  - id: stop
    depends_on: [review]
    when: "$review.output.decision == 'reject'"
    cancel: The plan was rejected.

  - id: implement
    depends_on: [review]
    when: "$review.output.decision == 'approve'"
    prompt: |
      Implement the plan. Reviewer notes: $review.output.text
      $plan.output
```

When execution reaches `review`, the run pauses and the question is sent to the
conversation that started it. The pause is durable: it waits in the attention
queue until it is answered, whether the run started in the foreground, with
`--detach`, from the web console, or from a trigger. If the notice cannot be
delivered, the run still waits; the failed delivery is logged and recorded on
the run as a `pause_notice_undelivered` event. When web push is configured, the
owner of a run on a chat platform is then notified by push instead, once per pause.

`reject` is an answer like any other and never cancels the run by itself. The
`stop` node is what ends it; leave it out when a rejection should continue
somewhere else.

## Forms

`form` fixes what the wait accepts and what the next node reads:

| Form | Answer accepted | The next node reads |
|---|---|---|
| `message` (default) | free text, which may be empty | `{ text }` |
| `approval` | `approve` or `reject`, plus optional text | `{ decision, text }` |
| `select` | exactly one declared option id, plus optional text | `{ decision, text }` |
| `multi_select` | one or more distinct declared option ids, plus optional text | `{ decisions, text }` |

`select` and `multi_select` declare `options`, literally or as one whole
reference to an upstream output:

```yaml
- id: choose-base
  depends_on: [plan]
  wait:
    attention: "Which branch should the fix target?"
    form: select
    options:
      - { id: use-main, label: "Base on main" }
      - { id: use-dev }
```

The attention message accepts runtime references (`$plan.output`, `$INPUTS.x`).
See [Attention waits](/reference/workflow-language/#attention-waits) for the full
rules on forms, options and output.

## Answering

Every surface accepts the same answers. An undeclared option is refused on every
surface and the run stays paused.

- **CLI**: [`archon workflow answer`](/reference/cli/#workflow-answer) with the
  occurrence from `workflow get` or `workflow wait --json`. `approve [text]`,
  `reject [text]` and `respond <option> [text]` work as shorthand: `approve`
  answers a `message` wait with its text, and otherwise each verb chooses the
  option of the same id.

  ```bash
  archon workflow approve <run-id> "Looks good"
  archon workflow reject <run-id> "Needs tests"
  archon workflow respond <run-id> use-dev
  ```

- **Chat**: `/workflow approve`, `/workflow reject` and `/workflow respond` with
  the same arguments (`/archon-workflow` in Slack). You can also say what you
  want in the conversation. The chat agent reads the open question and your full
  message, and answers only when your message clearly is one. A question or an
  ambiguous message leaves the run paused.
- **Web console**: open the paused run; it shows the question and the form's
  choices.
- **HTTP**: `POST /api/workflows/runs/<run-id>/answer` with
  `{ occurrence, choose?, text? }`.

An answer names the occurrence it was meant for, so an answer to an earlier pause
of the same run is refused. Answering through the CLI without `--json` continues
the run in that process; otherwise `archon serve` or `archon workflow wake`
continues it. Attention waits are not supported in container-isolated workflows.

Continuing after an answer picks the run up where it paused. Nodes that completed
replay their results, and a node that failed before the pause replays its failure
instead of running again, because the run had already moved past it. On the first
answer, if the question the wait would ask now differs from the one that was answered,
the wait discards the answer and asks again. Its notice names the changed dependencies
when the engine can identify them; otherwise it gives a generic notice that the
question changed. After one re-ask, the next answer is accepted even if the question
changes again. See [attention waits](/reference/workflow-language/#attention-waits).

## Reading the answer

Downstream nodes read the answer as `$<wait-id>.output.decision`,
`$<wait-id>.output.decisions` and `$<wait-id>.output.text`, depending on the
form. Every form records the answer's text, so there is nothing to opt into.

Route on the decision with `when:`:

```yaml
- id: implement
  depends_on: [review]
  when: "$review.output.decision == 'approve'"
  prompt: "Implement the plan. Notes: $review.output.text"
```

## Rework until approved

To revise and ask again, put the work and the question in a `loop_group` whose
body ends in the wait. The next iteration reads the previous answer as
`$LOOP_PREV.<wait-id>.output`, and `until_bash` ends the loop on approval:

```yaml
- id: refine-plan
  depends_on: [plan]
  loop_group:
    max_iterations: 3
    until_bash: 'decision=$review.output.decision; [ "$decision" = "approve" ]'
    nodes:
      - id: revise
        prompt: |
          Improve this plan: $plan.output
          Feedback on the previous revision, if any: $LOOP_PREV.review.output.text
      - id: review
        depends_on: [revise]
        wait:
          form: approval
          attention: |
            Review the revised plan:

            $revise.output
```

The wait must be the body's sole terminal sink. The loader warns when
`until_bash` does not reference the wait's output, because the loop would then
ignore every answer. See
[Pausing to ask inside the body](/guides/loop-nodes/#pausing-to-ask-inside-the-body)
for how a paused loop group continues.

## Engine-initiated pauses

Two pauses are created by the engine, not authored, and keep their own
mechanics:

- **Container write-back**: a container run pauses before applying its changes to
  the checkout. `approve` applies the overlay and `reject` discards it.
- **A parent blocked on a `workflow:` child**: the child run pauses with its own
  question. Answer the child by its run id; answering the parent is refused with
  a redirect to the child, and the parent continues when the child finishes.

## Migrating from approval gates

`approval:` gates and interactive loop gates are deprecated. They still load and
run exactly as before, and paused runs of the old shapes stay answerable with
`approve`, `reject` and `respond`. Each file that uses one gets one load warning
per legacy shape, naming every node that uses it and its replacement. Removing the
legacy runtime is a later release, whose notes will ask you to answer or abandon
paused runs of the old shapes first.

Container-isolated workflows cannot migrate yet: a run with container isolation
refuses any `wait:` node before it starts, so `approval:` is still their only
authored pause. Keep those gates until waits are supported there; the load
warning still appears.

| Legacy | Replacement |
|---|---|
| `approval: { message }` | `wait: { attention: <message>, form: approval }`. A legacy reject cancels the run; the attention form continues with decision `reject`, so add a `cancel:` node on reject where rejecting should end the run. Archon does not translate this for you. |
| `approval.decisions` | `form: select` with the same ids and labels as `options`. The output is the same `{ decision, text }`. |
| `approval.capture_response` | The answer's text, `$<id>.output.text`. Every form records it. |
| `approval.on_reject` and `$REJECTION_REASON` | A rework node with `when: "$<id>.output.decision == 'reject'"` that reads `$<id>.output.text`. To repeat the rework, use a `loop_group` whose body ends in the wait, with the rework node first reading `$LOOP_PREV.<id>.output.text`. See [Rework until approved](#rework-until-approved). |
| Interactive loop gates (`interactive: true` with `gate_message` on `loop:` or `loop_group:`, and `$LOOP_USER_INPUT`) | A `loop_group` whose body ends in `wait: attention`. The next iteration reads `$LOOP_PREV.<wait-id>.output`, and `until_bash` checks the answer. |

A plain gate, before and after:

```yaml
# Before: reject cancels the run
- id: review
  depends_on: [plan]
  approval:
    message: "Review the plan."
    capture_response: true

# After: the decision is routed explicitly
- id: review
  depends_on: [plan]
  wait:
    form: approval
    attention: "Review the plan."

- id: stop
  depends_on: [review]
  when: "$review.output.decision == 'reject'"
  cancel: The plan was rejected.
```

Nodes that depended on the gate and should only run on approval need
`when: "$review.output.decision == 'approve'"`. A downstream reference to
`$review.output` from a `capture_response` gate becomes `$review.output.text`.

A gate with authored decisions maps one to one:

```yaml
# Before
approval:
  message: "CI failed. What next?"
  decisions:
    - { id: rerun-ci, label: "Re-run CI" }
    - { id: give-up }

# After
wait:
  attention: "CI failed. What next?"
  form: select
  options:
    - { id: rerun-ci, label: "Re-run CI" }
    - { id: give-up }
```

### Dry runs and fixtures

`archon workflow run --dry-run` auto-approves a legacy gate unless you pass
`--pause-at-gates`. An attention wait pauses the simulation instead, unless the
stubs give the wait node a value: that stub stands in for the answer and must
match the form's output, for example `review: { decision: approve, text: "" }`.

## Legacy gate behavior

This describes the deprecated shapes for runs and workflows that still use them.

- **Approve** records the answer and continues the run. A gate with
  `capture_response: true` and no `decisions` outputs the approval comment as
  `$<id>.output`; otherwise its output is empty.
- **Reject** cancels the run, unless the gate has `on_reject`. Then the
  `on_reject.prompt` runs with `$REJECTION_REASON` set to the reason, and the run
  pauses at the same gate again, until approval or `on_reject.max_attempts`
  (default 3, range 1 to 10) rejections, which cancel the run.
- **Authored `decisions`** accept only the declared ids through `respond`;
  `approve` and `reject` work only when declared. Every decision completes the
  gate with `{ decision, text }` and never cancels by itself.
- **Interactive loop gates** pause after each iteration. Approving with text runs
  another iteration with the text as `$LOOP_USER_INPUT`. When a completion signal
  already fired on that iteration, approving without text finalizes the loop.
- An `approval:` gate inside a `loop_group` body must be its sole terminal sink,
  like a wait.
- While approved or rejected-with-rework, a gate's run stays `paused` with
  `metadata.approval.resolved` set until the resume machinery picks it up, so a
  `failed` status always means a real failure.
- A gate in a container run, or one already paused when you upgraded, does not
  continue on its own after it is answered. Run `archon workflow resume <run-id>`
  in the same project.
