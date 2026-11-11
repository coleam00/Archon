// @archon-test-isolated
import { afterAll, expect, mock, test } from 'bun:test';
import { mkdtemp, realpath } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { removeTempTree } from '@archon/paths/test-utils';
import type { RemoteIdentityReader } from '../services/registration-remote';

const root = await realpath(await mkdtemp(join(tmpdir(), 'archon-registration-replay-')));
process.env.ARCHON_HOME = join(root, 'home');

const { SqliteAdapter, sqliteDialect } = await import('./adapters/sqlite');
const db = new SqliteAdapter(join(root, 'archon.db'));
const connection = await import('./connection');
mock.module('./connection', () => ({
  ...connection,
  pool: db,
  getDatabase: () => db,
  getDialect: () => sqliteDialect,
  getDatabaseType: () => 'sqlite',
}));
const { createCodebase } = await import('./codebases');

afterAll(async () => {
  await db.close();
  await removeTempTree(root);
});

test('a replayed registration transaction reads each registered project identity once', async () => {
  const registered = ['one', 'two', 'three'];
  for (const name of registered) {
    await db.query(
      'INSERT INTO remote_agent_codebases (name, repository_url, default_cwd) VALUES ($1, $2, $3)',
      [`owner/${name}`, `https://example.com/owner/${name}.git`, join(root, name)]
    );
  }

  // SQLite replays the whole block when another process commits during it; roll the first
  // attempt back after it ran, as that replay does.
  const runTransaction = db.withTransaction.bind(db);
  const replay = new Error('replay');
  db.withTransaction = async fn => {
    await runTransaction(async query => {
      await fn(query);
      throw replay;
    }).catch((error: unknown) => {
      if (error !== replay) throw error;
    });
    return runTransaction(fn);
  };

  const reads: string[] = [];
  const readIdentity: RemoteIdentityReader = async project => {
    reads.push(project.name);
    return `example.com/${project.name}`;
  };
  const created = await createCodebase(
    {
      name: 'owner/new',
      repository_url: 'https://example.com/owner/new.git',
      default_cwd: join(root, 'new'),
    },
    readIdentity
  );

  expect(created.name).toBe('owner/new');
  expect(reads.sort()).toEqual(registered.map(name => `owner/${name}`).sort());
});
