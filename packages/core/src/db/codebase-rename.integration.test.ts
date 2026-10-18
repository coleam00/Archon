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

test('SQLite renames a project and refuses a taken name', async () => {
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

// Owner/repo names set the storage path, so a case change to one is refused as a
// storage move. These names store under the checkout basename, as the rename allows.
test('SQLite refuses a name another project uses in a different case', async () => {
  const codebases = await import('./codebases');
  const taken = await codebases.createCodebase({
    name: 'acme api',
    default_cwd: '/home/user/code/acme-api',
  });
  const other = await codebases.createCodebase({ name: 'b', default_cwd: '/home/user/code/b' });

  await expect(codebases.renameCodebase(other.id, 'Acme API')).rejects.toBeInstanceOf(
    codebases.CodebaseNameTakenError
  );
  expect((await codebases.getCodebase(other.id))?.name).toBe('b');

  expect((await codebases.renameCodebase(taken.id, 'Acme API')).name).toBe('Acme API');
});
