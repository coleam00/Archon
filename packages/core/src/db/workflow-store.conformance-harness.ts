import { mock } from 'bun:test';
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
          type === 'sqlite'
            ? date.toISOString().replace('T', ' ').slice(0, 19)
            : date.toISOString();
        await db.query(`UPDATE remote_agent_workflow_runs SET ${field} = $2 WHERE id = $1`, [
          id,
          value,
        ]);
      }
    },
    terminalReports: (): string[] => [...reports],
    close,
  };
}
