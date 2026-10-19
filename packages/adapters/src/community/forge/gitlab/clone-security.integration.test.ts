import { describe, expect, mock, spyOn, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as git from '@archon/git';
import { createRecordingGitFixture } from '@archon/git/test-utils';
import { trackTempRoots } from '@archon/paths/test-utils';

const mockLogger = {
  fatal: mock(() => undefined),
  error: mock(() => undefined),
  warn: mock(() => undefined),
  info: mock(() => undefined),
  debug: mock(() => undefined),
  trace: mock(() => undefined),
  child: mock(function (this: unknown) {
    return this;
  }),
};
const realPaths = await import('@archon/paths');

mock.module('@archon/paths', () => ({
  ...realPaths,
  createLogger: mock(() => mockLogger),
  getCommandFolderSearchPaths: () => [],
  getProjectSourcePath: (owner: string, repo: string) => `/unused/${owner}/${repo}/source`,
  ensureProjectStructure: mock(async () => undefined),
}));

mock.module('@archon/core', () => ({
  handleMessage: mock(async () => undefined),
  classifyAndFormatError: (error: Error) => error.message,
  toError: (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
  onConversationClosed: mock(async () => undefined),
  ConversationNotFoundError: class extends Error {},
  ConversationLockManager: class {},
}));

mock.module('@archon/core/db/conversations', () => ({
  getOrCreateConversation: mock(async () => undefined),
  updateConversation: mock(async () => undefined),
  getConversation: mock(async () => null),
}));

mock.module('@archon/core/db/codebases', () => ({
  findCodebaseByRepoUrl: mock(async () => null),
  createManagedCodebase: mock(async () => undefined),
  getCodebaseCommands: mock(async () => ({})),
  updateCodebaseCommands: mock(async () => undefined),
  updateCodebase: mock(async () => undefined),
}));

mock.module('@archon/core/db/users', () => ({
  findOrCreateUserByPlatformIdentity: mock(async () => undefined),
}));

const readiness = await import('./repository-readiness');
const trackTempRoot = trackTempRoots();

function ensureRepoReady(
  client: { gitlabUrl: string; token: string },
  projectPath: string,
  repoPath: string
): Promise<void> {
  return readiness.ensureRepoReady(
    client,
    projectPath,
    'main',
    { name: projectPath, default_cwd: repoPath },
    false
  );
}

describe('GitLab clone child security boundary', () => {
  test.skipIf(process.platform === 'win32')(
    'trusts the destination before a real checkout hook runs',
    async () => {
      const root = trackTempRoot(
        await realpath(await mkdtemp(join(tmpdir(), 'forge-checkout-trust-')))
      );
      const source = join(root, 'source');
      const target = join(root, 'clone');
      const hooks = join(root, 'hooks');
      const config = join(root, 'gitconfig');
      const saved = {
        GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
        GIT_TEST_ASSUME_DIFFERENT_OWNER: process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER,
      };
      const realExec = git.execFileAsync;
      let execSpy: ReturnType<typeof spyOn> | undefined;
      try {
        process.env.GIT_CONFIG_GLOBAL = config;
        await mkdir(hooks);
        await realExec('git', ['init', source]);
        await realExec('git', [
          '-C',
          source,
          '-c',
          'user.name=Test',
          '-c',
          'user.email=test@example.com',
          'commit',
          '--allow-empty',
          '-m',
          'Initial',
        ]);
        await realExec('git', ['config', '--global', 'core.hooksPath', hooks]);
        await git.addSafeDirectory(git.toRepoPath(source));
        await git.addSafeDirectory(git.toRepoPath(join(source, '.git')));
        await writeFile(
          join(hooks, 'post-checkout'),
          '#!/bin/sh\nunset GIT_DIR GIT_WORK_TREE\ngit status --porcelain > hook-ran\n',
          { mode: 0o755 }
        );
        process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER = '1';
        execSpy = spyOn(git, 'execFileAsync').mockImplementation(async (file, args, options) => {
          const clone = args.indexOf('clone');
          const localArgs = [...args];
          if (clone !== -1) localArgs[clone + 1] = source;
          return realExec(file, localArgs, options);
        });
        await ensureRepoReady(
          { gitlabUrl: 'https://gitlab.example.test', token: 'token' },
          'group/project',
          target
        );
        expect(await Bun.file(join(target, 'hook-ran')).exists()).toBe(true);
      } finally {
        execSpy?.mockRestore();
        for (const [key, value] of Object.entries(saved)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    }
  );

  test.skipIf(process.platform === 'win32')(
    'passes request-scoped oauth2 credentials outside argv for an explicit HTTPS port',
    async () => {
      const root = trackTempRoot(await mkdtemp(join(tmpdir(), 'archon-gitlab-clone-security-')));
      const targetPath = join(root, 'clone');
      const fixture = await createRecordingGitFixture(root);
      const token = 'gitlab-adapter-token-789';
      const client = { gitlabUrl: 'https://gitlab.example.test:8443', token };

      await fixture.run(() => ensureRepoReady(client, 'group/project', targetPath));

      const invocations = await fixture.readInvocations();
      const clone = invocations.find(invocation => invocation.argv.includes('clone'));
      expect(clone).toBeDefined();
      expect(clone?.argv.join('\0')).not.toContain(token);
      expect(clone?.argv).toContain('https://gitlab.example.test:8443/group/project.git');
      expect(clone?.env.ARCHON_GIT_USERNAME).toBe('oauth2');
      expect(clone?.env.ARCHON_GIT_PASSWORD).toBe(token);
      expect(clone?.env.GIT_TERMINAL_PROMPT).toBe('0');

      const originConfig = await readFile(join(targetPath, '.git', 'config'), 'utf8');
      expect(originConfig).toContain('url = https://gitlab.example.test:8443/group/project.git');
      expect(originConfig).not.toContain(token);
    }
  );

  test.skipIf(process.platform === 'win32')(
    'keeps a real-child HTTP 403 actionable and sanitized',
    async () => {
      const root = trackTempRoot(await mkdtemp(join(tmpdir(), 'archon-gitlab-clone-403-')));
      const fixture = await createRecordingGitFixture(root);
      const token = 'gitlab-rejected-token-987';
      const client = { gitlabUrl: 'https://gitlab.example.test:8443', token };
      const failure = `fatal: credential ${token} rejected: The requested URL returned error: 403\n`;

      const clone = fixture.run(
        () => ensureRepoReady(client, 'group/project', join(root, 'clone')),
        failure
      );

      await expect(clone).rejects.toThrow(
        'Authentication failed for group/project. Check GITLAB_TOKEN permissions.'
      );
      expect(JSON.stringify(mockLogger.error.mock.calls)).not.toContain(token);
    }
  );
});
