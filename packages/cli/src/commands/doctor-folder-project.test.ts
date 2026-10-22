import { describe, it, expect } from 'bun:test';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdirSync, mkdtempSync, symlinkSync } from 'fs';
import { canonicalizeProjectPath } from '@archon/paths';
import { removeTempTree } from '@archon/paths/test-utils';
import { checkFolderProject, type FolderProjectDeps } from './doctor-folder-project';

describe('checkFolderProject', () => {
  function makeDeps(over: Partial<FolderProjectDeps> = {}): FolderProjectDeps {
    return {
      findCodebaseByDefaultCwd: async () => null,
      findCodebaseByPathPrefix: async () => null,
      listChildRepos: async () => [],
      ...over,
    };
  }

  it('reports a folder project and its contained repos', async () => {
    const deps = makeDeps({
      findCodebaseByDefaultCwd: async () => ({
        name: 'platform',
        default_cwd: '/tmp/platform',
        kind: 'folder',
      }),
      listChildRepos: async () => ['auth-service', 'billing-service'],
    });

    const result = await checkFolderProject('/tmp/platform', async () => deps);
    expect(result.status).toBe('pass');
    expect(result.message).toContain('platform');
    expect(result.message).toContain('2 contained repo(s)');
    expect(result.message).toContain('auth-service');
  });

  it('truncates the contained-repo list at 10 with a "+N more" suffix', async () => {
    const many = Array.from({ length: 14 }, (_, i) => `svc-${String(i).padStart(2, '0')}`);
    const deps = makeDeps({
      findCodebaseByPathPrefix: async () => ({
        name: 'big',
        default_cwd: '/tmp/big',
        kind: 'folder',
      }),
      listChildRepos: async () => many,
    });

    const result = await checkFolderProject('/tmp/big/subdir', async () => deps);
    expect(result.status).toBe('pass');
    expect(result.message).toContain('14 contained repo(s)');
    expect(result.message).toContain('(+4 more)');
  });

  it('skips quietly when cwd is a repo-kind project', async () => {
    const deps = makeDeps({
      findCodebaseByDefaultCwd: async () => ({
        name: 'owner/repo',
        default_cwd: '/repos/repo',
        kind: 'repo',
      }),
    });

    const result = await checkFolderProject('/repos/repo', async () => deps);
    expect(result.status).toBe('skip');
    expect(result.message).toContain('not a registered folder project');
  });

  it('skips quietly when cwd is unregistered', async () => {
    const result = await checkFolderProject('/tmp/random', async () => makeDeps());
    expect(result.status).toBe('skip');
  });

  it('skips (not fail) when the database lookup throws', async () => {
    const deps = makeDeps({
      findCodebaseByDefaultCwd: async () => {
        throw new Error('connection refused');
      },
    });
    const result = await checkFolderProject('/tmp/x', async () => deps);
    expect(result.status).toBe('skip');
    expect(result.message).toContain('database unavailable');
  });

  // #2927: doctor has to ask the database the same question the CLI gate asks,
  // or it reports "not a registered folder project" for a directory every other
  // command resolves fine. It looked the raw cwd up, so any directory reached
  // through a link — or through a Windows 8.3 short path — missed.
  it('looks up the shared canonicalizer output, not the raw cwd', async () => {
    const root = mkdtempSync(join(tmpdir(), 'archon-doctor-canon-'));
    const target = join(root, 'platform');
    const link = join(root, 'platform-link');
    mkdirSync(target);
    // 'junction' is ignored on POSIX and needs no elevated privileges on Windows.
    symlinkSync(target, link, 'junction');
    const lookedUp: string[] = [];
    try {
      const deps = makeDeps({
        findCodebaseByDefaultCwd: async (cwd: string) => {
          lookedUp.push(cwd);
          return null;
        },
      });

      await checkFolderProject(link, async () => deps);

      expect(lookedUp).toEqual([await canonicalizeProjectPath(target)]);
    } finally {
      await removeTempTree(root);
    }
  });
});
