# Contract: API And Generated Types

## Workflow Definition APIs

Existing workflow definition endpoints must accept and return `route_loop` nodes after schema support is added.
The OpenAPI `DagNode` schema must include the route-loop shape and retain existing command, prompt, bash, script, loop, approval, and cancel node shapes.

## Run Detail APIs

Run detail responses must return:

- `node_routed` events.
- Route-loop node outputs.
- Latest attempt summaries for route-loop and rerun-path nodes.
- Historical events for prior attempts.
- Retry ineligibility for route-loop controller nodes.

## Event Projection

The API projection must not reclassify `node_routed` as unknown text.
It must preserve snake_case route metadata fields.
It must preserve old attempt events while showing latest attempt state in run summaries.

## Generated Web Types

After server schema changes, regenerate `packages/web/src/lib/api.generated.d.ts`.
Web code must import route-loop types from `@/lib/api` rather than `@archon/workflows`.

## Error Behavior

Invalid route-loop workflow definitions must return validation errors before execution.
Route condition runtime failures must surface as workflow node failures.
Exhausted route outcomes are completed control-flow outcomes and must not be API failures by themselves.
Route-loop controller nodes must not be directly retryable through API retry surfaces.

## Security

APIs must return the safe condition string and must not expose raw comparison literals that can carry secrets, prompts, user message content, PII, git remotes, file paths, or unsafe raw errors.
