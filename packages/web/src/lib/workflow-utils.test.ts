import { describe, test, expect } from 'bun:test';
import { isTerminalStatus, settleRunningDagNodesForTerminalStatus } from './workflow-utils';
import type { DagNodeState } from './types';

describe('isTerminalStatus', () => {
  test('completed is terminal', () => {
    expect(isTerminalStatus('completed')).toBe(true);
  });

  test('failed is terminal', () => {
    expect(isTerminalStatus('failed')).toBe(true);
  });

  test('cancelled is terminal', () => {
    expect(isTerminalStatus('cancelled')).toBe(true);
  });

  test('running is not terminal', () => {
    expect(isTerminalStatus('running')).toBe(false);
  });

  test('pending is not terminal', () => {
    expect(isTerminalStatus('pending')).toBe(false);
  });

  test('undefined is not terminal', () => {
    expect(isTerminalStatus(undefined)).toBe(false);
  });

  test('empty string is not terminal', () => {
    expect(isTerminalStatus('')).toBe(false);
  });
});

describe('settleRunningDagNodesForTerminalStatus', () => {
  test('marks running nodes as failed for cancelled workflows', () => {
    const nodes: DagNodeState[] = [
      { nodeId: 'prepare', name: 'prepare', status: 'completed' },
      { nodeId: 'dev-story', name: 'dev-story', status: 'running' },
    ];

    const settled = settleRunningDagNodesForTerminalStatus('cancelled', nodes);

    expect(settled).toEqual([
      { nodeId: 'prepare', name: 'prepare', status: 'completed' },
      {
        nodeId: 'dev-story',
        name: 'dev-story',
        status: 'failed',
        error: 'Cancelled by user',
      },
    ]);
  });

  test('preserves an existing error when settling failed workflows', () => {
    const nodes: DagNodeState[] = [
      { nodeId: 'test', name: 'test', status: 'running', error: 'Process exited' },
    ];

    const settled = settleRunningDagNodesForTerminalStatus('failed', nodes);

    expect(settled[0]).toEqual({
      nodeId: 'test',
      name: 'test',
      status: 'failed',
      error: 'Process exited',
    });
  });

  test('leaves non-terminal workflows untouched', () => {
    const nodes: DagNodeState[] = [{ nodeId: 'dev-story', name: 'dev-story', status: 'running' }];

    const settled = settleRunningDagNodesForTerminalStatus('running', nodes);

    expect(settled).toBe(nodes);
  });
});
