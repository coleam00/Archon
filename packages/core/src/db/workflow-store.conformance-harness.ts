import { expect, mock, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { workflowRunStatusSchema } from '@archon/workflows/schemas/workflow-run';
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
  return {
    store: createWorkflowStore(),
    backdate: async (id, dates): Promise<void> => {
      for (const field of ['started_at', 'last_activity_at'] as const) {
        const date = dates[field];
        if (date === undefined) continue;
        const value =
          date === null
            ? null
            : type === 'sqlite'
              ? date.toISOString().replace('T', ' ').slice(0, 19)
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
    close,
  };
}

export function describeSqlStatusReadConformance(
  makeHarness: () => Promise<WorkflowStoreHarness & { db: IDatabase }>
): void {
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
}
