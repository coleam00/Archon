---
title: Route Loop Nodes
description: Route workflow execution through positive, negative, and exhausted paths based on a structured review result.
category: guides
area: workflows
audience: [user]
status: current
sidebar:
  order: 3.5
---

DAG workflow nodes support a `route_loop` field for bounded control-flow loops.
Use it when a review or quality gate should route back to explicit fix work on failure, route forward on success, and route to escalation when the retry budget is exhausted.

`route_loop` is a controller node.
It does not call an AI provider and it does not replace the existing [`loop:` node](/guides/loop-nodes/), which repeats an AI prompt until a completion signal appears.

## Quick Start

```yaml
name: route-loop-smoke
description: Fix, review, and route until the review passes.
nodes:
  - id: fix
    prompt: "Make the required fix."

  - id: review
    depends_on: [fix]
    prompt: "Review the result and return structured JSON."
    output_format:
      type: object
      properties:
        result:
          type: string
          enum: [positive, negative]
      required: [result]

  - id: review-router
    depends_on: [review]
    route_loop:
      from: review
      condition: "$review.output.result == 'positive'"
      max_iterations: 3
      routes:
        positive: done
        negative: fix
        exhausted: escalation

  - id: done
    depends_on: [review-router]
    bash: "echo done"

  - id: escalation
    depends_on: [review-router]
    bash: "echo escalation"
```

When `review` returns `{"result":"negative"}`, the router activates `fix`.
The selected negative path reruns `fix`, then normal dependencies rerun `review`, then `review-router` evaluates again.
When `review` returns `{"result":"positive"}`, the router activates `done`.
If the review keeps failing after the configured budget, the router activates `escalation`.

Unselected route targets stay dormant.
They are not marked as skipped, because no branch condition executed on those nodes.

## Configuration

```yaml
- id: review-router
  depends_on: [review]
  route_loop:
    from: review
    condition: "$review.output.result == 'positive'"
    max_iterations: 10
    routes:
      positive: done
      negative: fix
      exhausted: escalation
```

| Field | Required | Description |
|-------|----------|-------------|
| `depends_on` | Yes | Must contain exactly one entry, and it must equal `route_loop.from`. |
| `route_loop.from` | Yes | Source node whose latest completed output drives the decision. |
| `route_loop.condition` | Yes | Condition expression evaluated against the source node output. |
| `route_loop.max_iterations` | No | Integer from `1` to `100`. Defaults to `10`. Counts false decisions that still route to `negative`. |
| `route_loop.routes.positive` | Yes | Target activated when the condition evaluates true. |
| `route_loop.routes.negative` | Yes | Target activated when the condition evaluates false and budget remains. |
| `route_loop.routes.exhausted` | Yes | Target activated when the condition evaluates false after budget is consumed. |

Route target ids use the same safe node-id grammar as workflow node ids: `[A-Za-z_][A-Za-z0-9_-]{0,63}`.
The reserved ids `__proto__`, `prototype`, and `constructor` are rejected.

## Condition Rules

`route_loop.condition` reuses the same grammar as `when:` conditions:

```yaml
condition: "$review.output == 'APPROVED'"
condition: "$review.output.result == 'positive'"
condition: "$review.result == 'positive'"
condition: "$review.output.score >= 0.9 && $review.output.blocked == false"
```

Every node reference in the condition must reference the node declared in `route_loop.from`.
If the route decision needs multiple inputs, add a separate aggregation node and make that node the `from` source.

Whole-output conditions such as `$review.output == 'APPROVED'` do not require `output_format`.
Field conditions such as `$review.output.result == 'positive'` require the source node to declare that field in `output_format.properties`.
An undeclared or unresolvable field fails the route-loop node instead of silently routing negative.

Unlike `when:`, a route-loop condition parse failure is a node failure.
The router is mandatory control flow, so it fails fast instead of skipping.

## Outcome Semantics

`positive` means the condition evaluated true.
It activates `routes.positive` and resets only this route-loop node's negative counter.

`negative` means the condition evaluated false and budget remains.
The executor increments the negative counter first, then chooses `negative` when the new count is less than or equal to `max_iterations`.

`exhausted` means the condition evaluated false after budget was consumed.
The executor chooses `exhausted` when the incremented negative count is greater than `max_iterations`.

With `max_iterations: 1`, the first false decision routes to `negative`.
The second consecutive false decision routes to `exhausted`.

## Route Paths

`positive` and `exhausted` must be exit paths.
They must not lead back to `route_loop.from`.

`negative` may exit, or it may target a self-contained rerun path that eventually reaches `route_loop.from` and then the route-loop node again through normal `depends_on` edges.
For the common fix-review pattern, route `negative` to the first fix node in that path.

Routing `negative` directly to `route_loop.from` is allowed but logged as a warning because it usually reruns review without fix work.

## Events And Outputs

Every route decision emits a `node_routed` workflow event.
The route-loop node also completes with JSON output that mirrors the route metadata:

```json
{
  "from": "review",
  "outcome": "negative",
  "to": "fix",
  "condition": "$review.output.result == '<redacted>'",
  "condition_result": false,
  "negative_count": 1,
  "max_iterations": 3,
  "attempt": 1,
  "execution_seq": 4
}
```

The `condition` field is a safe redacted string.
It preserves node references, field names, operators, and boolean structure, but literal comparison values are replaced with `<redacted>`.

Downstream nodes can read route metadata with normal output references:

```yaml
- id: report-escalation
  depends_on: [review-router]
  prompt: "Explain why routing ended with $review-router.output.outcome after $review-router.output.negative_count negative decisions."
```

The route-loop output never copies the source node output.
Read the source node directly when downstream work needs the latest review result.

## Retry And Resume

Do not retry a route-loop controller directly.
Retry the source node named by `route_loop.from`, for example:

```bash
archon workflow retry-node <run-id> review
```

Retrying the source node lets the new source output flow through the controller again.
The CLI, API, and Web UI reject direct controller retry and point you at `route_loop.from`.

Resume preserves route-loop counters, route activations, attempts, and execution sequence metadata.
Completed route-loop attempts stay in the event history, while run summaries and `$node.output` use the latest completed attempt.

## Web Builder

The Workflow Builder exposes Route Loop as a distinct node type.
The single input edge writes both `depends_on[0]` and `route_loop.from`.
The three output handles write `routes.positive`, `routes.negative`, and `routes.exhausted`.

Route edges are labels on the controller output handles.
They are not normal dependency edges, and they do not make unselected branches run.
