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
test('validates direct SQL status projections before interpreting or mutating a run', async () => {
  const harness = await makeHarness();
  try {
    const { store, db } = harness;
    const run = await store.createWorkflowRun({
      workflow_name: 'projection-status',
      user_message: '',
      origin: { conversationId: CONFORMANCE_CONVERSATION_ID },
    });
    const { listConversationDetachBlockers } = await import('./workflow-run-reads');
    const { lockedRunRow } = await import('./workflow-run-shared');
    const { resourceStartOccupancy } = await import('./resource-slots');
    const { setToolCallAttention, deleteWorkflowRun } = await import('./workflow-run-writes');
    const launch = {
      version: 2,
      run: {
        id: crypto.randomUUID(),
        codebase_id: CONFORMANCE_CODEBASE_ID,
        workflow_name: 'projection-status',
        user_message: '',
        metadata: {},
      },
      execution: {
        cwd: '/checkout',
        conversationId: 'conversation',
        isolation: { kind: 'in-place' },
      },
    };
    await db.query(
      "INSERT INTO remote_agent_resource_slots (resource_key, capacity) VALUES ('status', 1)"
    );
    await db.query(
      `INSERT INTO remote_agent_resource_start_requests
      (id, resource_key, host_id, overlap_policy, status, launch)
      VALUES ($1, 'status', 'host', 'queue', 'admitted', $2)`,
      [run.id, JSON.stringify(launch)]
    );
    const projections = [
      () =>
        db.withTransaction(query =>
          listConversationDetachBlockers(query, CONFORMANCE_CONVERSATION_ID)
        ),
      () => db.withTransaction(query => lockedRunRow(query, run.id)),
      () => db.withTransaction(query => resourceStartOccupancy(query, 'status', 1)),
    ];
    for (const status of workflowRunStatusSchema.options) {
      await db.query('UPDATE remote_agent_workflow_runs SET status = $1 WHERE id = $2', [
        status,
        run.id,
      ]);
      for (const read of projections) await read();
      expect(await db.withTransaction(query => lockedRunRow(query, run.id))).toMatchObject({
        status,
      });
    }
    expect(
      await db.withTransaction(query => lockedRunRow(query, crypto.randomUUID()))
    ).toBeUndefined();
    const operations = [
      ...projections,
      () => setToolCallAttention(run.id, 'stream', []),
      () =>
        store.answerAttentionWait(run.id, {
          pauseId: 'pause',
          answer: { decision: 'yes', text: '' },
          answeredVia: 'web',
          answeredAt: new Date().toISOString(),
        }),
      () => store.labelAttentionWait(run.id, { pauseId: 'pause', set: {}, unset: [], via: 'web' }),
      () => deleteWorkflowRun(run.id),
    ];
    const events = await store.listWorkflowEvents(run.id);
    for (const status of ['unsupported-status', '']) {
      await db.query('UPDATE remote_agent_workflow_runs SET status = $1 WHERE id = $2', [
        status,
        run.id,
      ]);
      for (const operation of operations) {
        await expect(operation()).rejects.toThrow(
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
