import { expect, test } from 'bun:test';
import type { IWorkflowStore } from '../store';

export function describeRunUsageConformance(getStore: () => IWorkflowStore): void {
  test('resume reduction preserves durable fan-out, starts and usage from failed and deferred attempts', async () => {
    const store = getStore();
    const run = await store.createWorkflowRun({
      workflow_name: 'conformance',
      user_message: 'test',
    });
    const snapshots = [{ ordinal: 0, identity: 'one', item: 1, inputs: { value: 1 } }];
    const rows = [
      {
        event_type: 'node_completed' as const,
        step_name: 'success',
        data: {
          node_output: 'ok',
          structured_output: { ok: true },
          tokens: { input: 2, output: 3 },
          cost_usd: 0.25,
        },
      },
      {
        event_type: 'node_skipped_prior_success' as const,
        step_name: 'success',
        data: {
          node_output: 'ok',
          structured_output: { ok: true },
          tokens: { input: 2, output: 3 },
          cost_usd: 0.25,
        },
      },
      {
        event_type: 'node_completed' as const,
        step_name: 'invalidated',
        data: { node_output: 'stale' },
      },
      { event_type: 'node_prior_cache_invalidated' as const, step_name: 'invalidated', data: {} },
      { event_type: 'node_started' as const, step_name: 'unfinished', data: {} },
      {
        event_type: 'node_failed' as const,
        step_name: 'failed',
        data: { error: 'boom', tokens: { input: 5, output: 7 }, cost_usd: 0.5 },
      },
      {
        event_type: 'fan_out_instances' as const,
        step_name: 'fan',
        data: { instances: snapshots },
      },
      { event_type: 'fan_out_instances' as const, step_name: 'fan', data: { instances: [] } },
      // Deferred spend is accounting only: it must neither clear reusable output nor
      // resolve an unfinished start.
      {
        event_type: 'node_deferred_usage' as const,
        step_name: 'success',
        data: { accounting: 'node', tokens: { input: 1, output: 1 }, cost_usd: 0.125 },
      },
      {
        event_type: 'node_deferred_usage' as const,
        step_name: 'unfinished',
        data: { accounting: 'node', tokens: { input: 1, output: 1 }, cost_usd: 0.125 },
      },
    ];
    for (const row of rows) await store.persistWorkflowEvent({ ...row, workflow_run_id: run.id });
    const snapshot = await store.getDagResumeSnapshot(run.id);
    expect(snapshot.completedNodeOutputs).toEqual(
      new Map([['success', { output: 'ok', structuredOutput: { ok: true } }]])
    );
    expect(snapshot.fanOutSnapshots).toEqual(new Map([['fan', snapshots]]));
    expect(snapshot.unresolvedNodeStarts).toEqual(new Set(['unfinished']));
    expect(snapshot.tokens).toMatchObject({ input: 9, output: 12 });
    expect(snapshot.costUsd).toBe(1);
  });
  test('incomplete historical cost and the positive run marker survive metadata updates and resume', async () => {
    const store = getStore();
    const pending = await store.createWorkflowRun({
      workflow_name: 'conformance',
      user_message: 'test',
    });
    const run = await store.claimPendingWorkflowRun(pending.id);
    if (!run) throw new Error('Run was not claimed');
    expect((await store.getWorkflowRun(run.id))?.metadata).not.toHaveProperty(
      'total_cost_incomplete'
    );
    await store.persistWorkflowEvent({
      workflow_run_id: run.id,
      step_name: 'old',
      event_type: 'node_completed',
      data: { type: 'agent', node_output: 'Old.' },
    });
    await store.persistWorkflowEvent({
      workflow_run_id: run.id,
      step_name: 'new',
      event_type: 'node_completed',
      data: { type: 'agent', cost_usd: 0.2, node_output: 'New.' },
    });
    const snapshot = await store.getDagResumeSnapshot(run.id);
    expect(snapshot).toMatchObject({ costUsd: 0.2, costIncomplete: true });
    await store.updateWorkflowRun(run.id, {
      metadata: { total_cost_usd: snapshot.costUsd, total_cost_incomplete: true },
    });
    await store.pauseWorkflowRun(run.id, { nodeId: 'gate', message: 'Review.' });
    await store.updateWorkflowRun(run.id, { metadata: { unrelated: 'kept' } });
    await store.resumeWorkflowRun(run.id);
    expect((await store.getWorkflowRun(run.id))?.metadata).toMatchObject({
      total_cost_usd: 0.2,
      total_cost_incomplete: true,
      unrelated: 'kept',
    });
    expect(await store.getDagResumeSnapshot(run.id)).toMatchObject({
      costUsd: 0.2,
      costIncomplete: true,
    });
  });
}
