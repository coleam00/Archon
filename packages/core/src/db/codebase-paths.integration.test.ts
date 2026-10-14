// @archon-test-isolated
import { test, mock, expect, afterAll } from 'bun:test';
import { mkdtemp, mkdir, realpath, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { WorktreeProvider } from '@archon/isolation';
import {
  canonicalizeProjectPath,
  getProjectStoragePaths,
  resolveProjectStorageKey,
} from '@archon/paths';
import { getWorktreeBase, toRepoPath } from '@archon/git';
import { removeTempTree } from '@archon/paths/test-utils';
import { createMockPlatform } from '../test/mocks/platform';
import { quoteCommandArg } from '../utils/command-args';
import { SqliteAdapter, sqliteDialect } from './adapters/sqlite';
import { verifyCodebasePathContract } from '../test/codebase-path-contract';

// Conversations need a configured default provider; isolate the home that supplies it.
const root = await realpath(await mkdtemp(join(tmpdir(), 'archon-codebase-paths-')));
const archonHome = join(root, 'home');
process.env.ARCHON_HOME = archonHome;
await mkdir(archonHome);
await writeFile(join(archonHome, 'config.yaml'), 'defaultAssistant: claude\n');

const db = new SqliteAdapter(':memory:');
mock.module('./connection', () => ({
  pool: db,
  getDatabase: () => db,
  getDialect: () => sqliteDialect,
  getDatabaseType: () => 'sqlite',
}));

test('SQLite rejects legacy paths and preserves registration identity on explicit repair', async () => {
  await verifyCodebasePathContract(db);
  const codebases = await import('./codebases');
  const conversations = await import('./conversations');
  const { handleMessage } = await import('../orchestrator/orchestrator-agent');
  const project = await codebases.findCodebaseByName('Client "Ops"');
  if (!project) throw new Error('Missing contract project');
  const conversation = await conversations.getOrCreateConversation('mock', 'legacy-repair');
  await conversations.updateConversation(conversation.id, { codebase_id: project.id });
  await db.query('UPDATE remote_agent_codebases SET default_cwd = $1 WHERE id = $2', [
    'projects/repo',
    project.id,
  ]);
  const platform = createMockPlatform();
  const brokenRepo = join(root, 'broken-repo');
  await mkdir(brokenRepo);
  await writeFile(join(brokenRepo, '.git'), `gitdir: ${join(root, 'missing-gitdir')}\n`);
  await handleMessage(
    platform,
    'legacy-repair',
    `/register-project ${quoteCommandArg(project.name)} ${quoteCommandArg(brokenRepo)}`,
    { actor: { kind: 'operator' } }
  );
  expect(platform.sendMessage.mock.calls[0]?.[1]).toContain('Nothing was registered');
  expect(await codebases.listCodebaseRegistrations()).toEqual([
    { id: project.id, name: project.name, kind: 'folder', stored_default_cwd: 'projects/repo' },
  ]);
  platform.sendMessage.mockClear();
  const repoPath = await canonicalizeProjectPath(import.meta.dir);
  const folderPath = join(root, 'plain-folder');
  await mkdir(folderPath);
  const { resolveProjectPaths } = await import('@archon/workflows/executor');
  for (const kind of ['folder', 'repo'] as const) {
    await db.query('UPDATE remote_agent_codebases SET kind = $1, default_cwd = $2 WHERE id = $3', [
      kind,
      'projects/db',
      project.id,
    ]);
    const legacy = { ...project, kind, default_cwd: 'projects/db' };
    const storage = getProjectStoragePaths(resolveProjectStorageKey(legacy, legacy.default_cwd));
    await mkdir(storage.stateRoot, { recursive: true });
    await writeFile(join(storage.stateRoot, 'saved.txt'), kind);
    platform.sendMessage.mockClear();
    await handleMessage(
      platform,
      'legacy-repair',
      `/register-project ${quoteCommandArg(project.name)} ${quoteCommandArg(kind === 'folder' ? repoPath : folderPath)}`,
      { actor: { kind: 'operator' } }
    );
    expect(platform.sendMessage.mock.calls[0]?.[1]).toContain('would move its Archon storage');
    expect(await codebases.listCodebaseRegistrations()).toEqual([
      { id: project.id, name: project.name, kind, stored_default_cwd: legacy.default_cwd },
    ]);
    const sameKindPath = kind === 'folder' ? folderPath : repoPath;
    platform.sendMessage.mockClear();
    await handleMessage(
      platform,
      'legacy-repair',
      `/register-project ${quoteCommandArg(project.name)} ${quoteCommandArg(sameKindPath)}`,
      { actor: { kind: 'operator' } }
    );
    expect(platform.sendMessage.mock.calls[0]?.[1]).toContain('re-registered successfully');
    const nextRun = await resolveProjectPaths(
      { store: { getCodebase: codebases.getCodebase } },
      sameKindPath,
      `next-${kind}`,
      project.id
    );
    expect(nextRun.stateDir).toBe(storage.stateRoot);
    expect(await readFile(join(nextRun.stateDir, 'saved.txt'), 'utf8')).toBe(kind);
  }
  for (const { replacementPath, movesWorktreesOnly } of [
    { replacementPath: join(root, 'different-basename'), movesWorktreesOnly: false },
    {
      replacementPath: join(archonHome, 'workspaces', 'acme', 'widget', 'db'),
      movesWorktreesOnly: true,
    },
  ]) {
    await mkdir(replacementPath, { recursive: true });
    const init = Bun.spawn(['git', '-C', replacementPath, 'init'], {
      stdout: 'ignore',
      stderr: 'pipe',
    });
    expect(await init.exited).toBe(0);
    await db.query('UPDATE remote_agent_codebases SET kind = $1, default_cwd = $2 WHERE id = $3', [
      'repo',
      'projects/db',
      project.id,
    ]);
    const legacy = { ...project, kind: 'repo' as const, default_cwd: 'projects/db' };
    const replacement = { ...legacy, default_cwd: replacementPath };
    const currentRoot = getProjectStoragePaths(
      resolveProjectStorageKey(legacy, legacy.default_cwd)
    ).root;
    const replacementRoot = getProjectStoragePaths(
      resolveProjectStorageKey(replacement, replacement.default_cwd)
    ).root;
    if (movesWorktreesOnly) {
      expect(replacementRoot).toBe(currentRoot);
      expect(getWorktreeBase(toRepoPath(replacementPath), project.name).base).not.toBe(
        getWorktreeBase(toRepoPath(legacy.default_cwd), project.name).base
      );
    } else {
      expect(replacementRoot).not.toBe(currentRoot);
    }
    platform.sendMessage.mockClear();
    await handleMessage(
      platform,
      'legacy-repair',
      `/register-project ${quoteCommandArg(project.name)} ${quoteCommandArg(replacementPath)}`,
      { actor: { kind: 'operator' } }
    );
    expect(platform.sendMessage.mock.calls[0]?.[1]).toContain('would move its Archon storage');
    expect(await codebases.listCodebaseRegistrations()).toEqual([
      {
        id: project.id,
        name: project.name,
        kind: 'repo',
        stored_default_cwd: legacy.default_cwd,
      },
    ]);
  }
  await db.query('UPDATE remote_agent_codebases SET kind = $1, default_cwd = $2 WHERE id = $3', [
    'folder',
    'projects/repo',
    project.id,
  ]);
  platform.sendMessage.mockClear();
  await handleMessage(
    platform,
    'legacy-repair',
    `/register-project --folder ${quoteCommandArg(project.name)} ${quoteCommandArg(repoPath)}`,
    { actor: { kind: 'operator' } }
  );
  expect(platform.sendMessage.mock.calls[0]?.[1]).toContain('re-registered successfully');
  expect(await codebases.getCodebase(project.id)).toMatchObject({
    ...project,
    kind: 'folder',
    default_cwd: repoPath,
    updated_at: expect.anything(),
  });
  expect(await codebases.listCodebases()).toHaveLength(1);
  expect(
    (await conversations.getConversationByPlatformId('mock', 'legacy-repair'))?.codebase_id
  ).toBe(project.id);
});

afterAll(async () => {
  await db.close();
  await removeTempTree(root);
});

for (const configured of ['both', 'current', 'replacement', 'unchanged'] as const) {
  test(`legacy repair respects repo-local configuration on ${configured} paths`, async () => {
    const codebases = await import('./codebases');
    const { handleMessage } = await import('../orchestrator/orchestrator-agent');
    const provider = new WorktreeProvider();
    const platform = createMockPlatform();
    const currentPath = join(root, configured, 'old', 'db');
    const replacementPath =
      configured === 'unchanged' ? currentPath : join(root, configured, 'new', 'db');
    for (const path of new Set([currentPath, replacementPath])) {
      await mkdir(path, { recursive: true });
      const init = Bun.spawn(['git', '-C', path, 'init'], { stdout: 'ignore', stderr: 'pipe' });
      expect(await init.exited).toBe(0);
    }
    const currentConfig = configured === 'replacement' ? undefined : { path: '.worktrees' };
    const replacementConfig = configured === 'current' ? undefined : { path: '.worktrees' };
    for (const [path, config] of [
      [currentPath, currentConfig],
      [replacementPath, replacementConfig],
    ] as const) {
      if (!config) continue;
      await mkdir(join(path, '.archon'));
      await writeFile(join(path, '.archon', 'config.yaml'), 'worktree:\n  path: .worktrees\n');
      if (configured === 'unchanged') break;
    }
    const project = await codebases.createCodebase({
      name: `configured ${configured}`,
      kind: 'repo',
      default_cwd: currentPath,
    });
    const storedPath = relative(process.cwd(), currentPath);
    const request = {
      codebaseId: project.id,
      codebaseName: project.name,
      canonicalRepoPath: toRepoPath(currentPath),
      workflowType: 'task' as const,
      identifier: 'live',
    };
    const currentWorktree = provider.getWorktreePath(request, 'live', currentConfig);
    const replacementWorktree = provider.getWorktreePath(
      { ...request, canonicalRepoPath: toRepoPath(replacementPath) },
      'live',
      replacementConfig
    );
    expect(
      getProjectStoragePaths(resolveProjectStorageKey({ ...project, kind: 'repo' }, storedPath))
        .root
    ).toBe(
      getProjectStoragePaths(
        resolveProjectStorageKey({ ...project, kind: 'repo' }, replacementPath)
      ).root
    );
    if (configured === 'unchanged') expect(replacementWorktree).toBe(currentWorktree);
    else expect(replacementWorktree).not.toBe(currentWorktree);
    const commit = Bun.spawn(
      [
        'git',
        '-C',
        currentPath,
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '--allow-empty',
        '-m',
        'initial',
      ],
      { stdout: 'ignore', stderr: 'pipe' }
    );
    expect(await commit.exited).toBe(0);
    const add = Bun.spawn(
      ['git', '-C', currentPath, 'worktree', 'add', '-b', 'live', currentWorktree],
      { stdout: 'ignore', stderr: 'pipe' }
    );
    expect(await add.exited).toBe(0);
    await writeFile(join(currentWorktree, 'uncommitted.txt'), configured);
    await db.query('UPDATE remote_agent_codebases SET kind = $1, default_cwd = $2 WHERE id = $3', [
      'repo',
      storedPath,
      project.id,
    ]);
    platform.sendMessage.mockClear();
    await handleMessage(
      platform,
      `configured-${configured}`,
      `/register-project ${quoteCommandArg(project.name)} ${quoteCommandArg(replacementPath)}`,
      { actor: { kind: 'operator' } }
    );
    expect(platform.sendMessage.mock.calls[0]?.[1]).toContain(
      configured === 'unchanged' ? 're-registered successfully' : 'would move its Archon storage'
    );
    expect(
      (await codebases.listCodebaseRegistrations()).filter(row => row.id === project.id)
    ).toEqual([
      {
        id: project.id,
        name: project.name,
        kind: 'repo',
        stored_default_cwd: configured === 'unchanged' ? replacementPath : storedPath,
      },
    ]);
    expect(await readFile(join(currentWorktree, 'uncommitted.txt'), 'utf8')).toBe(configured);
  });
}

test('rename checks the configured worktree location instead of the unused default', async () => {
  const codebases = await import('./codebases');
  const repoPath = join(archonHome, 'workspaces', 'configured', 'rename', 'db');
  await mkdir(join(repoPath, '.archon'), { recursive: true });
  await writeFile(join(repoPath, '.archon', 'config.yaml'), 'worktree:\n  path: .worktrees\n');
  const project = await codebases.createCodebase({
    name: 'configured rename',
    default_cwd: repoPath,
  });
  const newName = '_local/db';
  expect(getWorktreeBase(toRepoPath(repoPath), project.name).base).not.toBe(
    getWorktreeBase(toRepoPath(repoPath), newName).base
  );
  const renamed = await codebases.renameCodebase(project.id, newName);
  expect(renamed.id).toBe(project.id);
  expect(renamed.name).toBe(newName);
  expect(renamed.default_cwd).toBe(repoPath);
});
