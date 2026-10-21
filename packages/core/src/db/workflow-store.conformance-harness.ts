import { expect, mock, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { workflowRunStatusSchema } from '@archon/workflows/schemas/workflow-run';
import { WorkflowStatusReadError } from './workflows';
import type { IDatabase, SqlDialect, QueryResult } from './adapters/types';
import type { WorkflowTerminalProperties } from '@archon/paths';
import {
  CONFORMANCE_CODEBASE_ID,
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
