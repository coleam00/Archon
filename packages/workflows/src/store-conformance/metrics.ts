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

      const rows = await store.listMetricRecords({});
      expect(rows.map(row => [row.runId, row.workflowName, row.nodeId, row.metrics])).toEqual([
        [first.id, 'count-prs', 'count', metrics],
        [second.id, 'count-prs-again', 'count', []],
      ]);
      const [row] = rows;
      expect(row?.runStartedAt.getTime()).toBe(first.started_at.getTime());
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
        'runId',
        'runStartedAt',
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
      expect(await store.listMetricRecords({})).toEqual([]);
    });

    test('codebaseId filters by the run codebase', async () => {
      const scoped = await create(store, { codebase_id: CONFORMANCE_CODEBASE_ID });
      const other = await create(store);
      await complete(scoped.id, { structured_output: { metrics } });
      await complete(other.id, { structured_output: { metrics } });
      const rows = await store.listMetricRecords({ codebaseId: CONFORMANCE_CODEBASE_ID });
      expect(rows.map(row => [row.runId, row.codebaseId])).toEqual([
        [scoped.id, CONFORMANCE_CODEBASE_ID],
      ]);
    });
  });
}
