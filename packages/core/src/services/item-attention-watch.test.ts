// @archon-test-isolated
import { describe, test, expect, mock, beforeEach } from 'bun:test';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import type { RunLiveOwnerWatchResult } from './run-live-owner';

/** The rows the waiters read; mutating one simulates another process committing a change. */
const rows = new Map<string, WorkflowRun>();
const store = { getWorkflowRun: (id: string) => Promise.resolve(rows.get(id) ?? null) };
/** The item's runs as a re-read returns them, in start order. */
let itemRunIds: string[] = [];
const reread = (): Promise<WorkflowRun[]> =>
  Promise.resolve(itemRunIds.flatMap(id => rows.get(id) ?? []));

const realRunLiveOwner = { ...(await import('./run-live-owner')) };
mock.module('./run-live-owner', () => ({
  ...realRunLiveOwner,
  watchRunLiveOwner: (): Promise<RunLiveOwnerWatchResult> =>
    Promise.resolve({ kind: 'unreachable' }),
}));

const { waitForItemAttention } = await import('./item-attention-watch');

function putRun(id: string, over: Partial<WorkflowRun> = {}): WorkflowRun {
  const run = {
    id,
    workflow_name: 'demo',
    conversation_id: 'conv-1',
    parent_conversation_id: null,
    codebase_id: null,
    status: 'running',
    outcome: null,
    user_message: 'go',
    metadata: {},
    started_at: new Date('2026-11-16T10:00:00.000Z'),
    completed_at: null,
    last_activity_at: null,
    working_path: null,
    user_id: null,
    parent_run_id: null,
    adopted_from_run_id: null,
    output_root: null,
    checkout_baseline: null,
    ...over,
  } as WorkflowRun;
  rows.set(id, run);
  if (!itemRunIds.includes(id)) itemRunIds.push(id);
  return run;
}

const waitOnItem = (deadlineMs = 3000) =>
  waitForItemAttention(store, [...(itemRunIds.map(id => rows.get(id)) as WorkflowRun[])], reread, {
    pollIntervalMs: 5,
    deadlineMs,
  });

beforeEach(() => {
  rows.clear();
  itemRunIds = [];
});

describe('waitForItemAttention', () => {
  test('a run that ended before the call is history; the wait returns when a live run ends', async () => {
    putRun('old', { status: 'completed', completed_at: new Date() });
    const live = putRun('live');

    const waiting = waitOnItem();
    await Bun.sleep(30);
    live.status = 'failed';

    const results = await waiting;
    expect(results).toEqual([
      {
        runId: 'live',
        result: {
          kind: 'attention',
          attention: expect.objectContaining({ kind: 'terminal', runId: 'live', status: 'failed' }),
        },
      },
    ]);
  });

  test('a run already paused at a gate at call time is reported at once', async () => {
    putRun('gated', {
      status: 'paused',
      metadata: { approval: { nodeId: 'review', message: 'Approve the plan.' } },
    });
    putRun('busy');

    const results = await waitOnItem();
    expect(results).toHaveLength(1);
    expect(results[0]?.runId).toBe('gated');
    expect(results[0]?.result).toMatchObject({
      kind: 'attention',
      attention: { kind: 'awaiting_response', respondTo: { runId: 'gated', nodeId: 'review' } },
    });
  });

  test('a run that starts on the item during the wait is watched and reported', async () => {
    putRun('first');
    const waiting = waitOnItem();
    await Bun.sleep(20);
    const late = putRun('late');
    await Bun.sleep(20);
    late.status = 'paused';
    late.metadata = { approval: { nodeId: 'gate', message: 'Go?' } };

    const results = await waiting;
    expect(results.map(r => r.runId)).toEqual(['late']);
  });

  test('runs that end together are all reported, in start order', async () => {
    const a = putRun('a');
    const b = putRun('b');
    const waiting = waitOnItem();
    await Bun.sleep(20);
    b.status = 'completed';
    a.status = 'cancelled';

    const results = await waiting;
    expect(results.map(r => [r.runId, r.result.kind])).toEqual([
      ['a', 'attention'],
      ['b', 'attention'],
    ]);
  });

  test('at the deadline every watched run reports deadline with its status', async () => {
    putRun('a');
    putRun('b', { status: 'pending' });

    const results = await waitOnItem(40);
    expect(results).toEqual([
      { runId: 'a', result: { kind: 'deadline', runId: 'a', observedStatus: 'running' } },
      { runId: 'b', result: { kind: 'deadline', runId: 'b', observedStatus: 'pending' } },
    ]);
  });

  test('a failed re-read stops every watch and is thrown', async () => {
    putRun('a');
    await expect(
      waitForItemAttention(
        store,
        [rows.get('a') as WorkflowRun],
        () => Promise.reject(new Error('item unreadable')),
        { pollIntervalMs: 5 }
      )
    ).rejects.toThrow('item unreadable');
  });
});
