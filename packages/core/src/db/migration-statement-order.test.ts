import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Statement-ordering guard for the combined Postgres schema (#2508).
 *
 * `initSchema()` applies `migrations/000_combined.sql` top-to-bottom inside ONE
 * transaction and re-throws fatally, so a single statement that references a
 * not-yet-existing column rolls the whole apply back and crash-loops the boot.
 *
 * The trap is that `CREATE TABLE IF NOT EXISTS` is a NO-OP on an existing
 * database. A column declared only in that block therefore does not exist when
 * upgrading — while a fresh install has it, which is exactly why this class of
 * bug ships green. Anything referencing such a column must sit AFTER the
 * `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` in the additive block.
 *
 * No mocks and no database: this reads the SQL and asserts on offsets, so it is
 * safe in any test batch.
 */

const SCHEMA_SQL = readFileSync(
  resolve(import.meta.dir, '../../../../migrations/000_combined.sql'),
  'utf8'
);

describe('migrations/000_combined.sql — statement ordering', () => {
  test('event_order is added before anything indexes it (#2508)', () => {
    const addColumn = SCHEMA_SQL.indexOf('ADD COLUMN IF NOT EXISTS event_order');
    expect(addColumn).toBeGreaterThan(-1);

    // EVERY reference must follow the ADD COLUMN — not merely the first one.
    // The original bug was a duplicate index ~265 lines above it.
    const indexOffsets: number[] = [];
    const indexRef = /CREATE\s+UNIQUE\s+INDEX[^;]*idx_workflow_events_run_order/gi;
    for (const m of SCHEMA_SQL.matchAll(indexRef)) indexOffsets.push(m.index);

    expect(indexOffsets.length).toBeGreaterThan(0);
    for (const offset of indexOffsets) {
      expect(offset).toBeGreaterThan(addColumn);
    }
  });

  test('the sequence and DEFAULT that own event_order also follow the ADD COLUMN', () => {
    const addColumn = SCHEMA_SQL.indexOf('ADD COLUMN IF NOT EXISTS event_order');
    // `OWNED BY ...event_order` and `ALTER COLUMN event_order SET DEFAULT` fail
    // with the same 42703 if they run first.
    expect(SCHEMA_SQL.indexOf('OWNED BY remote_agent_workflow_events.event_order')).toBeGreaterThan(
      addColumn
    );
    expect(SCHEMA_SQL.indexOf('ALTER COLUMN event_order SET DEFAULT')).toBeGreaterThan(addColumn);
  });

  test('the CREATE TABLE body still declares event_order, so fresh installs are unaffected', () => {
    // The additive block is what upgrades rely on; the inline declaration is
    // what makes a fresh database correct without it. Both must stay.
    const createTable = SCHEMA_SQL.indexOf(
      'CREATE TABLE IF NOT EXISTS remote_agent_workflow_events'
    );
    const tableBody = SCHEMA_SQL.slice(createTable, SCHEMA_SQL.indexOf(');', createTable));
    expect(tableBody).toContain('event_order BIGINT');
  });
});
