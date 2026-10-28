import { describe, it, expect } from 'bun:test';

import { isEndTurnRequested, planEndTurn } from './end-turn-request';
import type { ToolCallAttention, WorkflowRun } from './schemas/workflow-run';

const call = (streamId: string, raisedAt: string, toolCallId = 'call'): ToolCallAttention => ({
  streamId,
  nodeId: 'ci',
  provider: 'codex',
  toolCallId,
  name: 'command_execution',
  startedAt: '2026-10-18T06:25:58.000Z',
  lastProgressAt: '2026-10-18T06:25:58.000Z',
  raisedAt,
  thresholdMs: 1_800_000,
});
const first = call('a', '2026-10-18T06:55:59.000Z');
const second = call('a', first.raisedAt, 'other-call');
const identity = ({ streamId, toolCallId, raisedAt }: ToolCallAttention) => ({
  streamId,
  toolCallId,
  raisedAt,
});
const run = (
  status: WorkflowRun['status'],
  calls: ToolCallAttention[]
): Pick<WorkflowRun, 'status' | 'metadata'> => ({
  status,
  metadata: { tool_call_attention: calls },
});
const storeWith = (
  metadata: Record<string, unknown>,
  status: WorkflowRun['status'] = 'running'
) => ({
  getWorkflowRun: async () => ({ status, metadata }) as WorkflowRun,
});

describe('planEndTurn', () => {
  it.each(['pending', 'paused', 'completed', 'failed', 'cancelled'] as const)(
    'refuses a %s run even with stalled calls',
    status => {
      expect(planEndTurn(run(status, [first]))).toEqual({ kind: 'refused', reason: 'not_running' });
    }
  );
  it('refuses a running run with nothing stalled', () => {
    expect(planEndTurn(run('running', []))).toEqual({ kind: 'refused', reason: 'nothing_stalled' });
  });
  it.each([null, {}, 'bad', [{ streamId: 'broken' }]])('refuses unreadable attention %j', raw => {
    expect(planEndTurn({ status: 'running', metadata: { tool_call_attention: raw } })).toEqual({
      kind: 'refused',
      reason: 'unreadable_attention',
    });
  });
  it('records every observed occurrence using only shipped attention fields', () => {
    const calls = [first, second, call('b', first.raisedAt)];
    const plan = planEndTurn(run('running', calls));
    expect(plan.kind === 'request' && plan.metadata).toEqual({
      end_turn_request: { stalls: calls.map(identity) },
    });
  });
});

describe('isEndTurnRequested', () => {
  it.each([{}, { stalls: 'bad' }, { stalls: [] }, { stalls: [{}] }, { stallIds: ['old'] }])(
    'rejects malformed requests %j',
    async request => {
      expect(
        await isEndTurnRequested(storeWith({ end_turn_request: request }), 'run', [first])
      ).toBe(false);
    }
  );
  it('does not honor a recorded request after a run pauses', async () => {
    const store = storeWith({ end_turn_request: { stalls: [identity(first)] } }, 'paused');
    expect(await isEndTurnRequested(store, 'run', [first])).toBe(false);
  });
  it('matches any still active occurrence by equality of all three fields', async () => {
    const store = storeWith({ end_turn_request: { stalls: [first, second].map(identity) } });
    for (const stall of [[first], [second], [second, call('new', first.raisedAt)]]) {
      expect(await isEndTurnRequested(store, 'run', stall)).toBe(true);
    }
    for (const stall of [
      [],
      [call('different-stream', first.raisedAt)],
      [call(first.streamId, first.raisedAt, 'different-call')],
      [call(first.streamId, '2026-10-18T06:55:58.000Z')],
      [call(first.streamId, '2026-10-18T06:56:00.000Z')],
    ]) {
      expect(await isEndTurnRequested(store, 'run', stall)).toBe(false);
    }
  });
});
