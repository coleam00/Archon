import { describe, expect, it } from 'bun:test';

import type { WorkflowEventResponse } from './api';
import {
  deriveCurrentlyExecutingNode,
  deriveDagNodesFromEvents,
  deriveNodeStartTimes,
} from './workflow-event-derivations';

function makeEvent(
  overrides: Partial<WorkflowEventResponse> &
    Pick<WorkflowEventResponse, 'event_type' | 'created_at'>
): WorkflowEventResponse {
  return {
    id: `${overrides.event_type}-${overrides.created_at}`,
    workflow_run_id: 'run-1',
    step_index: null,
    step_name: null,
    data: {},
    ...overrides,
  };
}

describe('deriveDagNodesFromEvents', () => {
  it('creates a running loop node from loop iteration events without node_started', () => {
    const events: WorkflowEventResponse[] = [
      makeEvent({
        event_type: 'loop_iteration_started',
        step_name: 'explore',
        created_at: '2026-04-19T15:00:00.000Z',
        data: { iteration: 1, maxIterations: 15, nodeId: 'explore' },
      }),
      makeEvent({
        event_type: 'loop_iteration_completed',
        step_name: 'explore',
        created_at: '2026-04-19T15:01:00.000Z',
        data: { iteration: 1, duration: 60000, completionDetected: false, nodeId: 'explore' },
      }),
    ];

    expect(deriveDagNodesFromEvents(events)).toEqual([
      {
        nodeId: 'explore',
        name: 'explore',
        status: 'running',
        currentIteration: 1,
        maxIterations: 15,
        iterations: [{ iteration: 1, status: 'completed', duration: 60000 }],
      },
    ]);
  });

  it('lets node_completed override synthetic running loop state', () => {
    const events: WorkflowEventResponse[] = [
      makeEvent({
        event_type: 'loop_iteration_started',
        step_name: 'explore',
        created_at: '2026-04-19T15:00:00.000Z',
        data: { iteration: 2, maxIterations: 15, nodeId: 'explore' },
      }),
      makeEvent({
        event_type: 'node_completed',
        step_name: 'explore',
        created_at: '2026-04-19T15:02:00.000Z',
        data: { duration_ms: 120000, node_output: 'done' },
      }),
    ];

    expect(deriveDagNodesFromEvents(events)).toEqual([
      {
        nodeId: 'explore',
        name: 'explore',
        status: 'completed',
        duration: 120000,
        currentIteration: 2,
        maxIterations: 15,
        iterations: [{ iteration: 2, status: 'running', duration: undefined }],
      },
    ]);
  });
});

describe('deriveCurrentlyExecutingNode', () => {
  it('detects an active loop iteration without node_started', () => {
    const events: WorkflowEventResponse[] = [
      makeEvent({
        event_type: 'loop_iteration_started',
        step_name: 'explore',
        created_at: '2026-04-19T15:15:25.000Z',
        data: { iteration: 2, maxIterations: 15, nodeId: 'explore' },
      }),
    ];

    expect(deriveCurrentlyExecutingNode(events, 'running')).toEqual({
      nodeName: 'explore',
      startedAt: new Date('2026-04-19T15:15:25.000Z').getTime(),
    });
  });
});

describe('deriveNodeStartTimes', () => {
  it('uses first loop_iteration_started when node_started is missing', () => {
    const events: WorkflowEventResponse[] = [
      makeEvent({
        event_type: 'loop_iteration_started',
        step_name: 'explore',
        created_at: '2026-04-19T15:15:25.000Z',
        data: { iteration: 2, maxIterations: 15, nodeId: 'explore' },
      }),
      makeEvent({
        event_type: 'loop_iteration_started',
        step_name: 'explore',
        created_at: '2026-04-19T15:20:25.000Z',
        data: { iteration: 3, maxIterations: 15, nodeId: 'explore' },
      }),
    ];

    expect(deriveNodeStartTimes(events).get('explore')).toBe(
      new Date('2026-04-19T15:15:25.000Z').getTime()
    );
  });
});
