# Quickstart: Route Loop Decisions

## Prerequisites

Use Bun from the repository root.
Do not run root `bun test`, because it mixes Bun `mock.module()` state across packages.

## Run The Existing TDD Guard

The feature spec points to an intentionally failing route-loop TDD guard in `packages/workflows/src/dag-executor.test.ts`.
Run it before implementation to confirm the missing feature is reproduced.

```bash
bun test packages/workflows/src/dag-executor.test.ts -t "reruns a negative route path until the route_loop condition passes"
bun test packages/workflows/src/dag-executor.test.ts
```

Expected pre-implementation result:

- The route-loop end-to-end TDD case fails because `route_loop` is not yet a supported node mode.
- The focused TDD guard stops after `fix`, `review` before implementation and expects `fix`, `review`, `fix`, `review`, `done`.
- Existing non-route DAG tests should continue to describe current behavior.

## Implement In Focused Slices

Start with schema and loader validation.
Then implement route activation runtime behavior.
Then wire events, API projection, and Web authoring.
Keep the existing `loop` node tests passing after every slice.

## Focused Validation Commands

Workflow engine:

```bash
bun test packages/workflows/src/dag-executor.test.ts
bun test packages/workflows/src/loader.test.ts
bun test packages/workflows/src/schemas.test.ts
bun test packages/workflows/src/condition-evaluator.test.ts
bun test packages/workflows/src/output-ref.test.ts
```

Core persistence:

```bash
bun test packages/core/src/db/workflows.test.ts
bun test packages/core/src/db/workflow-events.test.ts
bun test packages/core/src/workflows/store-adapter.test.ts
```

Server and API projection:

```bash
bun test packages/server/src/routes/api.workflow-runs.test.ts
bun test packages/server/src/routes/api.workflows.test.ts
```

Web builder and run UI:

```bash
bun test packages/web/src/experiments/console/builder/model/round-trip.test.ts
bun test packages/web/src/experiments/console/builder/validation/graph.test.ts
bun test packages/web/src/experiments/console/builder/validation/structural.test.ts
bun test packages/web/src/experiments/console/builder/validation/validate.test.ts
bun test packages/web/src/experiments/console/builder/variants/detect.test.ts
bun test packages/web/src/lib/dag-layout.test.ts
bun test packages/web/src/components/workflows/DagNodeComponent.test.ts
bun test packages/web/src/components/workflows/WorkflowExecution.test.tsx
bun test packages/web/src/stores/workflow-store.test.ts
```

Package-level checks:

```bash
bun --filter @archon/workflows test
bun --filter @archon/core test
bun --filter @archon/server test
bun --filter @archon/web test
```

## Regenerate Types After API Schema Changes

Start the server first.

```bash
bun run dev:server
```

In another shell, regenerate Web API types.

```bash
bun --filter @archon/web generate:types
```

## Final Validation

Before opening a PR, run the repository validation command.

```bash
bun run validate
```

## Manual End-To-End Smoke

Create or load a workflow with this shape.

```yaml
name: route-loop-smoke
description: Route-loop smoke workflow
nodes:
  - id: fix
    prompt: 'Make the required fix.'

  - id: review
    depends_on: [fix]
    prompt: 'Review the result and return JSON.'
    output_format:
      type: object
      properties:
        result:
          type: string
      required: [result]

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

  - id: done
    depends_on: [review-router]
    bash: 'echo done'

  - id: escalation
    depends_on: [review-router]
    bash: 'echo escalation'
```

Verify the builder can render and save the workflow.
Verify the run emits `node_routed` events for negative and positive outcomes.
Verify `done` runs on success and `escalation` does not run unless budget is exhausted.
Verify unselected route targets do not appear as skipped work.
