import { SETTING_SOURCES } from '@archon/paths/skills';
import { checkCredentialRequestSchema } from '@archon/provider-contract/plugin/wire';
import { expect, mock, test } from 'bun:test';
import type { AccountInfo, Options } from '@anthropic-ai/claude-agent-sdk';
import type { CopilotClientOptions } from '@github/copilot-sdk';
import { ClaudeProvider } from './claude/provider';
import { CopilotProvider } from './community/copilot/provider';
import { OpencodeProvider } from './community/opencode/provider';

let account: AccountInfo = {};
let authenticated = false;
const close = mock(() => {});
const forceStop = mock(async () => {});
const accountInfo = mock(async () => account);
let connected = false;
const start = mock(async () => {
  connected = true;
});
const getAuthStatus = mock(async () => {
  if (!connected) throw new Error('Client not connected');
  return { isAuthenticated: authenticated };
});
const query = mock((_request: { options: Options; prompt: unknown }) => ({ accountInfo, close }));
const client = mock((_options: CopilotClientOptions) => {
  connected = false;
  return { start, getAuthStatus, forceStop };
});
mock.module('@anthropic-ai/claude-agent-sdk', () => ({ query }));
mock.module('@github/copilot-sdk', () => ({ CopilotClient: client }));
const startRuntime = mock(() => {
  throw new Error('Unexpected OpenCode runtime');
});
mock.module('@opencode-ai/sdk', () => ({
  createOpencode: startRuntime,
  createOpencodeClient: startRuntime,
}));
const request = () => ({ env: { PREFLIGHT_TEST: 'value' }, signal: new AbortController().signal });

for (const entry of [
  { account: {}, expected: 'not_connected' },
  { account: { apiKeySource: 'none', tokenSource: 'none' }, expected: 'not_connected' },
  { account: { tokenSource: 'oauth' }, expected: 'usable' },
  { account: { apiKeySource: 'ANTHROPIC_API_KEY' }, expected: 'usable' },
  { account: { apiProvider: 'bedrock' }, expected: 'not_checked' },
] as const) {
  test(`Claude native account ${JSON.stringify(entry.account)}: ${entry.expected}`, async () => {
    account = entry.account;
    const before = close.mock.calls.length;
    expect(await new ClaudeProvider().checkCredential(request())).toMatchObject({
      state: entry.expected,
      source: 'native',
    });
    expect(close.mock.calls.length).toBe(before + 1);
    const call = query.mock.calls.at(-1)?.[0];
    expect(call?.options.env).toMatchObject({ PREFLIGHT_TEST: 'value' });
    expect(call?.options.strictMcpConfig).toBe(true);
    expect(call?.options.plugins).toEqual([]);
    const input = call?.prompt;
    expect(typeof input).not.toBe('string');
  });
}
for (const loggedIn of [false, true]) {
  test(`Copilot native authenticated=${loggedIn}`, async () => {
    authenticated = loggedIn;
    const before = forceStop.mock.calls.length;
    expect(await new CopilotProvider().checkCredential(request())).toEqual({
      state: loggedIn ? 'usable' : 'not_connected',
      source: 'native',
    });
    expect(forceStop.mock.calls.length).toBe(before + 1);
    expect(client.mock.calls.at(-1)?.[0]).toMatchObject({
      env: { PREFLIGHT_TEST: 'value' },
      useLoggedInUser: true,
    });
  });
}
test('Copilot preflight preserves explicit token and config selection', async () => {
  await new CopilotProvider().checkCredential({
    ...request(),
    env: { COPILOT_GITHUB_TOKEN: 'test-token' },
    assistantConfig: { configDir: '/tmp/copilot-test' },
  });
  expect(client.mock.calls.at(-1)?.[0]).toMatchObject({
    gitHubToken: 'test-token',
    useLoggedInUser: false,
    baseDirectory: '/tmp/copilot-test',
  });
});
for (const [Provider, check] of [
  [ClaudeProvider, accountInfo],
  [CopilotProvider, getAuthStatus],
] as const) {
  test(`${Provider.name} runtime failure is inconclusive, never usable`, async () => {
    check.mockRejectedValueOnce(new Error('runtime unavailable: secret-test-key'));
    expect(
      await new Provider().checkCredential({ ...request(), env: { API_KEY: 'secret-test-key' } })
    ).toEqual({
      state: 'check_failed',
      source: 'native',
      evidence: 'runtime unavailable: [REDACTED]',
    });
  });
}
test('OpenCode native check does not start a runtime', async () => {
  expect(await new OpencodeProvider().checkCredential()).toEqual({
    state: 'not_checked',
    source: 'native',
  });
  expect(startRuntime).not.toHaveBeenCalled();
});

test('credential wire setting sources agree with the execution setting sources', () => {
  expect(checkCredentialRequestSchema.shape.settingSources.unwrap().element.options).toEqual([
    ...SETTING_SOURCES,
  ]);
});
test('Claude cannot admit a helper when the SDK cannot inspect native settings', async () => {
  account = { apiKeySource: 'apiKeyHelper' };
  expect(await new ClaudeProvider().checkCredential(request())).toEqual({
    state: 'check_failed',
    source: 'native',
    evidence: 'Claude SDK cannot inspect the native apiKeyHelper settings',
  });
});
