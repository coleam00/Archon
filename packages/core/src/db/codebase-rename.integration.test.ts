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

for (const [index, [name, variant]] of [
  ['acme api', 'Acme API'],
  ['münchen', 'MÜNCHEN'],
].entries()) {
  test(`SQLite refuses a case variant of another project's name: ${variant}`, async () => {
    const codebases = await import('./codebases');
    const existing = await codebases.createCodebase({
      name,
      default_cwd: `/repos/case-${index}-existing`,
    });
    const candidate = await codebases.createCodebase({
      name: `candidate-${index}`,
      default_cwd: `/repos/case-${index}-candidate`,
    });

    await expect(codebases.renameCodebase(candidate.id, variant)).rejects.toBeInstanceOf(
      codebases.CodebaseNameTakenError
    );
    expect((await codebases.getCodebase(candidate.id))?.name).toBe(candidate.name);
    expect((await codebases.getCodebase(existing.id))?.name).toBe(name);
    expect((await codebases.renameCodebase(existing.id, variant)).name).toBe(variant);
  });
}
