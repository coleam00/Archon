import { describe, expect, test } from 'bun:test';
import type { NodeTransitionEvent } from './event';
import { deriveNodeStatuses, type WorkflowGraphNode } from './workflow-graph';

const node: WorkflowGraphNode = {
  id: 'outer.review',
  dependsOn: [],
  kind: 'prompt',
};

function transition(
  value: NodeTransitionEvent['transition'],
  timestamp: string
): NodeTransitionEvent {
  return {
    id: `event-${value}`,
    runId: 'run-1',
    kind: 'node_transition',
    timestamp,
    nodeId: 'outer.review',
    nodeName: 'Review changes',
    transition: value,
    durationMs: null,
    skipReason: null,
    skipExpr: null,
    outputPreview: null,
    costUsd: null,
    stopReason: null,
    numTurns: null,
  };
}

describe('deriveNodeStatuses — provider capacity', () => {
  test('keys namespaced nodes by nodeId and returns queued nodes to running on acquisition', () => {
    const queued = transition('queued', '2026-08-25T10:00:00Z');
    expect(deriveNodeStatuses([node], [queued])[0]?.status).toBe('queued');

    const acquired = transition('started', '2026-08-25T10:00:01Z');
    expect(deriveNodeStatuses([node], [queued, acquired])[0]?.status).toBe('running');
  });
});
