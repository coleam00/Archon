/**
 * Item naming in a run listing, on both SQL stores: a listed run carries the key of the item
 * it is on, and a run on no item carries none. Called from each backend's conformance test
 * with its harness factory, after `makeSqlConformanceHarness` has routed the store to that
 * backend's database.
 */
import { expect, test } from 'bun:test';
import type { WorkflowStoreHarness } from '@archon/workflows/store-conformance';
import type { IDatabase } from './adapters/types';

export function describeRunItemListingConformance(
  makeHarness: () => Promise<WorkflowStoreHarness & { db: IDatabase }>
): void {
  test("a listed run names its item's key, and a run on no item names none", async () => {
    const harness = await makeHarness();
    try {
      const { db, store } = harness;
      const inserted = await db.query<{ id: string }>(
        "INSERT INTO remote_agent_items (project_key, key) VALUES ('acme/web', 'acme/web#7') RETURNING id"
      );
      const itemId = inserted.rows[0]?.id ?? '';
      const onItem = await store.createWorkflowRun({ workflow_name: 'review', user_message: '' });
      const onNone = await store.createWorkflowRun({ workflow_name: 'assist', user_message: '' });
      await db.query('UPDATE remote_agent_workflow_runs SET item_id = $1 WHERE id = $2', [
        itemId,
        onItem.id,
      ]);

      const listed = (await store.listWorkflowRuns()).runs;
      expect(listed.find(run => run.id === onItem.id)?.item_key).toBe('acme/web#7');
      expect(listed.find(run => run.id === onNone.id)?.item_key).toBeNull();
      // The bare list carries no join, so it names no item either way.
      const { listWorkflowRuns } = await import('./workflow-run-lists');
      expect((await listWorkflowRuns()).find(run => run.id === onItem.id)).not.toHaveProperty(
        'item_key'
      );
    } finally {
      await harness.close();
    }
  });
}
