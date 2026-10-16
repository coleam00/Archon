// @archon-test-isolated
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getProjectSourcePath, resolveRunStorageRoot } from '@archon/paths';
import { trackTempRoots } from '@archon/paths/test-utils';
import { codebaseRowSchema } from '@archon/core/schemas/codebase';
import { createGitHubAppAuthProvider } from '@archon/core';

const codebases = await import('@archon/core/db/codebases');
const findCodebase = spyOn(codebases, 'findCodebaseByRepoUrl');
const updateCodebase = spyOn(codebases, 'updateCodebase').mockResolvedValue(undefined);

const { GitHubAdapter } = await import('./github/adapter');
const { GitLabAdapter } = await import('../community/forge/gitlab/adapter');
const { GiteaAdapter } = await import('../community/forge/gitea/adapter');
const lock = {
  acquireLock: async (_id: string, handler: () => Promise<void>) => {
    await handler();
    return { status: 'started' as const };
  },
};
const forges = [
  {
    name: 'GitHub',
    host: 'github.com',
    route: () => {
      const adapter = new GitHubAdapter({ kind: 'pat', token: 'test' }, 'secret', lock);
      // @ts-expect-error - exercise the private registration boundary
      return adapter.getOrCreateCodebaseForRepo('acme', 'api');
    },
  },
  {
    name: 'GitLab',
    host: 'gitlab.example.com',
    route: () => {
      const adapter = new GitLabAdapter('test', 'secret', lock, 'https://gitlab.example.com');
      // @ts-expect-error - exercise the private registration boundary
      return adapter.getOrCreateCodebaseForRepo('acme/api');
    },
  },
  {
    name: 'Gitea',
    host: 'gitea.example.com',
    route: () => {
      const adapter = new GiteaAdapter('https://gitea.example.com', 'test', 'secret', lock);
      // @ts-expect-error - exercise the private registration boundary
      return adapter.getOrCreateCodebaseForRepo('acme', 'api');
    },
  },
];
const trackRoot = trackTempRoots();
afterEach(() => {
  findCodebase.mockReset();
  updateCodebase.mockClear();
});

for (const forge of forges) {
  describe(`${forge.name} saved checkout ownership`, () => {
    for (const layout of ['worktrees', 'checkouts']) {
      test.each(['matching', 'configured', 'foreign', 'no-remote', 'invalid'] as const)(
        `checks a real main checkout under ${layout}: %s`,
        async state => {
          const root = trackRoot(await mkdtemp(join(tmpdir(), 'archon-checkout-owner-')));
          const path = join(root, layout, 'api');
          await mkdir(path, { recursive: true });
          if (state === 'invalid') {
            await mkdir(join(path, '.git'));
          } else {
            execFileSync('git', ['-C', path, 'init', '-q']);
            if (state !== 'no-remote') {
              const repo = state === 'foreign' ? 'other/repository' : 'acme/api';
              execFileSync('git', [
                '-C',
                path,
                'remote',
                'add',
                state === 'configured' ? 'upstream' : 'origin',
                `git@${forge.host}:${repo}.git`,
              ]);
            }
            if (state === 'configured') {
              execFileSync('git', [
                '-C',
                path,
                'remote',
                'add',
                'origin',
                `https://${forge.host}/other/repository`,
              ]);
              await mkdir(join(path, '.archon'));
              await writeFile(
                join(path, '.archon', 'config.yaml'),
                'worktree:\n  remote: upstream\n'
              );
            }
          }
          const existing = codebaseRowSchema.parse({
            id: 'a5fc48f1-0c23-4e61-b5f6-eb3b0c6682fd',
            name: 'local-api',
            default_cwd: path,
            repository_url: `https://${forge.host}/acme/api`,
            kind: 'repo',
            commands: {},
            default_branch: null,
            ai_assistant_type: null,
            created_at: new Date(),
            updated_at: new Date(),
          });
          findCodebase.mockResolvedValue(existing);
          if (state === 'matching' || state === 'configured') {
            const result = await forge.route();
            expect(result.repoPath).toBe(path);
            expect(result.codebase).toBe(existing);
          } else {
            await expect(forge.route()).rejects.toThrow('/update-project');
          }
          expect(existing.default_cwd).toBe(path);
          expect(updateCodebase).not.toHaveBeenCalled();
        }
      );
    }
  });
}

for (const forge of forges) {
  test.each(
    forge.name === 'GitHub'
      ? ['matching', 'foreign', 'nonrepository', 'empty', 'missing']
      : ['matching', 'foreign', 'nonrepository', 'missing']
  )(`${forge.name} verifies canonical repair targets: %s`, async state => {
    const root = trackRoot(await mkdtemp(join(tmpdir(), 'archon-repair-owner-')));
    const previousHome = process.env.ARCHON_HOME;
    process.env.ARCHON_HOME = root;
    try {
      const path = getProjectSourcePath('acme', 'api');
      if (state !== 'missing') {
        await mkdir(path, { recursive: true });
        if (state === 'nonrepository') await writeFile(join(path, 'foreign.txt'), 'occupied');
        if (state !== 'nonrepository' && state !== 'empty') {
          execFileSync('git', ['-C', path, 'init', '-q']);
          execFileSync('git', [
            '-C',
            path,
            'remote',
            'add',
            'origin',
            `https://${forge.host}/${state === 'foreign' ? 'other/repo' : 'acme/api'}`,
          ]);
        }
      }
      const stale = join(root, 'workspaces', 'acme', 'api', 'worktrees', 'old');
      const existing = codebaseRowSchema.parse({
        id: 'a5fc48f1-0c23-4e61-b5f6-eb3b0c6682fd',
        name: 'acme/api',
        default_cwd: stale,
        repository_url: `https://${forge.host}/acme/api`,
        commands: {},
        kind: 'repo',
        default_branch: null,
        ai_assistant_type: null,
        created_at: new Date(),
        updated_at: new Date(),
      });
      findCodebase.mockResolvedValue(existing);
      if (state === 'foreign' || state === 'nonrepository') {
        await expect(forge.route()).rejects.toThrow('/update-project');
        expect(existing.default_cwd).toBe(stale);
        expect(updateCodebase).not.toHaveBeenCalled();
      } else {
        const result = await forge.route();
        expect(result.repoPath).toBe(path);
        expect(updateCodebase).toHaveBeenCalledWith(existing, { default_cwd: path });
      }
    } finally {
      if (previousHome === undefined) delete process.env.ARCHON_HOME;
      else process.env.ARCHON_HOME = previousHome;
    }
  });

  test.each(forge.name === 'GitHub' ? ['absent', 'empty'] : ['absent'])(
    `${forge.name} reuses a %s saved canonical checkout for clone preparation`,
    async state => {
      const root = trackRoot(await mkdtemp(join(tmpdir(), 'archon-missing-source-')));
      const previousHome = process.env.ARCHON_HOME;
      process.env.ARCHON_HOME = root;
      try {
        const path = getProjectSourcePath('acme', 'api');
        if (state === 'empty') await mkdir(path, { recursive: true });
        const existing = codebaseRowSchema.parse({
          id: 'a5fc48f1-0c23-4e61-b5f6-eb3b0c6682fd',
          name: 'acme/api',
          default_cwd: path,
          repository_url: `https://${forge.host}/acme/api`,
          commands: {},
          kind: 'repo',
          default_branch: null,
          ai_assistant_type: null,
          created_at: new Date(),
          updated_at: new Date(),
        });
        findCodebase.mockResolvedValue(existing);
        const result = await forge.route();
        expect(result).toEqual({ codebase: existing, repoPath: path, isNew: false });
        expect(updateCodebase).not.toHaveBeenCalled();
      } finally {
        if (previousHome === undefined) delete process.env.ARCHON_HOME;
        else process.env.ARCHON_HOME = previousHome;
      }
    }
  );
}

test('GitHub retries preparation after token failure leaves an empty managed source', async () => {
  const root = trackRoot(await mkdtemp(join(tmpdir(), 'archon-token-retry-')));
  const previousHome = process.env.ARCHON_HOME;
  process.env.ARCHON_HOME = root;
  const provider = createGitHubAppAuthProvider({
    appId: '1',
    privateKey: 'unused',
    slug: 'archon',
  });
  const token = spyOn(provider, 'getInstallationToken').mockRejectedValue(
    new Error('token unavailable')
  );
  try {
    const path = getProjectSourcePath('acme', 'api');
    const existing = codebaseRowSchema.parse({
      id: 'a5fc48f1-0c23-4e61-b5f6-eb3b0c6682fd',
      name: 'acme/api',
      default_cwd: path,
      repository_url: 'https://github.com/acme/api',
      commands: {},
      kind: 'repo',
      default_branch: null,
      ai_assistant_type: null,
      created_at: new Date(),
      updated_at: new Date(),
    });
    findCodebase.mockResolvedValue(existing);
    const adapter = new GitHubAdapter({ kind: 'app', provider }, 'secret', lock);
    for (let attempt = 0; attempt < 2; attempt++) {
      // @ts-expect-error - exercise registration followed by readiness as the webhook does
      const routed = await adapter.getOrCreateCodebaseForRepo('acme', 'api');
      // @ts-expect-error - token acquisition fails before cloning
      await expect(
        adapter.ensureRepoReady('acme', 'api', 'main', routed.repoPath, false)
      ).rejects.toThrow('token unavailable');
    }
    expect(token).toHaveBeenCalledTimes(2);
  } finally {
    token.mockRestore();
    if (previousHome === undefined) delete process.env.ARCHON_HOME;
    else process.env.ARCHON_HOME = previousHome;
  }
});

test('refuses nested GitLab repairs that would move or merge existing storage', async () => {
  const root = trackRoot(await mkdtemp(join(tmpdir(), 'archon-nested-storage-')));
  const previousHome = process.env.ARCHON_HOME;
  process.env.ARCHON_HOME = root;
  try {
    const adapter = new GitLabAdapter('test', 'secret', lock, 'https://gitlab.example.com');
    const storageRoots: (string | null)[] = [];
    for (const [repo, worktree] of [
      ['api', 'old-api'],
      ['web', 'old-web'],
    ]) {
      const stale = join(root, 'workspaces', 'group', 'subgroup', repo, 'worktrees', worktree);
      const existing = codebaseRowSchema.parse({
        id: 'a5fc48f1-0c23-4e61-b5f6-eb3b0c6682fd',
        name: `group/subgroup/${repo}`,
        default_cwd: stale,
        repository_url: `https://gitlab.example.com/group/subgroup/${repo}`,
        commands: {},
        kind: 'repo',
        default_branch: null,
        ai_assistant_type: null,
        created_at: new Date(),
        updated_at: new Date(),
      });
      const before = resolveRunStorageRoot({}, existing);
      expect(before).toBe(join(root, 'workspaces', '_local', worktree));
      findCodebase.mockResolvedValue(existing);
      // @ts-expect-error - exercise the private registration boundary
      await expect(adapter.getOrCreateCodebaseForRepo(existing.name)).rejects.toThrow(
        '/update-project'
      );
      expect(existing.default_cwd).toBe(stale);
      expect(resolveRunStorageRoot({}, existing)).toBe(before);
      storageRoots.push(before);
    }
    expect(storageRoots[0]).not.toBe(storageRoots[1]);
    expect(updateCodebase).not.toHaveBeenCalled();
  } finally {
    if (previousHome === undefined) delete process.env.ARCHON_HOME;
    else process.env.ARCHON_HOME = previousHome;
  }
});
