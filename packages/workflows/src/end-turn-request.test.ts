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
    expect(planEndTurn(run('paused', [call('a', '2026-10-18T06:55:59.000Z')]))).toEqual({
      kind: 'refused',
      reason: 'not_running',
    });
  });

  it('refuses a running run with nothing stalled', () => {
    expect(planEndTurn(run('running', []))).toEqual({ kind: 'refused', reason: 'nothing_stalled' });
  });

  it('names every stalled stream once', () => {
    const plan = planEndTurn(
      run('running', [
        call('a', '2026-10-18T06:55:59.000Z'),
        call('a', '2026-10-18T06:56:10.000Z'),
        call('b', '2026-10-18T07:00:00.000Z'),
      ]),
      new Date('2026-10-18T08:00:00.000Z')
    );
    expect(plan.kind === 'request' && plan.metadata).toEqual({
      end_turn_request: { streamIds: ['a', 'b'], requestedAt: '2026-10-18T08:00:00.000Z' },
    });
  });
});

describe('isEndTurnRequested', () => {
  const request = {
    end_turn_request: { streamIds: ['a'], requestedAt: '2026-10-18T08:00:00.000Z' },
  };

  it('ends the stall the operator saw', async () => {
    expect(
      await isEndTurnRequested(storeWith(request), 'run', {
        streamId: 'a',
        raisedAt: '2026-10-18T06:55:59.000Z',
      })
    ).toBe(true);
  });

  it('leaves a stall raised after the request, and other streams, running', async () => {
    expect(
      await isEndTurnRequested(storeWith(request), 'run', {
        streamId: 'a',
        raisedAt: '2026-10-18T08:30:00.000Z',
      })
    ).toBe(false);
    expect(
      await isEndTurnRequested(storeWith(request), 'run', {
        streamId: 'b',
        raisedAt: '2026-10-18T06:55:59.000Z',
      })
    ).toBe(false);
  });
});
