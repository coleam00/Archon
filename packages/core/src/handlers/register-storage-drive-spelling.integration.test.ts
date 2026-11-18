// @archon-test-isolated
// @archon-test-windows
/**
 * A checkout registered under one spelling of its Windows path (forward slashes, a lowercase
 * drive) is the same checkout under another. Uses a REAL bun:sqlite database and real git
 * checkouts, like register-storage-collisions.integration.test.ts, and mocks
 * ../db/connection with that real adapter, so it runs in its own process.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { createFileWorkflowHost } from '../workflows/file-host';

const { SqliteAdapter, sqliteDialect } = await import('../db/adapters/sqlite');
const db = new SqliteAdapter(':memory:');

const realConnection = await import('../db/connection');
mock.module('../db/connection', () => ({
  ...realConnection,
  pool: db,
  getDatabase: () => db,
  getDialect: () => sqliteDialect,
  getDatabaseType: () => 'sqlite',
}));

import { registerRepository as registerInStore } from './clone';
import { resolveCodebaseForPath } from '../services/codebase-checkout-resolver';

const codebases = await import('../db/codebases');

const trackTempRoot = trackTempRoots();
const initialArchonHome = process.env.ARCHON_HOME;
afterEach(async () => {
  if (initialArchonHome === undefined) delete process.env.ARCHON_HOME;
  else process.env.ARCHON_HOME = initialArchonHome;
  await db.query('DELETE FROM remote_agent_codebases');
});

async function makeHome(): Promise<string> {
  const root = trackTempRoot(await realpath(await mkdtemp(join(tmpdir(), 'archon-collide-'))));
  process.env.ARCHON_HOME = join(root, '.archon');
  return root;
}

async function gitCheckout(path: string, remote: string): Promise<string> {
  await mkdir(path, { recursive: true });
  execFileSync('git', ['-C', path, 'init', '-q']);
  execFileSync('git', ['-C', path, 'remote', 'add', 'origin', remote]);
  return path;
}

describe('Windows path spelling of a registered checkout', () => {
  test.skipIf(process.platform !== 'win32').each(['sql', 'file'] as const)(
    'a registration stored with forward slashes and a lowercase drive is the same checkout (%s)',
    async backend => {
      const root = await makeHome();
      const store =
        backend === 'sql'
          ? codebases
          : (await createFileWorkflowHost(join(root, 'store'))).records.codebases;
      const checkout = await gitCheckout(join(root, 'Quay2'), 'https://github.com/acme/quay.git');
      const registered = await registerInStore(store, checkout);
      const stored = checkout.charAt(0).toLowerCase() + checkout.slice(1).replaceAll('\\', '/');
      await store.updateCodebase(
        { id: registered.codebaseId, name: registered.name },
        { default_cwd: stored }
      );

      const again = await registerInStore(store, checkout);
      expect(again).toMatchObject({ alreadyExisted: true, codebaseId: registered.codebaseId });
      expect((await resolveCodebaseForPath(checkout, store)).codebase?.id).toBe(
        registered.codebaseId
      );
      expect((await store.findCodebaseByPathPrefix(join(checkout, 'src', 'deep')))?.id).toBe(
        registered.codebaseId
      );
      expect(await store.findCodebaseByPathPrefix(`${checkout}-staging`)).toBeNull();
      expect(await store.listCodebases()).toMatchObject([{ default_cwd: stored }]);
      expect(await store.listCodebases()).toHaveLength(1);
    }
  );
});
