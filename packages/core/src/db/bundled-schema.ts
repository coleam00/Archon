/**
 * Bundled Postgres schema SQL for binary distribution.
 *
 * Content lives in `bundled-schema.generated.ts`, regenerated from
 * `migrations/000_combined.sql` by `scripts/generate-bundled-schema.ts`.
 *
 * In source builds, `getSchemaSQL()` reads the file from disk so developers
 * always run against the latest version without re-generating.
 * In binary builds, the embedded string is used (no filesystem access needed).
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { BUNDLED_IS_BINARY } from '@archon/paths';
import { BUNDLED_SCHEMA_SQL } from './bundled-schema.generated';

export function getSchemaSQL(): string {
  if (BUNDLED_IS_BINARY) {
    return BUNDLED_SCHEMA_SQL;
  }
  // In source builds, read from disk so changes to 000_combined.sql are
  // picked up immediately without running generate:bundled-schema.
  return readFileSync(resolve(import.meta.dir, '../../../../migrations/000_combined.sql'), 'utf8');
}
