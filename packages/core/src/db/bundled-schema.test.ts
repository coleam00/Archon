import { describe, test, expect, mock } from 'bun:test';

// Binary-mode variant — must be in a separate file from source-mode tests
// because mock.module() is process-global in Bun (see CLAUDE.md test isolation rules).
// This file mocks BUNDLED_IS_BINARY=true; the source-build path is verified
// by postgres.test.ts indirectly when bundled-schema is NOT mocked.

mock.module('@archon/paths', () => ({
  BUNDLED_IS_BINARY: true,
}));

import { getSchemaSQL } from './bundled-schema';
import { BUNDLED_SCHEMA_SQL } from './bundled-schema.generated';

describe('getSchemaSQL() — binary build', () => {
  test('returns the embedded BUNDLED_SCHEMA_SQL constant (not a disk read)', () => {
    const result = getSchemaSQL();
    expect(result).toBe(BUNDLED_SCHEMA_SQL);
  });

  test('BUNDLED_SCHEMA_SQL is non-empty and contains expected table markers', () => {
    expect(BUNDLED_SCHEMA_SQL.length).toBeGreaterThan(1000);
    expect(BUNDLED_SCHEMA_SQL).toContain('remote_agent_codebases');
    expect(BUNDLED_SCHEMA_SQL).toContain('CREATE TABLE IF NOT EXISTS');
  });
});
