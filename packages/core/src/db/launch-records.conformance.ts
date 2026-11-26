/**
 * Conformance for a stored launch on the SQL stores, run by the SQLite and PostgreSQL
 * integration tests: a launch a newer binary wrote with keys this one does not know is
 * still admitted and drained, and one with a version it does not know is still refused.
 */
import { expect, test } from 'bun:test';
import type { IDatabase } from './adapters/types';
import {
  CONFORMANCE_CODEBASE_ID,
  CONFORMANCE_CONVERSATION_ID,
  resourceStartFixtures,
  type WorkflowStoreHarness,
} from '@archon/workflows/store-conformance';

export function describeSqlLaunchRecordConformance(
  makeHarness: () => Promise<WorkflowStoreHarness & { db: IDatabase }>
): void {
  test('a launch a newer binary wrote with fields this one does not know is admitted and drained', async () => {
    const harness = await makeHarness();
    try {
      const { db, store } = harness;
      const rewrite = async (id: string, change: (launch: Record<string, unknown>) => unknown) => {
        const row = await db.query<{ launch: string }>(
          'SELECT launch FROM remote_agent_resource_start_requests WHERE id = $1',
          [id]
        );
        const launch = JSON.parse(row.rows[0]?.launch ?? '') as Record<string, unknown>;
        await db.query(
          'UPDATE remote_agent_resource_start_requests SET launch = $2 WHERE id = $1',
          [id, JSON.stringify(change(launch))]
        );
      };
      const newer = (launch: Record<string, unknown>) => {
        const { run, execution } = launch as {
          run: Record<string, unknown>;
          execution: Record<string, unknown>;
        };
        return {
          ...launch,
          later: 1,
          run: {
            ...run,
            later: 1,
            origin: { conversationId: CONFORMANCE_CONVERSATION_ID, later: 1 },
          },
          execution: { ...execution, later: 1 },
        };
      };
      const { start } = resourceStartFixtures(CONFORMANCE_CODEBASE_ID, CONFORMANCE_CONVERSATION_ID);
      const [holder, queued, wrong] = [start(), start(), start()];
      expect(await store.admitResourceStart(holder)).toMatchObject({ status: 'admitted' });
      // Occupancy reads the holder's launch on every admission on the resource.
      await rewrite(holder.launch.run.id, newer);
      expect(await store.admitResourceStart(queued)).toMatchObject({ status: 'queued' });
      expect(await store.admitResourceStart(wrong)).toMatchObject({ status: 'queued' });
      await rewrite(queued.launch.run.id, newer);
      // A version this binary does not know is a record it cannot read, not a newer one.
      await rewrite(wrong.launch.run.id, launch => ({ ...newer(launch), version: 3 }));

      await store.claimPendingWorkflowRun(holder.launch.run.id);
      await store.completeWorkflowRun(holder.launch.run.id, { duration_ms: 1 });
      expect(await store.drainResourceStarts({ resource: 'resource', hostId: 'host' })).toEqual([
        { status: 'admitted', requestId: queued.launch.run.id, runId: queued.launch.run.id },
      ]);
      expect((await store.getWorkflowRun(queued.launch.run.id))?.origin).toEqual({
        conversationId: CONFORMANCE_CONVERSATION_ID,
      });
      expect(await store.listUnreadableQueuedStarts()).toEqual([
        expect.objectContaining({ requestId: wrong.launch.run.id, behind: 0 }),
      ]);
      // With the slot free again, the drain still does not admit what it cannot read.
      await store.claimPendingWorkflowRun(queued.launch.run.id);
      await store.completeWorkflowRun(queued.launch.run.id, { duration_ms: 1 });
      expect(await store.drainResourceStarts({ resource: 'resource', hostId: 'host' })).toEqual([]);
      expect(await store.getWorkflowRun(wrong.launch.run.id)).toBeNull();
      expect(await store.listUnreadableQueuedStarts()).toEqual([
        expect.objectContaining({ requestId: wrong.launch.run.id }),
      ]);
    } finally {
      await harness.close();
    }
  });
}
