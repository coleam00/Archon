// @archon-test-isolated
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getProjectSourcePath } from '@archon/paths';
import { trackTempRoots } from '@archon/paths/test-utils';
import { codebaseRowSchema } from '@archon/core/schemas/codebase';

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

test.each(['matching', 'foreign', 'missing'] as const)(
  'repairs legacy nested GitLab paths with ownership verification: %s',
  async state => {
    const root = trackRoot(await mkdtemp(join(tmpdir(), 'archon-nested-owner-')));
    const previousHome = process.env.ARCHON_HOME;
    process.env.ARCHON_HOME = root;
    try {
      const path = getProjectSourcePath('group/subgroup', 'repo');
      if (state !== 'missing') {
        await mkdir(path, { recursive: true });
        execFileSync('git', ['-C', path, 'init', '-q']);
        execFileSync('git', [
          '-C',
          path,
          'remote',
          'add',
          'origin',
          `https://gitlab.example.com/${state === 'foreign' ? 'other/repo' : 'group/subgroup/repo'}`,
        ]);
      }
      const stale = join(root, 'workspaces', 'group', 'subgroup', 'repo', 'worktrees', 'old');
      const existing = codebaseRowSchema.parse({
        id: 'a5fc48f1-0c23-4e61-b5f6-eb3b0c6682fd',
        name: 'group/subgroup/repo',
        default_cwd: stale,
        repository_url: 'https://gitlab.example.com/group/subgroup/repo',
        kind: 'repo',
        commands: {},
        default_branch: null,
        ai_assistant_type: null,
        created_at: new Date(),
        updated_at: new Date(),
      });
      findCodebase.mockResolvedValue(existing);
      const adapter = new GitLabAdapter('test', 'secret', lock, 'https://gitlab.example.com');
      // @ts-expect-error - exercise the private registration boundary
      const route = adapter.getOrCreateCodebaseForRepo('group/subgroup/repo');
      if (state === 'foreign') {
        await expect(route).rejects.toThrow('/update-project');
        expect(existing.default_cwd).toBe(stale);
        expect(updateCodebase).not.toHaveBeenCalled();
      } else {
        const result = await route;
        expect(result.repoPath).toBe(path);
        expect(existing.name).toBe('group/subgroup/repo');
        expect(updateCodebase).toHaveBeenCalledWith(existing, { default_cwd: path });
      }
    } finally {
      if (previousHome === undefined) delete process.env.ARCHON_HOME;
      else process.env.ARCHON_HOME = previousHome;
    }
  }
);
