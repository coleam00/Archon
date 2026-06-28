import { describe, expect, test } from 'bun:test';
import type { WorkflowEmitterEvent } from '@archon/workflows/event-emitter';
import { mapWorkflowEvent } from './workflow-bridge';

describe('mapWorkflowEvent', () => {
  test('maps live node_routed events to completed dag_node events with route decision metadata', () => {
    const routeDecision = {
      from: 'review',
      outcome: 'exhausted',
      to: 'escalate',
      condition: "$review.output.approved == '<redacted>'",
      condition_result: false,
      negative_count: 3,
      max_iterations: 2,
      attempt: 3,
      execution_seq: 9,
    } as const;

    const event: WorkflowEmitterEvent = {
      type: 'node_routed',
      runId: 'run-route',
      nodeId: 'review-router',
      nodeName: 'Review Router',
      data: routeDecision,
    };

    const mapped = mapWorkflowEvent(event);

    expect(mapped).not.toBeNull();
    expect(JSON.parse(mapped as string)).toMatchObject({
      type: 'dag_node',
      runId: 'run-route',
      nodeId: 'review-router',
      name: 'Review Router',
      status: 'completed',
      routeDecision,
    });
  });
});
