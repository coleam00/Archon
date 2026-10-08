// @archon-test-isolated
import { afterAll, expect, mock, test } from 'bun:test';
import { SqliteAdapter, sqliteDialect } from './adapters/sqlite';

const db = new SqliteAdapter(':memory:');
mock.module('./connection', () => ({
  pool: db,
  getDatabase: () => db,
  getDialect: () => sqliteDialect,
  getDatabaseType: () => 'sqlite',
}));

afterAll(async () => {
  await db.close();
});

test('SQLite renames through the conditional UPDATE and refuses a taken name', async () => {
  const codebases = await import('./codebases');
  const qes = await codebases.createCodebase({
    name: '_git/QUIBIQ%20EDI%20Service',
    default_cwd: '/home/user/code/qes',
  });
  await codebases.createCodebase({ name: 'other', default_cwd: '/home/user/code/other' });

  await expect(codebases.renameCodebase(qes.id, 'other')).rejects.toBeInstanceOf(
    codebases.CodebaseNameTakenError
  );
  expect((await codebases.getCodebase(qes.id))?.name).toBe('_git/QUIBIQ%20EDI%20Service');

  expect((await codebases.renameCodebase(qes.id, 'qes')).name).toBe('qes');
  expect((await codebases.findCodebaseByName('qes'))?.id).toBe(qes.id);
});
