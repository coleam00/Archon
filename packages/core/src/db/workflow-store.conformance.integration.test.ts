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

test.each(['nested-workflow', null])(
  'parent deletion preserves child provenance after metadata erasure attempts (node: %s)',
  async marker => {
    const harness = await makeHarness();
    try {
      const { store } = harness;
      const parent = await store.createWorkflowRun({ workflow_name: 'parent', user_message: '' });
      const child = await store.createWorkflowRun({
        workflow_name: 'child',
        user_message: '',
        parent_run_id: parent.id,
        metadata: marker === null ? {} : { parent_node_id: marker },
      });
      await store.claimPendingWorkflowRun(child.id);
      await store.updateWorkflowRun(child.id, { metadata: { parent_node_id: null } });
      expect(
        await store.updateWorkflowRunMetadataIfRunning(child.id, { parent_node_id: 'replacement' })
      ).toBe(true);
      await store.cancelWorkflowRun(parent.id);
      const { deleteWorkflowRun } = await import('./workflows');
      await deleteWorkflowRun(parent.id);
      const surviving = await store.getWorkflowRun(child.id);
      expect(surviving?.parent_run_id).toBeNull();
      expect(surviving?.metadata).toHaveProperty('parent_node_id', marker);
    } finally {
      await harness.close();
    }
  }
);

test('a shipped row upgrades, resumes and remains readable after reopen', async () => {
  const root = trackTempRoot(await mkdtemp(join(tmpdir(), 'workflow-clock-upgrade-')));
  const path = join(root, 'store.db');
  let db = new SqliteAdapter(path);
  await db.query('ALTER TABLE remote_agent_workflow_runs DROP COLUMN active_phase_started_at');
  await db.query(
    "INSERT INTO remote_agent_conversations (id, platform_type, platform_conversation_id) VALUES ('legacy-clock', 'test', 'legacy-clock')"
  );
  await db.query(
    "INSERT INTO remote_agent_workflow_runs (id, conversation_id, workflow_name, user_message, started_at, status) VALUES ('legacy-clock', 'legacy-clock', 'legacy', '', '2020-01-01 00:00:00', 'failed')"
  );
  await db.close();
  db = new SqliteAdapter(path);
  const harness = await makeSqlConformanceHarness(db, sqliteDialect, 'sqlite', async () =>
    db.close()
  );
  try {
    expect(
      (await harness.store.getWorkflowRun('legacy-clock'))?.active_phase_started_at
    ).toBeNull();
    await db.query(
      "INSERT INTO remote_agent_workflow_runs (id, conversation_id, workflow_name, user_message) VALUES ('old-writer-clock', 'legacy-clock', 'legacy', '')"
    );
    expect(
      (await harness.store.getWorkflowRun('old-writer-clock'))?.active_phase_started_at
    ).toBeNull();
    const resumed = await harness.store.resumeWorkflowRun('legacy-clock');
    expect(resumed.started_at).toEqual(new Date('2020-01-01T00:00:00.000Z'));
    expect(resumed.active_phase_started_at).toBeInstanceOf(Date);
    await db.close();
    db = new SqliteAdapter(path);
    const row = (
      await db.query<{ started_at: string; active_phase_started_at: string }>(
        "SELECT started_at, active_phase_started_at FROM remote_agent_workflow_runs WHERE id = 'legacy-clock'"
      )
    ).rows[0];
    if (!row) throw new Error('Missing upgraded row');
    expect(new Date(row.started_at.replace(' ', 'T') + 'Z')).toEqual(resumed.started_at);
    expect(row.active_phase_started_at).not.toBeNull();
  } finally {
    await harness.close();
  }
});
