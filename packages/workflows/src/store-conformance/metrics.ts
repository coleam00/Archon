import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, test } from 'bun:test';
import type { IWorkflowStore } from '../store';
import type { WorkflowStoreHarness } from '../store-conformance';
import { CONFORMANCE_CODEBASE_ID, create } from './fixtures';

const metrics = [
  { name: 'factory.prs_merged', kind: 'count', unit: 'prs', value: 1, subject: null },
];

export function describeMetricRecordsConformance(getHarness: () => WorkflowStoreHarness): void {
  describe('metric records', () => {
    let store: IWorkflowStore;
    beforeEach(() => {
      store = getHarness().store;
    });

    const complete = (runId: string, data: Record<string, unknown>): Promise<void> =>
      store.persistWorkflowEvent({
        workflow_run_id: runId,
        event_type: 'node_completed',
        step_name: 'count',
        data,
      });

    test('returns metric completions with their run identity, in recorded order across runs', async () => {
      const first = await create(store, { workflow_name: 'count-prs' });
      const second = await create(store, { workflow_name: 'count-prs-again' });
      // The earlier completion sits later in its own run's log than the later one does.
      await store.persistWorkflowEvent({
        workflow_run_id: first.id,
        event_type: 'node_started',
        step_name: 'count',
      });
      await complete(first.id, { structured_output: { metrics, other: 'kept out' } });
      await Bun.sleep(2);
      await complete(second.id, { structured_output: { metrics: [] }, node_output: 'secret' });

      const rows = await store.listMetricRecords();
      expect(rows.map(row => [row.runId, row.workflowName, row.nodeId, row.metrics])).toEqual([
        [first.id, 'count-prs', 'count', metrics],
        [second.id, 'count-prs-again', 'count', []],
      ]);
      const [row] = rows;
      expect(Number.isNaN(Date.parse(row?.completedAt ?? ''))).toBe(false);
      const events = await store.listWorkflowEvents(first.id);
      expect(
        events.filter(event => event.event_type === 'node_completed').map(event => event.id)
      ).toEqual([row?.eventId]);
      expect(Object.keys(row ?? {}).sort()).toEqual([
        'codebaseId',
        'completedAt',
        'eventId',
        'metrics',
        'nodeId',
        'nodeType',
        'runId',
        'workflowName',
      ]);
    });

    test('leaves out completions without metrics and other event types', async () => {
      const run = await create(store);
      await complete(run.id, { structured_output: { summary: 'no metrics' } });
      await complete(run.id, { node_output: 'plain text' });
      await store.persistWorkflowEvent({
        workflow_run_id: run.id,
        event_type: 'node_failed',
        step_name: 'count',
        data: { structured_output: { metrics } },
      });
      expect(await store.listMetricRecords()).toEqual([]);
    });

    test('carries the run codebase and the completed node type', async () => {
      const scoped = await create(store, { codebase_id: CONFORMANCE_CODEBASE_ID });
      const other = await create(store);
      await complete(scoped.id, { type: 'loop_group', structured_output: { metrics } });
      await Bun.sleep(2);
      await complete(other.id, { structured_output: { metrics } });
      const rows = await store.listMetricRecords();
      expect(rows.map(row => [row.runId, row.codebaseId, row.nodeType])).toEqual([
        [scoped.id, CONFORMANCE_CODEBASE_ID, 'loop_group'],
        [other.id, null, null],
      ]);
    });
  });

  describe('runs by id', () => {
    let store: IWorkflowStore;
    beforeEach(() => {
      store = getHarness().store;
    });

    test('returns the existing runs with their metadata and leaves out missing ids', async () => {
      const run = await create(store, { metadata: { total_cost_usd: 0.25 } });
      const other = await create(store);
      const runs = await store.getWorkflowRunsByIds([run.id, randomUUID(), other.id, run.id]);
      expect(runs.map(found => [found.id, found.metadata.total_cost_usd]).sort()).toEqual(
        [
          [run.id, 0.25],
          [other.id, undefined],
        ].sort()
      );
      expect(runs.find(found => found.id === run.id)?.started_at).toBeInstanceOf(Date);
    });

    test('finds a run whose id predates dashes, as the store returned it', async () => {
      const legacy = await create(store, { id: randomUUID().replaceAll('-', '') });
      expect((await store.getWorkflowRunsByIds([legacy.id])).map(found => found.id)).toEqual([
        legacy.id,
      ]);
    });

    test('finds runs past the first thousand ids', async () => {
      const first = await create(store);
      const last = await create(store);
      const missing = Array.from({ length: 1000 }, () => randomUUID());
      const runs = await store.getWorkflowRunsByIds([first.id, ...missing, last.id]);
      expect(runs.map(found => found.id).sort()).toEqual([first.id, last.id].sort());
    });
  });
}
