// @archon-test-isolated
import { test, mock, expect } from 'bun:test';
import { mkdtemp, mkdir, realpath, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  try {
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
      await db.query(
        'UPDATE remote_agent_codebases SET kind = $1, default_cwd = $2 WHERE id = $3',
        [kind, 'projects/db', project.id]
      );
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
      await db.query(
        'UPDATE remote_agent_codebases SET kind = $1, default_cwd = $2 WHERE id = $3',
        ['repo', 'projects/db', project.id]
      );
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
  } finally {
    await db.close();
    await removeTempTree(root);
  }
});
