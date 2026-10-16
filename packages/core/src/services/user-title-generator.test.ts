// @archon-test-isolated
import { afterAll, beforeEach, expect, mock, test } from 'bun:test';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { SendQueryOptions, MessageChunk } from '@archon/providers';
import type { StoredCredential } from '../db/user-provider-key-store';
import { registerInProcessProviders } from '@archon/providers/in-process';
import { resolveUserProviderCredentials } from '../credentials/user-provider-resolution';
import { PI_AUTH_PATH_ENV } from '../credentials/delivery';

registerInProcessProviders();
const list = mock(
  async (
    _user: string
  ): Promise<{ provider: string; kind: 'api_key' | 'oauth'; label: null }[]> => []
);
const read = mock(
  async (_user: string, _provider: string): Promise<StoredCredential> => ({
    state: 'not_connected',
    source: 'archon',
  })
);
mock.module('../db/user-provider-key-store', () => ({
  listUserProviderKeys: list,
  getDecryptedProviderCredential: read,
}));
const update = mock(async (_id: string, _title: string) => {});
mock.module('../db/conversations', () => ({ updateConversationTitle: update }));
const send = mock(async function* (
  _prompt: string,
  _cwd: string,
  _session?: string,
  _options?: SendQueryOptions
): AsyncGenerator<MessageChunk> {
  yield { type: 'agent_message_chunk', text: 'Generated title' };
  yield { type: 'result' };
});
mock.module('./provider-admission', () => ({ getAgentProvider: () => ({ sendQuery: send }) }));
import { generateTitleForUser } from './user-title-generator';
const keys = [
  'GITHUB_APP_ID',
  'TOKEN_ENCRYPTION_KEY',
  'TITLE_GENERATION_MODEL',
  'ANTHROPIC_API_KEY',
] as const;
const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
afterAll(() => {
  for (const key of keys) {
    const value = previous[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
beforeEach(() => {
  process.env.GITHUB_APP_ID = '123';
  process.env.TOKEN_ENCRYPTION_KEY = 'a'.repeat(64);
  process.env.ANTHROPIC_API_KEY = 'host-sentinel';
  delete process.env.TITLE_GENERATION_MODEL;
  list.mockReset();
  list.mockResolvedValue([]);
  read.mockReset();
  read.mockResolvedValue({ state: 'not_connected', source: 'archon' });
  update.mockClear();
  send.mockClear();
  send.mockImplementation(async function* () {
    yield { type: 'agent_message_chunk', text: 'Generated title' };
    yield { type: 'result' };
  });
});
const request = { provider: 'claude', options: { model: 'small-model' } };
const run = (user: string | undefined = 'user-a') =>
  generateTitleForUser('conv', 'Private message', request, '/tmp', user);
function connected(provider = 'anthropic'): void {
  list.mockResolvedValue([{ provider, kind: 'api_key', label: null }]);
  read.mockResolvedValue({
    state: 'usable',
    source: 'archon',
    credential: { kind: 'api_key', apiKey: 'user-key' },
  });
}
test('missing identity, absent connection and dynamic vendors never send or change the title', async () => {
  await generateTitleForUser('conv', 'Private', request, '/tmp');
  await run();
  await generateTitleForUser(
    'conv',
    'Private',
    { provider: 'opencode', options: {} },
    '/tmp',
    'user-a'
  );
  await generateTitleForUser(
    'conv',
    'Private',
    { provider: 'unknown', options: {} },
    '/tmp',
    'user-a'
  );
  expect(send).not.toHaveBeenCalled();
  expect(update).not.toHaveBeenCalled();
});
for (const stored of [
  { state: 'not_connected', source: 'archon' },
  { state: 'unusable', source: 'archon', evidence: 'rejected' },
  { state: 'check_failed', source: 'archon', evidence: 'offline' },
] satisfies StoredCredential[]) {
  test(`a listed credential in ${stored.state} skips`, async () => {
    connected();
    read.mockResolvedValue(stored);
    await run();
    expect(send).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
}
test('listing, refresh and delivery errors never reject or send', async () => {
  list.mockRejectedValueOnce(new Error('list failed'));
  await run();
  connected();
  read.mockRejectedValueOnce(new Error('refresh failed'));
  await run();
  connected('openai');
  read.mockResolvedValue({
    state: 'usable',
    source: 'archon',
    credential: { kind: 'oauth', oauthApiKey: 'token', rawCreds: {} },
  });
  await generateTitleForUser(
    'conv',
    'Private',
    { provider: 'codex', options: {} },
    '/tmp',
    'user-a'
  );
  expect(send).not.toHaveBeenCalled();
  expect(update).not.toHaveBeenCalled();
});
test('a delivered credential replaces same-name project env and carries protection', async () => {
  connected();
  await generateTitleForUser(
    'conv',
    'Private',
    { provider: 'claude', options: { env: { ANTHROPIC_API_KEY: 'project-key', OTHER: 'kept' } } },
    '/tmp',
    'user-a'
  );
  expect(send.mock.calls[0]?.[3]?.env).toMatchObject({
    ANTHROPIC_API_KEY: 'user-key',
    OTHER: 'kept',
  });
  expect(send.mock.calls[0]?.[3]?.protectedEnvKeys).toContain('ANTHROPIC_API_KEY');
  expect(send.mock.calls[0]?.[3]?.userCredentialEnvKeys).toEqual([
    'ANTHROPIC_API_KEY',
    'CLAUDE_API_KEY',
  ]);
  expect(read).toHaveBeenCalledWith('user-a', 'anthropic');
});
test('native solo titles do not look up the vault, even with an authenticated user', async () => {
  delete process.env.GITHUB_APP_ID;
  await run();
  expect(list).not.toHaveBeenCalled();
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0]?.[3]?.env).toBeUndefined();
});
test('canonical vendor rows take precedence over aliases without duplicate refresh', async () => {
  list.mockResolvedValue([
    { provider: 'claude', kind: 'api_key', label: null },
    { provider: 'anthropic', kind: 'api_key', label: null },
  ]);
  const records = await resolveUserProviderCredentials('user-a', 'anthropic');
  expect(records.map(r => r.provider)).toEqual(['anthropic']);
  expect(read).toHaveBeenCalledTimes(1);
  expect(read).toHaveBeenCalledWith('user-a', 'anthropic');
});
test('literal override selects the actual Pi vendor before any vault read', async () => {
  connected('openai');
  process.env.TITLE_GENERATION_MODEL = 'openai/gpt-5.5';
  await generateTitleForUser(
    'conv',
    'Private',
    { provider: 'pi', options: { model: 'anthropic/claude-sonnet-4-6' } },
    '/tmp',
    'user-a'
  );
  expect(read).toHaveBeenCalledWith('user-a', 'openai');
  expect(send.mock.calls[0]?.[3]?.model).toBe('openai/gpt-5.5');
});
test('the authorized model stays fixed while credentials are prepared', async () => {
  connected('openai');
  process.env.TITLE_GENERATION_MODEL = 'openai/gpt-5.5';
  read.mockImplementation(async () => {
    process.env.TITLE_GENERATION_MODEL = 'anthropic/claude-sonnet-4-6';
    return {
      state: 'usable',
      source: 'archon',
      credential: { kind: 'api_key', apiKey: 'user-key' },
    };
  });
  await generateTitleForUser('conv', 'Private', { provider: 'pi', options: {} }, '/tmp', 'user-a');
  expect(send.mock.calls[0]?.[3]?.model).toBe('openai/gpt-5.5');
});

test('Pi cannot consume a Claude subscription', async () => {
  connected();
  read.mockResolvedValue({
    state: 'usable',
    source: 'archon',
    credential: { kind: 'oauth', oauthApiKey: 'token', rawCreds: {} },
  });
  await generateTitleForUser(
    'conv',
    'Private',
    { provider: 'pi', options: { model: 'anthropic/claude-sonnet-4-6' } },
    '/tmp',
    'user-a'
  );
  expect(send).not.toHaveBeenCalled();
});
test('concurrent Pi deliveries stay private through consumption and are removed after failure', async () => {
  connected('openai');
  read.mockImplementation(async user => ({
    state: 'usable',
    source: 'archon',
    credential: { kind: 'api_key', apiKey: user },
  }));
  const paths: string[] = [];
  const deliveredKeys: string[] = [];
  send.mockImplementation(async function* (_prompt, _cwd, _session, options) {
    const path = options?.env?.[PI_AUTH_PATH_ENV];
    expect(path).toBeDefined();
    if (!path) throw new Error('missing auth');
    paths.push(path);
    // Windows stat mode bits do not represent POSIX file permissions.
    if (process.platform !== 'win32') {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
    const auth = JSON.parse(await readFile(path, 'utf8')) as { openai: { key: string } };
    deliveredKeys.push(auth.openai.key);
    await Promise.resolve();
    throw new Error('provider failure');
  });
  await Promise.all(
    ['user-a', 'user-b'].map(user =>
      generateTitleForUser(
        user,
        'Private',
        { provider: 'pi', options: { model: 'openai/gpt-5.5' } },
        '/tmp',
        user
      )
    )
  );
  expect(deliveredKeys.sort()).toEqual(['user-a', 'user-b']);
  expect(new Set(paths).size).toBe(2);
  expect(paths.every(path => !existsSync(path))).toBe(true);
  expect(update).toHaveBeenCalledTimes(2);
  expect(process.env.ANTHROPIC_API_KEY).toBe('host-sentinel');
});

for (const provider of ['claude', 'codex', 'pi', 'copilot']) {
  test(`${provider} delivers only the selected subscription and cleans up title auth`, async () => {
    const vendor =
      provider === 'claude' ? 'anthropic' : provider === 'copilot' ? 'github-copilot' : 'openai';
    list.mockResolvedValue([
      { provider: vendor, kind: 'oauth', label: null },
      { provider: 'unrelated-vendor', kind: 'api_key', label: null },
    ]);
    const rawCreds = {
      access: 'user-token',
      refresh: 'refresh',
      expires: Date.now() + 3600000,
      accountId: 'user-account',
    };
    read.mockResolvedValue({
      state: 'usable',
      source: 'archon',
      credential: { kind: 'oauth', oauthApiKey: 'user-token', rawCreds },
    });
    let authPath: string | undefined;
    send.mockImplementation(async function* (_prompt, _cwd, _session, options) {
      if (provider === 'pi') {
        expect(options?.userCredentialEnvKeys).toEqual([PI_AUTH_PATH_ENV]);
        authPath = options?.env?.[PI_AUTH_PATH_ENV];
        expect(authPath).toBeDefined();
        if (!authPath) throw new Error('missing auth');
        expect(JSON.parse(await readFile(authPath, 'utf8'))).toEqual({
          openai: { type: 'oauth', ...rawCreds },
        });
      } else {
        const key =
          provider === 'claude'
            ? 'CLAUDE_CODE_OAUTH_TOKEN'
            : provider === 'codex'
              ? 'ARCHON_CODEX_CHATGPT_ACCESS_TOKEN'
              : 'COPILOT_GITHUB_TOKEN';
        expect(options?.env?.[key]).toBe('user-token');
        expect(options?.protectedEnvKeys).toContain(key);
        expect(options?.userCredentialEnvKeys).toContain(key);
      }
      yield { type: 'agent_message_chunk', text: 'Generated title' };
      yield { type: 'result' };
    });
    await generateTitleForUser(
      'conv',
      'Private',
      { provider, options: { model: provider === 'pi' ? 'openai/gpt-5.5' : undefined } },
      '/tmp',
      'user-a'
    );
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith('user-a', vendor);
    expect(send).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith('conv', 'Generated title');
    if (authPath) expect(existsSync(authPath)).toBe(false);
  });
}
