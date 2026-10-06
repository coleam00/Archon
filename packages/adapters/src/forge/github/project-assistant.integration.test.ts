import { afterAll, expect, mock, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WebhookEvent } from './types';
import { removeTempTree } from '@archon/paths/test-utils';
import { registerBuiltinProviders, registerCommunityProviders } from '@archon/providers';

const root = await realpath(await mkdtemp(join(tmpdir(), 'archon-forge-assistant-')));
const originalArchonHome = process.env.ARCHON_HOME;
const originalDatabaseUrl = process.env.DATABASE_URL;
const originalAllowedUsers = process.env.GITHUB_ALLOWED_USERS;
process.env.ARCHON_HOME = join(root, 'home');
process.env.DATABASE_URL = '';
process.env.GITHUB_ALLOWED_USERS = '';
await mkdir(process.env.ARCHON_HOME);
await writeFile(join(process.env.ARCHON_HOME, 'config.yaml'), 'defaultAssistant: pi\n');

// Only GitHub transport is fake; project registration, configuration and conversation
// persistence use the real implementations. The lock stops before model execution.
mock.module('@octokit/rest', () => ({
  Octokit: class {
    rest = {
      repos: { get: async () => ({ data: { default_branch: 'main' } }) },
      issues: { listComments: async () => ({ data: [] }) },
    };
  },
}));

const { setPlatformPolicies } = await import('@archon/core/platforms/registry');
setPlatformPolicies([]);
// The host registers providers before loading configuration.
registerBuiltinProviders();
registerCommunityProviders();
const { registerRepository } = await import('@archon/core');
const { closeDatabase, getDatabase } = await import('@archon/core/db/connection');
const { getCodebase } = await import('@archon/core/db/codebases');
const { getConversationByPlatformId } = await import('@archon/core/db/conversations');
const { GitHubAdapter } = await import('./adapter');

const repository = join(root, 'repository');
await mkdir(join(repository, '.archon'), { recursive: true });
await writeFile(join(repository, '.archon', 'config.yaml'), 'assistant: codex\n');
expect(await Bun.spawn(['git', 'init', '-q', repository]).exited).toBe(0);
expect(
  await Bun.spawn([
    'git',
    '-C',
    repository,
    'remote',
    'add',
    'origin',
    'https://github.com/example/repo',
  ]).exited
).toBe(0);
const registration = await registerRepository(repository);
const secret = 'test-secret';
const adapter = new GitHubAdapter({ kind: 'pat', token: 'unused' }, secret, {
  acquireLock: async () => ({ status: 'started' as const }),
});

afterAll(async () => {
  await closeDatabase();
  await removeTempTree(root);
  if (originalArchonHome === undefined) delete process.env.ARCHON_HOME;
  else process.env.ARCHON_HOME = originalArchonHome;
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  if (originalAllowedUsers === undefined) delete process.env.GITHUB_ALLOWED_USERS;
  else process.env.GITHUB_ALLOWED_USERS = originalAllowedUsers;
});

async function deliver(number: number): Promise<void> {
  const payload = JSON.stringify({
    action: 'created',
    repository: {
      name: 'repo',
      full_name: 'example/repo',
      owner: { login: 'example' },
      html_url: 'https://github.com/example/repo',
      default_branch: 'main',
    },
    issue: {
      number,
      title: 'Test issue',
      body: '',
      labels: [],
      state: 'open',
      user: { login: 'operator' },
    },
    comment: { body: '@Archon run it', user: { login: 'operator' } },
    sender: { login: 'operator' },
  } satisfies WebhookEvent);
  const signature = `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;
  await adapter.handleWebhook(payload, signature, `delivery-${String(number)}`, 'issue_comment');
}

test('a new forge conversation resolves repository configuration before persisting its provider', async () => {
  expect((await getCodebase(registration.codebaseId))?.ai_assistant_type).toBeNull();
  await deliver(1);
  expect(await getConversationByPlatformId('github', 'example/repo#1')).toMatchObject({
    codebase_id: registration.codebaseId,
    ai_assistant_type: 'codex',
    cwd: repository,
  });
});

test('a new forge conversation preserves an explicit project choice over repository configuration', async () => {
  await getDatabase().query(
    'UPDATE remote_agent_codebases SET ai_assistant_type = $1 WHERE id = $2',
    ['claude', registration.codebaseId]
  );
  await deliver(2);
  expect(await getConversationByPlatformId('github', 'example/repo#2')).toMatchObject({
    codebase_id: registration.codebaseId,
    ai_assistant_type: 'claude',
  });
});
