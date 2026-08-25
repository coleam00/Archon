import { describe, expect, test } from 'bun:test';
import type { WorkflowEventResponse } from '@/lib/api';
import { findCurrentlyExecuting, foldPersistedDagNodes } from './WorkflowExecution';

function event(
  eventType: string,
  stepName: string | null,
  data: Record<string, unknown> = {}
): WorkflowEventResponse {
  return {
    id: crypto.randomUUID(),
    workflow_run_id: 'run-1',
    step_index: null,
    step_name: stepName,
    event_type: eventType,
    data,
    created_at: new Date().toISOString(),
  };
}

describe('foldPersistedDagNodes', () => {
  test('keeps provider queue transitions on the namespaced persisted node', () => {
    const nodes = foldPersistedDagNodes([
      event('node_started', 'outer.review'),
      event('provider_slot_queued', 'outer.review', {
        node_id: 'review',
        node_name: 'Review changes',
      }),
      event('provider_slot_acquired', 'outer.review', {
        node_id: 'review',
        node_name: 'Review changes',
      }),
    ]);

    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({
      nodeId: 'outer.review',
      name: 'Review changes',
      status: 'running',
    });
  });

  test('falls back to legacy provider node_id when step_name is absent', () => {
    const nodes = foldPersistedDagNodes([
      event('provider_slot_queued', null, { node_id: 'review', node_name: 'Review changes' }),
    ]);

    expect(nodes).toEqual([
      expect.objectContaining({ nodeId: 'review', name: 'Review changes', status: 'queued' }),
    ]);
  });

  test('ignores audit-only node events instead of turning them into skipped transitions', () => {
    const nodes = foldPersistedDagNodes([
      event('node_always_run_reset', 'review'),
      event('node_started', 'review'),
    ]);

    expect(nodes).toEqual([expect.objectContaining({ nodeId: 'review', status: 'running' })]);
  });
});

describe('findCurrentlyExecuting', () => {
  test('removes queued calls and restores them only when provider capacity is acquired', () => {
    const started = event('node_started', 'review');
    const queued = event('provider_slot_queued', 'review', { node_name: 'Review changes' });
    const acquired = event('provider_slot_acquired', 'review', { node_name: 'Review changes' });

    expect(findCurrentlyExecuting([started, queued], 'running')).toBeNull();
    expect(findCurrentlyExecuting([started, queued, acquired], 'running')).toEqual({
      nodeName: 'Review changes',
      startedAt: new Date(acquired.created_at).getTime(),
    });
  });
});
