import { describe, it, expect } from 'bun:test';

import { isEndTurnRequested, planEndTurn } from './end-turn-request';
import type { ToolCallAttention, WorkflowRun } from './schemas/workflow-run';

const call = (streamId: string, raisedAt: string): ToolCallAttention => ({
  streamId,
  nodeId: 'ci',
  provider: 'codex',
  toolCallId: `subtask:${streamId}`,
  name: 'command_execution',
  startedAt: '2026-10-18T06:25:58.000Z',
  lastProgressAt: '2026-10-18T06:25:58.000Z',
  raisedAt,
  thresholdMs: 1_800_000,
});

const run = (
  status: WorkflowRun['status'],
  calls: ToolCallAttention[]
): Pick<WorkflowRun, 'status' | 'metadata'> => ({
  status,
  metadata: calls.length ? { tool_call_attention: calls } : {},
});

const storeWith = (metadata: Record<string, unknown>) => ({
  getWorkflowRun: async () => ({ metadata }) as WorkflowRun,
});

describe('planEndTurn', () => {
  it('refuses a run that is not running', () => {
    expect(planEndTurn(run('completed', [call('a', '2026-10-18T06:55:59.000Z')]))).toEqual({
      kind: 'refused',
      reason: 'not_running',
    });
  });

  it('refuses a running run with nothing stalled', () => {
    expect(planEndTurn(run('running', []))).toEqual({ kind: 'refused', reason: 'nothing_stalled' });
  });

  it('accepts a paused run with a live stalled sibling', () => {
    expect(planEndTurn(run('paused', [call('a', '2026-10-18T06:55:59.000Z')])).kind).toBe(
      'request'
    );
  });

  it.each([null, {}, 'bad', [{ streamId: 'broken' }]])('refuses unreadable attention %j', raw => {
    expect(planEndTurn({ status: 'running', metadata: { tool_call_attention: raw } })).toEqual({
      kind: 'refused',
      reason: 'unreadable_attention',
    });
  });

  it('names every stalled stream once', () => {
    const plan = planEndTurn(
      run('running', [
        call('a', '2026-10-18T06:55:59.000Z'),
        call('a', '2026-10-18T06:56:10.000Z'),
        call('b', '2026-10-18T07:00:00.000Z'),
      ])
    );
    expect(plan.kind === 'request' && plan.metadata).toEqual({
      end_turn_request: {
        stalls: { a: '2026-10-18T06:56:10.000Z', b: '2026-10-18T07:00:00.000Z' },
      },
    });
  });
});

describe('isEndTurnRequested', () => {
  it.each([{}, { stalls: { a: 'bad' } }, { stalls: [] }])(
    'rejects malformed persisted requests %j',
    async request => {
      expect(
        await isEndTurnRequested(storeWith({ end_turn_request: request }), 'run', {
          streamId: 'a',
          raisedAt: '2026-10-18T06:55:59.000Z',
        })
      ).toBe(false);
    }
  );

  it('matches only the observed stall', async () => {
    const plan = planEndTurn(run('running', [call('a', '2026-10-18T06:55:59.000Z')]));
    if (plan.kind !== 'request') throw new Error('expected a request');
    const store = storeWith(plan.metadata);
    expect(
      await isEndTurnRequested(store, 'run', {
        streamId: 'a',
        raisedAt: '2026-10-18T06:55:59.000Z',
      })
    ).toBe(true);
    expect(
      await isEndTurnRequested(store, 'run', {
        streamId: 'a',
        raisedAt: '2026-10-18T07:00:00.000Z',
      })
    ).toBe(false);
    expect(
      await isEndTurnRequested(store, 'run', {
        streamId: 'b',
        raisedAt: '2026-10-18T06:55:59.000Z',
      })
    ).toBe(false);
  });

  it('accepts previously persisted requests with a requester timestamp', async () => {
    const store = storeWith({
      end_turn_request: {
        stalls: { a: '2026-10-18T06:55:59.000Z' },
        requestedAt: '2026-10-18T05:00:00.000Z',
      },
    });
    expect(
      await isEndTurnRequested(store, 'run', {
        streamId: 'a',
        raisedAt: '2026-10-18T06:55:59.000Z',
      })
    ).toBe(true);
  });
});
