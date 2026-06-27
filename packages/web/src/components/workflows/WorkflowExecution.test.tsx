import { describe, expect, test } from 'bun:test';

import { buildWorkflowDagNodeStates } from './WorkflowExecution';
import type { WorkflowEventResponse } from '@/lib/api';

function workflowEvent(overrides: Partial<WorkflowEventResponse>): WorkflowEventResponse {
  return {
    id: 'event-1',
    workflow_run_id: 'run-1',
    event_type: 'node_started',
    step_index: null,
    step_name: null,
    data: {},
    created_at: '2026-06-21T00:00:00.000Z',
    ...overrides,
  };
}

describe('buildWorkflowDagNodeStates', () => {
  test('enriches server-projected nodeStates with loop iteration events', () => {
    const nodes = buildWorkflowDagNodeStates(
      [
        {
          nodeId: 'loop-node',
          name: 'Loop',
          status: 'completed',
          retryEpoch: 0,
        },
      ],
      [
        workflowEvent({
          id: 'event-1',
          event_type: 'loop_iteration_started',
          step_name: 'loop-node',
          data: { iteration: 1, maxIterations: 2 },
        }),
        workflowEvent({
          id: 'event-2',
          event_type: 'loop_iteration_completed',
          step_name: 'loop-node',
          data: { iteration: 1, maxIterations: 2, duration_ms: 1500 },
        }),
      ]
    );

    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({
      nodeId: 'loop-node',
      status: 'completed',
      currentIteration: 1,
      maxIterations: 2,
      iterations: [{ iteration: 1, status: 'completed', duration: 1500 }],
    });
  });

  test('projects node_routed events as completed route-loop decisions', () => {
    const routeDecision = {
      from: 'review',
      outcome: 'negative',
      to: 'fix',
      condition: "$review.output.approved == '<redacted>'",
      condition_result: false,
      negative_count: 1,
      max_iterations: 2,
      attempt: 1,
      execution_seq: 4,
    };

    const nodes = buildWorkflowDagNodeStates(undefined, [
      workflowEvent({
        id: 'event-route',
        event_type: 'node_routed',
        step_name: 'review-router',
        data: routeDecision,
      }),
    ]);

    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({
      nodeId: 'review-router',
      name: 'review-router',
      status: 'completed',
      routeDecision,
    });
  });
});
