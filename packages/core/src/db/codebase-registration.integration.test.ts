// @archon-test-isolated
import { afterAll, expect, mock, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';
import { SqliteAdapter, sqliteDialect } from './adapters/sqlite';

const root = await mkdtemp(join(tmpdir(), 'archon-registration-'));
const path = join(root, 'registry.sqlite');
const databases = [new SqliteAdapter(path), new SqliteAdapter(path)];
let connection = 0;
mock.module('./connection', () => ({
  pool: databases[0],
  getDatabase: () => databases[connection++ % databases.length],
  getDialect: () => sqliteDialect,
  getDatabaseType: () => 'sqlite',
}));
const { createCodebase, createManagedCodebase, listCodebases } = await import('./codebases');

afterAll(async () => {
  for (const db of databases) await db.close();
  await removeTempTree(root);
});

for (const kind of ['folder', 'repo'] as const) {
  test(`independent SQLite connections cannot claim the same ${kind} storage`, async () => {
    const results = await Promise.allSettled([
      createCodebase({ name: `${kind}-My App`, default_cwd: '/first/api', kind }),
      createCodebase({ name: `${kind}-my-app`, default_cwd: '/second/api', kind }),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(result => result.status === 'rejected');
    expect(rejected?.status === 'rejected' && String(rejected.reason)).toContain('storage');
  });
}

test('independent forge claims allocate separate managed roots', async () => {
  const projects = await Promise.all([
    createManagedCodebase({
      name: 'acme/api',
      default_cwd: '/first',
      repository_url: 'https://github.com/acme/api',
    }),
    createManagedCodebase({
      name: 'acme/api',
      default_cwd: '/second',
      repository_url: 'https://gitlab.example/acme/api',
    }),
  ]);
  expect(new Set(projects.map(project => project.name)).size).toBe(2);
  expect(new Set(projects.map(project => project.default_cwd)).size).toBe(2);
  expect(await listCodebases()).toHaveLength(4);
});

test('concurrent registrations with distinct names cannot claim the same remote', async () => {
  const results = await Promise.allSettled([
    createCodebase({
      name: 'acme/production',
      default_cwd: '/production',
      repository_url: 'https://github.com/acme/app.git',
    }),
    createCodebase({
      name: 'acme/development',
      default_cwd: '/development',
      repository_url: 'git@github.com:acme/app.git',
    }),
  ]);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  const rejected = results.find(result => result.status === 'rejected');
  expect(rejected?.status === 'rejected' && String(rejected.reason)).toContain('worktrees');
});
