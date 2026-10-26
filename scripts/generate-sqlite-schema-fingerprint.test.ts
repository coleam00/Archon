import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';

const track = trackTempRoots();

test('fingerprint generation and freshness ignore checkout line endings but detect source edits', () => {
  const root = track(mkdtempSync(join(tmpdir(), 'sqlite-fingerprint-')));
  const scripts = join(root, 'scripts');
  const directory = join(root, 'packages/core/src/db/adapters');
  mkdirSync(scripts, { recursive: true });
  mkdirSync(directory, { recursive: true });
  const generator = join(scripts, 'generate-sqlite-schema-fingerprint.ts');
  writeFileSync(
    generator,
    readFileSync(join(import.meta.dir, 'generate-sqlite-schema-fingerprint.ts'))
  );
  const inputs = ['sqlite.ts', 'sqlite-migrations.ts', 'sqlite-schema-state.ts'];
  for (const name of inputs) writeFileSync(join(directory, name), `// ${name}\nexport {};\n`);
  const run = (...args: string[]): ReturnType<typeof Bun.spawnSync> =>
    Bun.spawnSync([process.execPath, generator, ...args], { cwd: root });
  expect(run().exitCode).toBe(0);
  expect(run('--check').exitCode).toBe(0);
  const target = join(directory, 'sqlite-schema-fingerprint.generated.ts');
  const original = readFileSync(target, 'utf8');
  for (const name of [...inputs, 'sqlite-schema-fingerprint.generated.ts']) {
    const path = join(directory, name);
    writeFileSync(path, readFileSync(path, 'utf8').replaceAll('\n', '\r\n'));
    expect(run('--check').exitCode).toBe(0);
  }
  expect(run().exitCode).toBe(0);
  expect(readFileSync(target, 'utf8')).toBe(original);
  writeFileSync(join(directory, inputs[0]), 'export const changed = true;\n');
  const stale = run('--check');
  expect(stale.exitCode).toBe(1);
  expect(stale.stderr.toString()).toContain('SQLite schema fingerprint is stale');
  expect(run().exitCode).toBe(0);
  expect(readFileSync(target, 'utf8')).not.toBe(original);
  expect(run('--check').exitCode).toBe(0);
});
