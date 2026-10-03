/**
 * Integration test: the provider-event reader against a REAL bun:sqlite database.
 * The Postgres half runs the same contract in
 * `workflow-events.provider-events.postgres.integration.test.ts`.
 *
 * Runs in its own `bun test` invocation (see package.json) — it mock.module's
 * ./connection with a real adapter, conflicting with other db tests' fakes.
 */
import { describe, mock } from 'bun:test';
import { providerEventReaderContract } from './provider-events.reader-contract';

mock.module('@archon/paths', () => ({
  createLogger: () => ({
    info() {},
    warn() {},
    error() {},
    debug() {},
    trace() {},
    fatal() {},
  }),
}));

const { SqliteAdapter, sqliteDialect } = await import('./adapters/sqlite');
const db = new SqliteAdapter(':memory:');

mock.module('./connection', () => ({
  pool: db,
  getDatabase: () => db,
  getDialect: () => sqliteDialect,
  getDatabaseType: () => 'sqlite',
}));

const workflowEvents = await import('./workflow-events');

describe('listProviderEvents — real SQLite', () => {
  providerEventReaderContract(
    () => db,
    () => workflowEvents
  );
});
