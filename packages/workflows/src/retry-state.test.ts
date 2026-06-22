import { describe, expect, test } from 'bun:test';
import {
  getLatestEffectiveNodeState,
  getRetryInvalidatedNodeIds,
  projectLatestEffectiveNodeStates,
} from './retry-state';
import type { DagNode } from './schemas';

describe('retry DAG state projection', () => {
  test('computes target plus current-DAG descendants for retry invalidation', () => {
    const nodes = [
      { id: 'a', prompt: 'A' },
      { id: 'b', prompt: 'B', depends_on: ['a'] },
      { id: 'c', prompt: 'C', depends_on: ['b'] },
      { id: 'sibling', prompt: 'S', depends_on: ['a'] },
    ] satisfies DagNode[];

    expect(getRetryInvalidatedNodeIds(nodes, 'b')).toEqual(['b', 'c']);
  });

  test('preserves upstream and sibling completed outputs from earlier retry epochs', () => {
    const states = projectLatestEffectiveNodeStates([
      { event_type: 'node_completed', step_name: 'a', data: { node_output: 'A0' } },
      { event_type: 'node_completed', step_name: 'sibling', data: { node_output: 'S0' } },
      {
        event_type: 'node_retry_requested',
        data: { retry_epoch: 1, invalidated_node_ids: ['b', 'c'] },
      },
    ]);

    expect(states.get('a')?.state).toBe('completed');
    expect(states.get('a')?.output).toBe('A0');
    expect(states.get('sibling')?.state).toBe('completed');
    expect(states.get('b')?.state).toBe('pending');
  });

  test('preserves parallel sibling branch while invalidating target branch descendants', () => {
    const nodes = [
      { id: 'root', prompt: 'root' },
      { id: 'left', prompt: 'left', depends_on: ['root'] },
      { id: 'left-child', prompt: 'left child', depends_on: ['left'] },
      { id: 'right', prompt: 'right', depends_on: ['root'] },
      { id: 'join', prompt: 'join', depends_on: ['left-child', 'right'] },
    ] satisfies DagNode[];

    const invalidatedNodeIds = getRetryInvalidatedNodeIds(nodes, 'left');
    const states = projectLatestEffectiveNodeStates([
      { event_type: 'node_completed', step_name: 'root', data: { node_output: 'root-output' } },
      { event_type: 'node_completed', step_name: 'right', data: { node_output: 'right-output' } },
      {
        event_type: 'node_retry_requested',
        data: { retry_epoch: 1, invalidated_node_ids: invalidatedNodeIds },
      },
    ]);

    expect(invalidatedNodeIds).toEqual(['left', 'left-child', 'join']);
    expect(states.get('root')).toMatchObject({ state: 'completed', output: 'root-output' });
    expect(states.get('right')).toMatchObject({ state: 'completed', output: 'right-output' });
    expect(states.get('left')).toMatchObject({ state: 'pending', retry_epoch: 1 });
    expect(states.get('left-child')).toMatchObject({ state: 'pending', retry_epoch: 1 });
    expect(states.get('join')).toMatchObject({ state: 'pending', retry_epoch: 1 });
  });

  test('treats skipped downstream nodes as latest effective skipped state', () => {
    const state = getLatestEffectiveNodeState(
      [
        {
          event_type: 'node_skipped',
          step_name: 'c',
          data: { retry_epoch: 1, reason: 'dependency_failed' },
        },
      ],
      'c'
    );

    expect(state).toMatchObject({ state: 'skipped', retry_epoch: 1, reason: 'dependency_failed' });
  });

  test('keeps skipped downstream nodes ineligible while failed ancestor remains the retry target', () => {
    const states = projectLatestEffectiveNodeStates([
      {
        event_type: 'node_failed',
        step_name: 'build',
        data: { error: 'compiler failed' },
      },
      {
        event_type: 'node_skipped',
        step_name: 'test',
        data: { reason: 'dependency_failed' },
      },
    ]);

    expect(states.get('build')).toMatchObject({ state: 'failed', error: 'compiler failed' });
    expect(states.get('test')).toMatchObject({ state: 'skipped', reason: 'dependency_failed' });
  });

  test('uses latest effective node state when older epochs contain stale failures', () => {
    const state = getLatestEffectiveNodeState(
      [
        { event_type: 'node_failed', step_name: 'b', data: { error: 'old failure' } },
        {
          event_type: 'node_retry_requested',
          data: { retry_epoch: 1, invalidated_node_ids: ['b'] },
        },
        {
          event_type: 'node_completed',
          step_name: 'b',
          data: { retry_epoch: 1, node_output: 'fixed' },
        },
      ],
      'b'
    );

    expect(state).toMatchObject({ state: 'completed', retry_epoch: 1, output: 'fixed' });
  });
});
