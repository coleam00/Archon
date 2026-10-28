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

test('parent deletion preserves the surviving child spawning-node provenance', async () => {
  const harness = await makeHarness();
  try {
    const { store } = harness;
    const parent = await store.createWorkflowRun({ workflow_name: 'parent', user_message: '' });
    const child = await store.createWorkflowRun({
      workflow_name: 'child',
      user_message: '',
      parent_run_id: parent.id,
      metadata: { parent_node_id: 'nested-workflow' },
    });
    await store.cancelWorkflowRun(parent.id);
    const { deleteWorkflowRun } = await import('./workflows');
    await deleteWorkflowRun(parent.id);
    const surviving = await store.getWorkflowRun(child.id);
    expect(surviving?.parent_run_id).toBeNull();
    expect(surviving?.metadata.parent_node_id).toBe('nested-workflow');
  } finally {
    await harness.close();
  }
});
