#!/usr/bin/env bun
/**
 * Regenerates packages/core/src/db/bundled-schema.generated.ts from
 * migrations/000_combined.sql.
 *
 * Why: PostgresAdapter applies this SQL on startup so the schema converges
 * automatically. The SQL must be embedded at build time so the compiled binary
 * can run it without filesystem access to migrations/.
 *
 * Usage:
 *   bun run scripts/generate-bundled-schema.ts          # write
 *   bun run scripts/generate-bundled-schema.ts --check  # verify (exit 2 if stale)
 *
 * Exit codes:
 *   0  file generated (and unchanged, if --check)
 *   1  unexpected error (missing source, unreadable, etc.)
 *   2  --check was passed and the file would change
 */
import { readFile, writeFile } from 'fs/promises';
import { join, resolve } from 'path';

const REPO_ROOT = resolve(import.meta.dir, '..');
const SQL_PATH = join(REPO_ROOT, 'migrations/000_combined.sql');
const OUTPUT_PATH = join(REPO_ROOT, 'packages/core/src/db/bundled-schema.generated.ts');
const CHECK_ONLY = process.argv.includes('--check');

async function main(): Promise<void> {
  const raw = await readFile(SQL_PATH, 'utf-8');
  // Normalize to LF so output is identical regardless of the checkout's
  // line-ending policy (e.g. Windows `core.autocrlf=true` yields CRLF).
  const sql = raw.replace(/\r\n/g, '\n');

  const contents = [
    '/**',
    ' * AUTO-GENERATED — DO NOT EDIT.',
    ' *',
    ' * Regenerate with: bun run generate:bundled-schema',
    ' * Verify up-to-date: bun run check:bundled-schema',
    ' *',
    ' * Source of truth: migrations/000_combined.sql',
    ' *',
    ' * Embedded as an inline string literal so the compiled binary can apply',
    ' * the schema on startup without filesystem access to the migrations dir.',
    ' */',
    '',
    `export const BUNDLED_SCHEMA_SQL = ${JSON.stringify(sql)};`,
    '',
  ].join('\n');

  if (CHECK_ONLY) {
    let existing = '';
    try {
      const rawExisting = await readFile(OUTPUT_PATH, 'utf-8');
      existing = rawExisting.replace(/\r\n/g, '\n');
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== 'ENOENT') throw err;
    }
    if (existing !== contents) {
      console.error('bundled-schema.generated.ts is stale.\nRun: bun run generate:bundled-schema');
      process.exit(2);
    }
    console.log('bundled-schema.generated.ts is up to date.');
    return;
  }

  await writeFile(OUTPUT_PATH, contents, 'utf-8');
  console.log(`Wrote ${OUTPUT_PATH} (${sql.length} chars).`);
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(msg);
  process.exit(1);
});
