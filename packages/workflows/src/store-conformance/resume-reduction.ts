import { beforeEach, describe, expect, test } from 'bun:test';
import type { IWorkflowStore } from '../store';
import { finishNodeExecution, newNodeInvocation, startNodeExecution } from '../node-execution';
import { serializeNodeStateRecord } from '../node-record-serialization';
import { runBudgetWorkUnitEvent } from '../run-budget';
import type { WorkflowStoreHarness } from '../store-conformance';
import { create } from './fixtures';

export function describeResumeReductionConformance(getHarness: () => WorkflowStoreHarness): void {
  describe('resume reduction', () => {
    let store: IWorkflowStore;
    beforeEach(() => {
      store = getHarness().store;
    });

    test('resume reduction preserves durable fan-out, starts and usage from failed and deferred attempts', async () => {
      const run = await create(store);
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
    test('resume reduction keeps the failure of a node whose latest record is node_failed', async () => {
      const run = await create(store);
      const rows = [
        {
          event_type: 'node_failed' as const,
          step_name: 'still-failed',
          data: { error: 'first', failure_kind: 'config' },
        },
        { event_type: 'node_failed' as const, step_name: 'recovered', data: { error: 'old' } },
        { event_type: 'node_started' as const, step_name: 'recovered', data: {} },
        {
          event_type: 'node_completed' as const,
          step_name: 'recovered',
          data: { node_output: 'ok' },
        },
      ];
      for (const row of rows) await store.persistWorkflowEvent({ ...row, workflow_run_id: run.id });
      const snapshot = await store.getDagResumeSnapshot(run.id);
      expect(snapshot.failedNodes).toEqual(
        new Map([['still-failed', { error: 'first', failureKind: 'config' }]])
      );
    });
    test('resume reduction rebuilds run-budget work units and spend, failing closed on unknown cost', async () => {
      const run = await create(store);
      const agentStart = (path: string) =>
        startNodeExecution({
          runId: run.id,
          path,
          node: { id: path, kind: 'agent', source: { kind: 'inline', prompt: 'p' } },
          invocation: newNodeInvocation(),
          provider: 'claude',
        });
      const priced = agentStart('priced');
      const unpriced = agentStart('unpriced');
      const open = agentStart('open');
      const rows = [
        runBudgetWorkUnitEvent(run.id, 'priced'),
        serializeNodeStateRecord(priced),
        serializeNodeStateRecord(
          finishNodeExecution(priced, { status: 'completed' }, { costUsd: 0.25 })
        ),
        runBudgetWorkUnitEvent(run.id, 'unpriced'),
        serializeNodeStateRecord(unpriced),
        serializeNodeStateRecord(finishNodeExecution(unpriced, { status: 'failed', error: 'x' })),
        serializeNodeStateRecord(open),
      ];
      for (const row of rows) await store.persistWorkflowEvent(row);
      const snapshot = await store.getDagResumeSnapshot(run.id);
      expect(snapshot.budget).toEqual({
        workUnits: 2,
        spendUsd: 0.25,
        costUnavailable: { path: 'unpriced', reason: 'unknown' },
      });

      // An attempt that started and never finished never reported its cost.
      const interrupted = await create(store);
      const lone = startNodeExecution({
        runId: interrupted.id,
        path: 'lone',
        node: { id: 'lone', kind: 'agent', source: { kind: 'inline', prompt: 'p' } },
        invocation: newNodeInvocation(),
        provider: 'claude',
      });
      await store.persistWorkflowEvent(runBudgetWorkUnitEvent(interrupted.id, 'lone'));
      await store.persistWorkflowEvent(serializeNodeStateRecord(lone));
      expect((await store.getDagResumeSnapshot(interrupted.id)).budget).toEqual({
        workUnits: 1,
        spendUsd: 0,
        costUnavailable: { path: 'lone', reason: 'interrupted' },
      });
    });
  });
}
