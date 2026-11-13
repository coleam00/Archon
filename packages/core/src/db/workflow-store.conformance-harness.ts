import { expect, mock, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';
import { projectKeyForCodebase } from '@archon/paths/archon-paths';
import { workflowRunStatusSchema } from '@archon/workflows/schemas/workflow-run';
import { dashboardRunsResultSchema } from '@archon/workflows/schemas/workflow-run-listing';
import { WorkflowStatusReadError } from './workflows';
import type { IDatabase, SqlDialect, QueryResult } from './adapters/types';
import type { WorkflowTerminalProperties } from '@archon/paths';
import {
  CONFORMANCE_CODEBASE_ID,
  resourceStartFixtures,
  CONFORMANCE_CONVERSATION_ID,
  type WorkflowStoreHarness,
} from '@archon/workflows/store-conformance';

const paths = await import('@archon/paths');
const reports: string[] = [];
mock.module('@archon/paths', () => ({
  ...paths,
  isTelemetryDisabled: (): boolean => false,
  captureWorkflowTerminal: (properties: WorkflowTerminalProperties): void => {
    if (properties.runId === undefined) throw new Error('Missing terminal run ID');
    reports.push(properties.runId);
  },
}));

let activeDb: IDatabase;
let dialect: SqlDialect;
let databaseType: 'sqlite' | 'postgresql';
mock.module('./connection', () => ({
  pool: {
    query: <T>(sql: string, params?: unknown[]): Promise<QueryResult<T>> =>
      activeDb.query<T>(sql, params),
  },
  getDatabase: (): IDatabase => activeDb,
  getDialect: (): SqlDialect => dialect,
  getDatabaseType: (): 'sqlite' | 'postgresql' => databaseType,
}));
const { createWorkflowStore } = await import('../workflows/store-adapter');

export async function makeSqlConformanceHarness(
  db: IDatabase,
  sql: SqlDialect,
  type: 'sqlite' | 'postgresql',
  close: () => Promise<void>
): Promise<WorkflowStoreHarness> {
  activeDb = db;
  dialect = sql;
  databaseType = type;
  reports.length = 0;
  await db.query(
    "INSERT INTO remote_agent_codebases (id, name, default_cwd) VALUES ($1, 'conformance', '/conformance')",
    [CONFORMANCE_CODEBASE_ID]
  );
  await db.query(
    "INSERT INTO remote_agent_conversations (id, platform_type, platform_conversation_id) VALUES ($1, 'test', 'conformance')",
    [CONFORMANCE_CONVERSATION_ID]
  );
  // The SQL stores read install capacities from `$ARCHON_HOME/config.yaml`.
  const capacities: Record<string, number> = {};
  let home: { root: string; previous: string | undefined } | undefined;
  return {
    store: createWorkflowStore(),
    setResourceCapacity: async (resource, capacity): Promise<void> => {
      home ??= {
        root: await mkdtemp(join(tmpdir(), 'archon-conformance-home-')),
        previous: process.env.ARCHON_HOME,
      };
      process.env.ARCHON_HOME = home.root;
      capacities[resource] = capacity;
      await writeFile(
        join(home.root, 'config.yaml'),
        JSON.stringify({ concurrency: { resources: capacities } })
      );
    },
    backdate: async (id, dates): Promise<void> => {
      for (const field of ['started_at', 'active_phase_started_at', 'last_activity_at'] as const) {
        const date = dates[field];
        if (date === undefined) continue;
        const value =
          date === null
            ? null
            : type === 'sqlite'
              ? date.toISOString().replace('T', ' ').replace('Z', '')
              : date.toISOString();
        await db.query(`UPDATE remote_agent_workflow_runs SET ${field} = $2 WHERE id = $1`, [
          id,
          value,
        ]);
      }
    },
    seedPersistedWait: async (id, wait): Promise<void> => {
      const write =
        type === 'postgresql'
          ? "jsonb_set(metadata, '{wait}', $2::jsonb, true)"
          : "json_set(metadata, '$.wait', json($2))";
      await db.query(`UPDATE remote_agent_workflow_runs SET metadata = ${write} WHERE id = $1`, [
        id,
        JSON.stringify(wait),
      ]);
    },
    terminalReports: (): string[] => [...reports],
    close: async (): Promise<void> => {
      if (home) {
        if (home.previous === undefined) delete process.env.ARCHON_HOME;
        else process.env.ARCHON_HOME = home.previous;
        await removeTempTree(home.root);
      }
      await close();
    },
  };
}

export function describeSqlStatusReadConformance(
  makeHarness: () => Promise<WorkflowStoreHarness & { db: IDatabase }>
): void {
  test.each(['direct', 'parent'] as const)(
    'partial status reads validate %s runs',
    async association => {
      const harness = await makeHarness();
      try {
        const { db, store } = harness;
        const { listConversationDetachBlockers } = await import('./workflow-run-reads');
        const { lockedRunRow } = await import('./workflow-run-shared');
        const run = await store.createWorkflowRun({
          workflow_name: 'partial-status-read',
          user_message: '',
          origin:
            association === 'direct'
              ? { conversationId: CONFORMANCE_CONVERSATION_ID }
              : { parentConversationId: CONFORMANCE_CONVERSATION_ID },
          metadata: { keep: 'value' },
        });
        const locked = (id: string) => db.withTransaction(query => lockedRunRow(query, id));
        const blockers = (id: string) =>
          db.withTransaction(query => listConversationDetachBlockers(query, id));
        const writes = (id: string) => [
          { write: () => store.setToolCallAttention(id, 'stream', []), unchanged: false },
          {
            write: () =>
              store.answerAttentionWait(id, {
                pauseId: 'ask',
                answer: { decision: 'proceed', text: '' },
                answeredVia: 'cli',
                answeredAt: '2026-01-01T00:05:00.000Z',
              }),
            unchanged: { answered: false },
          },
          {
            write: () =>
              store.labelAttentionWait(id, {
                pauseId: 'ask',
                set: { priority: 'high' },
                unset: [],
                via: 'cli',
              }),
            unchanged: { labeled: false as const },
          },
        ];
        const missing = randomUUID();
        expect(await locked(missing)).toBeUndefined();
        expect(await blockers(missing)).toEqual([]);
        for (const { write, unchanged } of writes(missing)) {
          expect(await write()).toEqual(unchanged);
        }
        expect(await locked(run.id)).toMatchObject({ status: 'pending' });
        expect(await blockers(CONFORMANCE_CONVERSATION_ID)).toEqual([
          { id: run.id, status: 'pending' },
        ]);
        const status = 'unexpected';
        await db.query('UPDATE remote_agent_workflow_runs SET status = $1 WHERE id = $2', [
          status,
          run.id,
        ]);
        for (const read of [
          () => locked(run.id),
          () => blockers(CONFORMANCE_CONVERSATION_ID),
          ...writes(run.id).map(({ write }) => write),
        ]) {
          const result = read();
          await expect(result).rejects.toBeInstanceOf(WorkflowStatusReadError);
          await expect(result).rejects.toMatchObject({
            workflowRunId: run.id,
            storedStatus: status,
            message: `Unsupported workflow run status for run ${run.id}: ${JSON.stringify(status)}`,
          });
        }
      } finally {
        await harness.close();
      }
    }
  );
  test('full-row reads validate statuses without lifecycle writes or partial lists', async () => {
    const harness = await makeHarness();
    try {
      const { db, store } = harness;
      const { getWorkflowRun } = await import('./workflow-run-reads');
      const { listWorkflowRuns, listDashboardRuns } = await import('./workflow-run-lists');
      expect(await getWorkflowRun(randomUUID())).toBeNull();
      expect(await store.getWorkflowRun(randomUUID())).toBeNull();
      expect(await listWorkflowRuns()).toEqual([]);
      expect((await store.listWorkflowRuns()).runs).toEqual([]);
      await store.createWorkflowRun({ workflow_name: 'healthy', user_message: '' });
      const run = await store.createWorkflowRun({ workflow_name: 'status-read', user_message: '' });
      for (const status of workflowRunStatusSchema.options) {
        await db.query('UPDATE remote_agent_workflow_runs SET status = $1 WHERE id = $2', [
          status,
          run.id,
        ]);
        expect((await getWorkflowRun(run.id))?.status).toBe(status);
        expect((await store.getWorkflowRun(run.id))?.status).toBe(status);
        expect((await listWorkflowRuns()).find(row => row.id === run.id)?.status).toBe(status);
        const dashboard = await store.listWorkflowRuns();
        expect(dashboard.runs.find(row => row.id === run.id)?.status).toBe(status);
        expect(dashboardRunsResultSchema.shape.counts.parse(dashboard.counts)).toEqual(
          dashboard.counts
        );
        expect(dashboard.counts.all).toBe(2);
        for (const value of workflowRunStatusSchema.options) {
          expect(dashboard.counts[value]).toBe(
            Number(value === 'pending') + Number(value === status)
          );
        }
      }
      for (const status of ['unexpected', '']) {
        await db.query('UPDATE remote_agent_workflow_runs SET status = $1 WHERE id = $2', [
          status,
          run.id,
        ]);
        const snapshot = async () => ({
          rows: (await db.query('SELECT * FROM remote_agent_workflow_runs ORDER BY id')).rows,
          events: await store.listWorkflowEvents(run.id),
          head: await store.getWorkflowEventHead(),
          reports: harness.terminalReports(),
        });
        const before = await snapshot();
        for (const read of [
          () => getWorkflowRun(run.id),
          () => store.getWorkflowRun(run.id),
          () => listWorkflowRuns(),
          () => store.listWorkflowRuns(),
          () => listDashboardRuns({ limit: 0 }),
          () => listDashboardRuns({ status: 'pending' }),
        ]) {
          const result = read();
          await expect(result).rejects.toBeInstanceOf(WorkflowStatusReadError);
          await expect(result).rejects.toMatchObject({
            workflowRunId: run.id,
            storedStatus: status,
            message: `Unsupported workflow run status for run ${run.id}: ${JSON.stringify(status)}`,
          });
        }
        expect(await snapshot()).toEqual(before);
      }
    } finally {
      await harness.close();
    }
  });
  test.each(['runStatus', 'blockerRunStatus'] as const)(
    'resource-start inspection validates %s without lifecycle writes',
    async field => {
      const harness = await makeHarness();
      try {
        const { db, store } = harness;
        const { start } = resourceStartFixtures(
          CONFORMANCE_CODEBASE_ID,
          CONFORMANCE_CONVERSATION_ID
        );
        const owner = start();
        const waiting = start();
        await store.admitResourceStart(owner);
        await store.admitResourceStart(waiting);
        const requestId = waiting.launch.run.id;
        const runId = field === 'runStatus' ? requestId : owner.launch.run.id;
        const otherField = field === 'runStatus' ? 'blockerRunStatus' : 'runStatus';
        const otherStatus = field === 'runStatus' ? 'pending' : null;
        if (field === 'blockerRunStatus') {
          await db.query(
            'UPDATE remote_agent_resource_start_requests SET blocker_run_id = $1 WHERE id = $2',
            [randomUUID(), requestId]
          );
        }
        expect(await store.getResourceStartRequest(randomUUID())).toBeNull();
        expect(await store.getResourceStartRequest(requestId)).toMatchObject({
          [field]: null,
          [otherField]: otherStatus,
        });
        expect(await store.listQueuedResourceStartsForHost('host')).toMatchObject([
          { id: requestId, [field]: null, [otherField]: otherStatus },
        ]);
        if (field === 'runStatus') await store.createWorkflowRun(waiting.launch.run);
        else
          await db.query(
            'UPDATE remote_agent_resource_start_requests SET blocker_run_id = $1 WHERE id = $2',
            [runId, requestId]
          );

        const snapshot = async () => ({
          runs: (await db.query('SELECT * FROM remote_agent_workflow_runs ORDER BY id')).rows,
          requests: (
            await db.query('SELECT * FROM remote_agent_resource_start_requests ORDER BY id')
          ).rows,
          holders: (
            await db.query(
              'SELECT * FROM remote_agent_resource_slot_holders ORDER BY resource_key, holder_id'
            )
          ).rows,
          events: await store.listWorkflowEvents(runId),
          head: await store.getWorkflowEventHead(),
          reports: harness.terminalReports(),
        });
        for (const status of [...workflowRunStatusSchema.options, 'unexpected', '']) {
          await db.query('UPDATE remote_agent_workflow_runs SET status = $1 WHERE id = $2', [
            status,
            runId,
          ]);
          const before = await snapshot();
          if (workflowRunStatusSchema.safeParse(status).success) {
            expect(await store.getResourceStartRequest(requestId)).toMatchObject({
              [field]: status,
              [otherField]: otherStatus,
            });
            expect(await store.listQueuedResourceStartsForHost('host')).toMatchObject([
              { id: requestId, [field]: status, [otherField]: otherStatus },
            ]);
          } else {
            const message = `Unsupported workflow run status for run ${runId}: ${JSON.stringify(status)}`;
            const read = store.getResourceStartRequest(requestId);
            await expect(read).rejects.toBeInstanceOf(WorkflowStatusReadError);
            await expect(read).rejects.toMatchObject({
              workflowRunId: runId,
              storedStatus: status,
              message,
            });
            const queued = await store.listQueuedResourceStartsForHost('host');
            expect(queued).toHaveLength(1);
            expect(queued[0]).toMatchObject({
              id: requestId,
              error: { workflowRunId: runId, storedStatus: status, message },
            });
            if (!queued[0] || !('error' in queued[0])) throw new Error('Expected inspection error');
            expect(queued[0].error).toBeInstanceOf(WorkflowStatusReadError);
          }
          expect(await snapshot()).toEqual(before);
        }
      } finally {
        await harness.close();
      }
    }
  );
  test('status reads validate persisted values without lifecycle writes', async () => {
    const harness = await makeHarness();
    try {
      const { db, store } = harness;
      const run = await store.createWorkflowRun({ workflow_name: 'status-read', user_message: '' });
      expect(await store.getWorkflowRunStatus(randomUUID())).toBeNull();
      for (const status of workflowRunStatusSchema.options) {
        await db.query('UPDATE remote_agent_workflow_runs SET status = $1 WHERE id = $2', [
          status,
          run.id,
        ]);
        expect(await store.getWorkflowRunStatus(run.id)).toBe(status);
      }
      for (const status of ['unexpected', '']) {
        await db.query('UPDATE remote_agent_workflow_runs SET status = $1 WHERE id = $2', [
          status,
          run.id,
        ]);
        const snapshot = async () => ({
          rows: (await db.query('SELECT * FROM remote_agent_workflow_runs WHERE id = $1', [run.id]))
            .rows,
          events: await store.listWorkflowEvents(run.id),
          head: await store.getWorkflowEventHead(),
          reports: harness.terminalReports(),
        });
        const before = await snapshot();
        const read = store.getWorkflowRunStatus(run.id);
        await expect(read).rejects.toBeInstanceOf(WorkflowStatusReadError);
        await expect(read).rejects.toMatchObject({
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
  test('an item is one row per project and key, and lists exactly its own runs in start order', async () => {
    const harness = await makeHarness();
    try {
      const { db, store } = harness;
      const otherProject = randomUUID();
      await db.query(
        "INSERT INTO remote_agent_codebases (id, name, default_cwd) VALUES ($1, 'other', '/other')",
        [otherProject]
      );
      const run = (codebase_id: string | undefined, item_key?: string) =>
        store.createWorkflowRun({ workflow_name: 'item', user_message: '', codebase_id, item_key });
      const second = await run(CONFORMANCE_CODEBASE_ID, 'a');
      // A start names its item on the receipt; preparation resolves it onto the request.
      const { launch } = resourceStartFixtures(
        CONFORMANCE_CODEBASE_ID,
        CONFORMANCE_CONVERSATION_ID
      );
      const start = async (itemKey: string) => {
        const identity = { receiptId: randomUUID(), bindingId: 'binding', ownerId: 'owner' };
        await store.acceptStartReceipt({
          receipt: {
            id: identity.receiptId,
            sourceInstanceId: 'source',
            deliveryId: null,
            contentDigest: 'digest',
            receivedAt: new Date().toISOString(),
            occurredAt: null,
            sourceActor: null,
            itemKey,
          },
          outcome: 'matched',
          bindings: [
            {
              bindingId: identity.bindingId,
              bindingRevision: null,
              hostId: 'host',
              runAsUserId: 'operator',
              resource: 'resource',
              overlap: 'queue',
              launch: {
                cwd: '/c',
                workflowName: 'item',
                inputs: {},
                isolation: { kind: 'in-place' },
              },
            },
          ],
        });
        await store.claimStartBindingPreparation(identity);
        expect((await store.getStartReceipt(identity.receiptId))?.itemKey).toBe(itemKey);
        return store.completeStartBindingPreparation({ ...identity, launch: launch() });
      };
      const started = await start('a');
      if (started?.status !== 'admitted') throw new Error('Expected the start to be admitted');
      await harness.backdate(started.runId, { started_at: new Date('2026-01-01T00:00:00Z') });
      // A start waiting behind it has its item already, with no run yet.
      expect((await start('c'))?.status).toBe('queued');
      await run(CONFORMANCE_CODEBASE_ID, 'b');
      await run(otherProject, 'a');
      expect((await run(CONFORMANCE_CODEBASE_ID)).item_id).toBeNull();

      const project = projectKeyForCodebase(
        { name: 'conformance', default_cwd: '/conformance' },
        ''
      );
      const listed = await store.listItemRuns(project, 'a');
      expect(listed.map(row => row.id)).toEqual([started.runId, second.id]);
      expect(await store.getItem(second.item_id ?? '')).toMatchObject({
        projectKey: project,
        key: 'a',
      });
      expect(new Set(listed.map(row => row.item_id)).size).toBe(1);
      expect(await store.listItemRuns(project, 'c')).toEqual([]);
      const items = await db.query<{ item: string }>(
        "SELECT key || ' in ' || project_key AS item FROM remote_agent_items"
      );
      expect(items.rows.map(row => row.item).sort()).toEqual([
        `a in ${project}`,
        `a in ${projectKeyForCodebase({ name: 'other', default_cwd: '/other' }, '')}`,
        `b in ${project}`,
        `c in ${project}`,
      ]);
      await expect(run(undefined, 'a')).rejects.toThrow();
    } finally {
      await harness.close();
    }
  });
}
