// @archon-test-isolated
import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree, trackTempRoots } from '@archon/paths/test-utils';
import { describeWorkflowStoreConformance } from '@archon/workflows/store-conformance';
import { workflowRunStatusSchema } from '@archon/workflows/schemas/workflow-run';
import { WorkflowStatusReadError } from './workflows';
import { makeSqlConformanceHarness } from './workflow-store.conformance-harness';
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
test('SQL status reads validate stored values without lifecycle writes', async () => {
  const harness = await makeHarness();
  const { store, db } = harness;
  try {
    const run = await store.createWorkflowRun({ workflow_name: 'status-read', user_message: '' });
    expect(await store.getWorkflowRunStatus(randomUUID())).toBeNull();
    for (const status of workflowRunStatusSchema.options) {
      await db.query('UPDATE remote_agent_workflow_runs SET status = $2 WHERE id = $1', [
        run.id,
        status,
      ]);
      expect(await store.getWorkflowRunStatus(run.id)).toBe(status);
    }
    for (const status of ['unexpected', '']) {
      await db.query('UPDATE remote_agent_workflow_runs SET status = $2 WHERE id = $1', [
        run.id,
        status,
      ]);
      const snapshot = async () => ({
        rows: (await db.query('SELECT * FROM remote_agent_workflow_runs WHERE id = $1', [run.id]))
          .rows,
        events: await store.listWorkflowEvents(run.id),
        head: await store.getWorkflowEventHead(),
        reports: harness.terminalReports(),
      });
      const before = await snapshot();
      const error = await store.getWorkflowRunStatus(run.id).catch(error => error);
      expect(error).toBeInstanceOf(WorkflowStatusReadError);
      expect(error).toMatchObject({
        name: 'WorkflowStatusReadError',
        workflowRunId: run.id,
        storedStatus: status,
        message: `Unsupported workflow run status for run ${run.id}: ${JSON.stringify(status)}`,
      });
      expect(await snapshot()).toEqual(before);
    }
  } finally {
    await harness.close();
  }
});

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
