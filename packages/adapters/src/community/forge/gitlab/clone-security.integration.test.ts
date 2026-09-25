import { describe, expect, mock, test } from 'bun:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  createCodebase: mock(async () => undefined),
  getCodebaseCommands: mock(async () => ({})),
  updateCodebaseCommands: mock(async () => undefined),
  updateCodebase: mock(async () => undefined),
}));

mock.module('@archon/core/db/users', () => ({
  findOrCreateUserByPlatformIdentity: mock(async () => undefined),
}));

mock.module('@archon/core/config/resolve-assistant', () => ({
  resolveDefaultAssistant: mock(async () => 'claude'),
}));

const { GitLabAdapter } = await import('./adapter');
const trackTempRoot = trackTempRoots();

function createAdapter(token: string, gitlabUrl: string): InstanceType<typeof GitLabAdapter> {
  return new GitLabAdapter(token, 'webhook-secret', {} as never, gitlabUrl, 'archon');
}

function ensureRepoReady(
  adapter: InstanceType<typeof GitLabAdapter>,
  projectPath: string,
  repoPath: string
): Promise<void> {
  return (
    adapter as unknown as {
      ensureRepoReady(
        projectPath: string,
        defaultBranch: string,
        repoPath: string,
        shouldSync: boolean
      ): Promise<void>;
    }
  ).ensureRepoReady(projectPath, 'main', repoPath, false);
}

describe('GitLab clone child security boundary', () => {
  test.skipIf(process.platform === 'win32')(
    'passes request-scoped oauth2 credentials outside argv for an explicit HTTPS port',
    async () => {
      const root = trackTempRoot(await mkdtemp(join(tmpdir(), 'archon-gitlab-clone-security-')));
      const targetPath = join(root, 'clone');
      const fixture = await createRecordingGitFixture(root);
      const token = 'gitlab-adapter-token-789';
      const adapter = createAdapter(token, 'https://gitlab.example.test:8443');

      await fixture.run(() => ensureRepoReady(adapter, 'group/project', targetPath));

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
      const adapter = createAdapter(token, 'https://gitlab.example.test:8443');
      const failure = `fatal: credential ${token} rejected: The requested URL returned error: 403\n`;

      const clone = fixture.run(
        () => ensureRepoReady(adapter, 'group/project', join(root, 'clone')),
        failure
      );

      await expect(clone).rejects.toThrow(
        'Authentication failed for group/project. Check GITLAB_TOKEN permissions.'
      );
      expect(JSON.stringify(mockLogger.error.mock.calls)).not.toContain(token);
    }
  );
});
