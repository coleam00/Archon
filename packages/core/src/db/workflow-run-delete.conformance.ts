/**
 * Conformance for deleting one run on the SQL stores, run by the SQLite and PostgreSQL
 * integration tests: a run with a sub-run that has not ended, at any depth, is refused, and
 * deletes as before once that sub-run ends.
 */
import { expect, test } from 'bun:test';
import { WorkflowRunDeleteRefusedError } from '@archon/workflows/store';
import type { WorkflowStoreHarness } from '@archon/workflows/store-conformance';

export function describeSqlRunDeleteConformance(
  makeHarness: () => Promise<WorkflowStoreHarness>
): void {
  test('a finished run with a live grandchild is not deleted until the grandchild ends', async () => {
    const harness = await makeHarness();
    try {
      const { store } = harness;
      const start = async (parent_run_id?: string) => {
        const run = await store.createWorkflowRun({
          workflow_name: 'delete-tree',
          user_message: '',
          ...(parent_run_id === undefined ? {} : { parent_run_id }),
        });
        await store.claimPendingWorkflowRun(run.id);
        return run.id;
      };
      const parent = await start();
      const child = await start(parent);
      const grandchild = await start(child);
      await store.completeWorkflowRun(child, { duration_ms: 1 });
      await store.completeWorkflowRun(parent, { duration_ms: 1 });
      // Imported here, after the harness has pointed the connection at its database.
      const { deleteWorkflowRun } = await import('./workflow-run-writes');
      const refused = await deleteWorkflowRun(parent).catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(WorkflowRunDeleteRefusedError);
      expect((refused as Error).message).toContain(`${grandchild} (running)`);
      expect((refused as Error).message).not.toContain(child);
      expect(await store.getWorkflowRunStatus(parent)).toBe('completed');
      expect((await store.getWorkflowRun(grandchild))?.parent_run_id).toBe(child);

      await store.completeWorkflowRun(grandchild, { duration_ms: 1 });
      await deleteWorkflowRun(parent);
      expect(await store.getWorkflowRun(parent)).toBeNull();
      expect((await store.getWorkflowRun(child))?.parent_run_id).toBeNull();
    } finally {
      await harness.close();
    }
  });
}
