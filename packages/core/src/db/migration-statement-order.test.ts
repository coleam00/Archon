import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Statement-ordering guard for the combined Postgres schema (#2508, #2443).
 *
 * `initSchema()` applies `migrations/000_combined.sql` top-to-bottom inside ONE
 * transaction and re-throws fatally, so a single statement that references a
 * not-yet-existing column rolls the whole apply back and crash-loops the boot.
 *
 * The trap is that `CREATE TABLE IF NOT EXISTS` is a NO-OP on an existing
 * database. A column declared only in that block therefore does not exist when
 * upgrading — while a fresh install has it, which is exactly why this class of
 * bug ships green.
 *
 * The schema answers this structurally: every statement that names a column
 * (`CREATE INDEX`, `COMMENT ON COLUMN`) lives in one trailing section below the
 * additive `ALTER TABLE ... ADD COLUMN` block. These tests pin that layout, so
 * an index written next to its table body fails here instead of on a user's
 * upgrade. `scripts/check-schema-upgrades.ts` proves the same property against
 * real PostgreSQL databases created by older releases.
 *
 * No mocks and no database: this reads the SQL and asserts on offsets, so it is
 * safe in any test batch.
 */

const SCHEMA_SQL = readFileSync(
  resolve(import.meta.dir, '../../../../migrations/000_combined.sql'),
  'utf8'
);

/** Header of the trailing section that owns every column-referencing statement. */
const SECTION_HEADER = '-- Indexes and column comments';

function offsetsOf(pattern: RegExp): number[] {
  const offsets: number[] = [];
  for (const match of SCHEMA_SQL.matchAll(pattern)) offsets.push(match.index);
  return offsets;
}

/** Offset of the last `ADD COLUMN IF NOT EXISTS` — the end of the additive block. */
function lastAddColumnOffset(): number {
  const offsets = offsetsOf(/ADD COLUMN IF NOT EXISTS/gi);
  expect(offsets.length).toBeGreaterThan(0);
  return offsets[offsets.length - 1];
}

describe('migrations/000_combined.sql — statement ordering', () => {
  test('the trailing section exists and follows every ADD COLUMN', () => {
    const section = SCHEMA_SQL.indexOf(SECTION_HEADER);
    expect(section).toBeGreaterThan(-1);
    expect(section).toBeGreaterThan(lastAddColumnOffset());
  });

  test('every CREATE INDEX lives in that trailing section', () => {
    const section = SCHEMA_SQL.indexOf(SECTION_HEADER);
    const indexes = offsetsOf(/^CREATE\s+(UNIQUE\s+)?INDEX/gim);

    expect(indexes.length).toBeGreaterThan(0);
    for (const offset of indexes) {
      // An index above the section indexes a column that may not exist yet on an
      // upgrading database — the #2508 crash-loop.
      expect(offset).toBeGreaterThan(section);
    }
  });

  test('every COMMENT ON COLUMN lives in that trailing section', () => {
    const section = SCHEMA_SQL.indexOf(SECTION_HEADER);
    const comments = offsetsOf(/^COMMENT ON COLUMN/gim);

    expect(comments.length).toBeGreaterThan(0);
    for (const offset of comments) {
      expect(offset).toBeGreaterThan(section);
    }
  });

  test('the sequence and DEFAULT that own event_order follow its ADD COLUMN', () => {
    // These two stay in the additive block rather than the trailing section:
    // they are part of adding the column, and they fail with the same 42703 if
    // they run first.
    const addColumn = SCHEMA_SQL.indexOf('ADD COLUMN IF NOT EXISTS event_order');
    expect(addColumn).toBeGreaterThan(-1);
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
