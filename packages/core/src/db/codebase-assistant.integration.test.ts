import { afterAll, expect, mock, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtemp, mkdir, readFile, realpath, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { removeTempTree } from '@archon/paths/test-utils';
import { registerBuiltinProviders, registerCommunityProviders } from '@archon/providers';

const root = await realpath(await mkdtemp(join(tmpdir(), 'archon-assistant-')));
process.env.ARCHON_HOME = join(root, 'home');
await mkdir(process.env.ARCHON_HOME);
const project = join(root, 'project');
await mkdir(join(project, '.claude'), { recursive: true });
const configPath = join(process.env.ARCHON_HOME, 'config.yaml');
await writeFile(configPath, 'defaultAssistant: pi\n');

const legacyProject = join(root, 'legacy-project');
await mkdir(legacyProject);

const databasePath = join(root, 'vintage.db');
const vintage = new Database(databasePath);
vintage.exec(await readFile(join(import.meta.dir, 'fixtures/sqlite-vintages/v0.11.0.sql'), 'utf8'));
vintage.run(
  'INSERT INTO remote_agent_codebases (id, name, default_cwd, ai_assistant_type) VALUES (?, ?, ?, ?)',
  ['old-project', 'old-project', legacyProject, 'codex']
);
vintage.close();

const { SqliteAdapter, sqliteDialect } = await import('./adapters/sqlite');
const db = new SqliteAdapter(databasePath);
mock.module('./connection', () => ({
  pool: db,
  getDatabase: () => db,
  getDialect: () => sqliteDialect,
  getDatabaseType: () => 'sqlite',
}));
const { setPlatformPolicies } = await import('../platforms/registry');
setPlatformPolicies([]);
// The host registers providers before loading configuration.
registerBuiltinProviders();
registerCommunityProviders();
const { updateGlobalConfig } = await import('../config/config-loader');
const { registerFolder, registerRepository } = await import('../handlers/sql-registration');
const { getCodebase } = await import('./codebases');
const { getOrCreateConversation } = await import('./conversations');
const { formatProjectSection, buildOrchestratorSystemAppend } =
  await import('../orchestrator/prompt-builder');

afterAll(async () => {
  await db.close();
  await removeTempTree(root);
});

test('registration leaves the provider unpinned and new conversations follow configuration', async () => {
  const registration = await registerFolder(project, 'project');
  const codebase = await getCodebase(registration.codebaseId);
  expect(codebase).not.toBeNull();
  if (!codebase) throw new Error('Registration did not persist a project');
  expect(codebase.ai_assistant_type).toBeNull();
  const first = await getOrCreateConversation('web', 'first', codebase.id);
  expect(first.ai_assistant_type).toBe('pi');
  expect(await buildOrchestratorSystemAppend(first, [codebase], [])).toContain('- AI Provider: pi');

  await updateGlobalConfig({ defaultAssistant: 'codex' });
  expect((await getOrCreateConversation('web', 'second', codebase.id)).ai_assistant_type).toBe(
    'codex'
  );
  expect((await getOrCreateConversation('web', 'first', codebase.id)).ai_assistant_type).toBe('pi');

  await mkdir(join(project, '.archon'));
  await writeFile(join(project, '.archon', 'config.yaml'), 'assistant: pi\n');
  expect(
    (await getOrCreateConversation('web', 'repo-override', codebase.id)).ai_assistant_type
  ).toBe('pi');
});

test('an upgrade preserves stored project choices and they still win over configuration', async () => {
  const codebase = await getCodebase('old-project');
  expect(codebase?.ai_assistant_type).toBe('codex');
  expect(
    (await getOrCreateConversation('web', 'old-conversation', 'old-project')).ai_assistant_type
  ).toBe('codex');
  if (!codebase) throw new Error('Upgrade lost the project');
  expect(formatProjectSection(codebase)).toContain('- AI Provider: codex');
});

test('repository registration stays unpinned as the global default changes', async () => {
  const repository = join(root, 'repository');
  await mkdir(join(repository, '.claude'), { recursive: true });
  expect(await Bun.spawn(['git', 'init', '-q', repository]).exited).toBe(0);
  await updateGlobalConfig({ defaultAssistant: 'pi' });
  const registration = await registerRepository(repository);
  const codebase = await getCodebase(registration.codebaseId);
  expect(codebase?.ai_assistant_type).toBeNull();
  expect(
    (await getOrCreateConversation('cli', 'repo-first', registration.codebaseId)).ai_assistant_type
  ).toBe('pi');
  await updateGlobalConfig({ defaultAssistant: 'codex' });
  expect(
    (await getOrCreateConversation('cli', 'repo-second', registration.codebaseId)).ai_assistant_type
  ).toBe('codex');
});

test('an unrelated project with an invalid config does not break the chat prompt', async () => {
  const active = await getCodebase('old-project');
  if (!active) throw new Error('Upgrade lost the project');
  const brokenDir = join(root, 'broken-project');
  await mkdir(join(brokenDir, '.archon'), { recursive: true });
  await writeFile(join(brokenDir, '.archon', 'config.yaml'), 'assistants: not-a-map\n');
  const broken = { ...active, id: 'broken', name: 'broken', default_cwd: brokenDir };
  const unpinned = { ...broken, ai_assistant_type: null };
  const scoped = await getOrCreateConversation('web', 'scoped-chat', active.id);

  const prompt = await buildOrchestratorSystemAppend(scoped, [active, unpinned], []);
  expect(prompt).toContain('### broken\n');
  expect(prompt.match(/- AI Provider: /g)).toHaveLength(1);
  const pinned = await buildOrchestratorSystemAppend(scoped, [active, broken], []);
  expect(pinned.match(/- AI Provider: codex/g)).toHaveLength(2);
  const unscoped = await getOrCreateConversation('web', 'unscoped-chat');
  expect(await buildOrchestratorSystemAppend(unscoped, [active, unpinned], [])).toContain(
    '### broken\n'
  );
});
