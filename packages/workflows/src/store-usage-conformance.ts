import { expect, test } from 'bun:test';
import { childOutcomeFromRun } from './dag/child-run';
import { sumReportedCost } from './dag/usage';
import type { IWorkflowStore } from './store';

export function describeWorkflowUsageConformance(getStore: () => IWorkflowStore): void {
  test('unknown exact cost survives metadata updates and child roll-up', async () => {
    const store = getStore();
    const children = [];
    for (const cost of [null, 0.3]) {
      const run = await store.createWorkflowRun({ workflow_name: 'cost', user_message: '' });
      await store.claimPendingWorkflowRun(run.id);
      await store.updateWorkflowRun(run.id, { metadata: { total_cost_usd: 0.2 } });
      await store.updateWorkflowRun(run.id, { metadata: { total_cost_usd: cost } });
      await store.completeWorkflowRun(run.id, { duration_ms: 0 });
      const settled = await store.getWorkflowRun(run.id);
      if (!settled) throw new Error('Missing child run');
      expect(settled.metadata.total_cost_usd).toBe(cost);
      children.push(settled);
    }
    expect(sumReportedCost(children.map(childOutcomeFromRun))).toBeNull();
    const unpriced = children[0];
    await store.updateWorkflowRun(unpriced.id, { metadata: { total_cost_usd: 0 } });
    expect((await store.getWorkflowRun(unpriced.id))?.metadata.total_cost_usd).toBe(0);
  });
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
}
