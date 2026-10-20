// @archon-test-isolated
import { expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree, trackTempRoots } from '@archon/paths/test-utils';
import {
  CONFORMANCE_CODEBASE_ID,
  CONFORMANCE_CONVERSATION_ID,
  describeWorkflowStoreConformance,
} from '@archon/workflows/store-conformance';
import { workflowRunStatusSchema } from '@archon/workflows/schemas/workflow-run';
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
test('validates persisted workflow statuses without changing lifecycle state', async () => {
  const harness = await makeHarness();
  try {
    const { store, db } = harness;
    const parent = await store.createWorkflowRun({ workflow_name: 'parent', user_message: '' });
    const run = await store.createWorkflowRun({
      workflow_name: 'status-read',
      user_message: '',
      origin: { conversationId: CONFORMANCE_CONVERSATION_ID },
      codebase_id: CONFORMANCE_CODEBASE_ID,
      parent_run_id: parent.id,
      adopted_from_run_id: parent.id,
      metadata: { isolation_env_id: 'status-env' },
    });
    const reads = await import('./workflow-run-reads');
    const lists = await import('./workflow-run-lists');
    const fullRunReads = [
      () => store.getWorkflowRun(run.id),
      () => reads.getRunByIsolationEnvId('status-env'),
      () => reads.findWorkflowRunsByIdPrefix(run.id, CONFORMANCE_CODEBASE_ID),
      () => reads.findChildRuns(parent.id),
      () => reads.getWorkflowRunByWorkerPlatformId('conformance'),
      () => lists.listDashboardRuns(),
      () => lists.listWorkflowRuns(),
      () => lists.findAdoptingRuns(parent.id),
    ];
    expect(await store.getWorkflowRun(crypto.randomUUID())).toBeNull();
    expect(await store.getWorkflowRunStatus(crypto.randomUUID())).toBeNull();
    for (const status of workflowRunStatusSchema.options) {
      await db.query('UPDATE remote_agent_workflow_runs SET status = $1 WHERE id = $2', [
        status,
        run.id,
      ]);
      expect(await store.getWorkflowRunStatus(run.id)).toBe(status);
      expect((await store.getWorkflowRun(run.id))?.status).toBe(status);
      for (const read of fullRunReads) await read();
    }
    const events = await store.listWorkflowEvents(run.id);
    for (const status of ['unsupported-status', '']) {
      await db.query('UPDATE remote_agent_workflow_runs SET status = $1 WHERE id = $2', [
        status,
        run.id,
      ]);
      await expect(store.getWorkflowRunStatus(run.id)).rejects.toThrow(
        `Unsupported workflow run status for run ${run.id}: ${JSON.stringify(status)}`
      );
      for (const read of fullRunReads) {
        await expect(read()).rejects.toThrow(
          `Unsupported workflow run status for run ${run.id}: ${JSON.stringify(status)}`
        );
      }
      expect(
        (await db.query('SELECT status FROM remote_agent_workflow_runs WHERE id = $1', [run.id]))
          .rows
      ).toEqual([{ status }]);
      expect(await store.listWorkflowEvents(run.id)).toEqual(events);
      expect(harness.terminalReports()).toEqual([]);
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
