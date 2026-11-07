import { expect, test } from 'bun:test';
import { getSchemaSQL } from './bundled-schema';
import { postgresDialect } from './adapters/postgres';
import { metricRecordsSql } from './workflow-metrics';

const normalize = (sql: string): string => sql.replace(/\s+/g, ' ').trim();

// SQLite enforces its half through INDEXED BY; PostgreSQL silently falls back to a scan.
test('the PostgreSQL metric records query carries the partial index predicate verbatim', () => {
  const index =
    /CREATE INDEX IF NOT EXISTS idx_workflow_events_metrics\s+ON [^\n]+\s+WHERE ([^;]+);/.exec(
      getSchemaSQL()
    );
  expect(index).not.toBeNull();
  const predicate = normalize(index?.[1] ?? '');
  const query = normalize(metricRecordsSql(postgresDialect)).replace(/\be\./g, '');
  expect(query).toContain(`WHERE ${predicate}`);
});
