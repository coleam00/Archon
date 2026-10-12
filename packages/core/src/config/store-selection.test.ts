import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { trackTempRoots } from '@archon/paths/test-utils';
import { loadStoreSelection } from './store-selection';
const roots = trackTempRoots();
// Restore the keys in place: assigning a new object to process.env drops
// Bun's case-insensitive Windows env, so later files read PATH as undefined.
const prior = Object.fromEntries(
  ['ARCHON_HOME', 'DATABASE_URL'].map(key => [key, process.env[key]])
);
afterEach(() => {
  for (const [key, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
test('database stays the default and invalid selection never falls back to SQL', async () => {
  const home = roots(await mkdtemp(join(tmpdir(), 'store-selection-')));
  process.env.ARCHON_HOME = home;
  process.env.DATABASE_URL = '';
  expect(await loadStoreSelection()).toBe('database');
  for (const config of ['botName: Archon\n', 'store: database\n', 'store: files\n']) {
    await writeFile(join(home, 'config.yaml'), config);
    expect(await loadStoreSelection()).toBe(config.includes('files') ? 'files' : 'database');
  }
  await writeFile(join(home, 'config.yaml'), 'store: typo\n');
  await expect(loadStoreSelection()).rejects.toThrow();
  await writeFile(join(home, 'config.yaml'), 'store: [\n');
  await expect(loadStoreSelection()).rejects.toThrow();
});
