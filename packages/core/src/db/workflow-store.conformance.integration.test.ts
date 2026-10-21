// @archon-test-isolated
import { expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree, trackTempRoots } from '@archon/paths/test-utils';
import { describeWorkflowStoreConformance } from '@archon/workflows/store-conformance';
import {
  makeSqlConformanceHarness,
  describeSqlStatusReadConformance,
} from './workflow-store.conformance-harness';
import { SqliteAdapter, sqliteDialect } from './adapters/sqlite';

const trackTempRoot = trackTempRoots();

const makeHarness = async () => {
  const root = trackTempRoot(await mkdtemp(join(tmpdir(), 'workflow-store-conformance-')));
  const db = new SqliteAdapter(join(root, 'store.db'));
  const close = async () => {
    await db.close();
    await removeTempTree(root);
  };
  try {
    const harness = await makeSqlConformanceHarness(db, sqliteDialect, 'sqlite', close);
    return { ...harness, db };
  } catch (error) {
    await close();
    throw error;
  }
};
describeWorkflowStoreConformance('SQLite', makeHarness);

describeSqlStatusReadConformance(makeHarness);

test.each([null, '2026-10-20 01:02:03', '2026-10-20 01:02:03.456'])(
  'failed resume preparation preserves SQLite timestamp ordering (%s)',
  async timestamp => {
    const harness = await makeHarness();
    try {
      const { store, db } = harness;
      const input = {
        workflow_name: 'timestamp-rollback',
        working_path: '/timestamp-rollback',
        user_message: '',
      };
      const older = await store.createWorkflowRun(input);
      const newer = await store.createWorkflowRun(input);
      const approval = { nodeId: 'review', message: 'Review changes', type: 'approval' as const };
      for (const run of [older, newer]) {
        await store.claimPendingWorkflowRun(run.id);
        await store.pauseWorkflowRun(run.id, approval);
      }
      await db.query(
        `UPDATE remote_agent_workflow_runs
           SET started_at = $2, completed_at = $3, last_activity_at = $3
         WHERE id = $1`,
        [older.id, '2026-10-20 00:00:00', timestamp]
      );
      await db.query('UPDATE remote_agent_workflow_runs SET started_at = $2 WHERE id = $1', [
        newer.id,
        '2026-10-20 12:00:00',
      ]);
      const before = await store.getWorkflowRun(older.id);
      const setupError = new Error('container restart failed');
      await expect(
        store.resumeWorkflowRun(older.id, undefined, async () => {
          throw setupError;
        })
      ).rejects.toBe(setupError);

      expect(await store.getWorkflowRun(older.id)).toEqual(before);
      expect((await store.findResumableRun(input.workflow_name, input.working_path))?.id).toBe(
        newer.id
      );
      const restored = await db.query<{
        started_at: string;
        completed_at: string | null;
        last_activity_at: string | null;
        activity_before_cutoff: number | null;
        completion_before_cutoff: number | null;
      }>(
        `SELECT started_at, completed_at, last_activity_at,
                last_activity_at < datetime('2026-10-20 12:00:00') AS activity_before_cutoff,
                completed_at < datetime('2026-10-20 12:00:00') AS completion_before_cutoff
           FROM remote_agent_workflow_runs WHERE id = $1`,
        [older.id]
      );
      expect(restored.rows[0]).toEqual({
        started_at: '2026-10-20 00:00:00',
        completed_at: timestamp,
        last_activity_at: timestamp,
        activity_before_cutoff: timestamp === null ? null : 1,
        completion_before_cutoff: timestamp === null ? null : 1,
      });
    } finally {
      await harness.close();
    }
  }
);

test('explicit deletion retains SQL feed payloads from an earlier cursor', async () => {
  const harness = await makeHarness();
  try {
    const { store } = harness;
    const run = await store.createWorkflowRun({ workflow_name: 'delete-feed', user_message: '' });
    const head = await store.getWorkflowEventHead();
    await store.cancelWorkflowRun(run.id);
    const committed = await store.listWorkflowEvents(run.id);
    const { deleteWorkflowRun } = await import('./workflows');
    await deleteWorkflowRun(run.id);
    expect(await store.getWorkflowRun(run.id)).toBeNull();
    expect(await store.listWorkflowEvents(run.id)).toEqual([]);
    expect(
      (await store.readWorkflowEventsAfter(head, { limit: 1 })).events.map(row => row.event)
    ).toEqual(committed);
  } finally {
    await harness.close();
  }
});
