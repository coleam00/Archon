import { SETTING_SOURCES } from '@archon/paths/skills';
import { checkCredentialRequestSchema } from '@archon/provider-contract/plugin/wire';
import { expect, mock, test } from 'bun:test';
import { PassThrough } from 'node:stream';
import * as childProcess from 'node:child_process';
import type { AccountInfo, Options } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeProvider } from './claude/provider';
import { CopilotProvider } from './community/copilot/provider';
import { OpencodeProvider } from './community/opencode/provider';

let account: AccountInfo = {};
const close = mock(() => {});
const accountInfo = mock(async () => account);
const query = mock((_request: { options: Options; prompt: unknown }) => ({ accountInfo, close }));
mock.module('@anthropic-ai/claude-agent-sdk', () => ({ query }));
const startRuntime = mock(() => {
  throw new Error('Native credential check must not start a runtime');
});
mock.module('@github/copilot-sdk', () => ({ CopilotClient: startRuntime }));
mock.module('@opencode-ai/sdk', () => ({
  createOpencode: startRuntime,
  createOpencodeClient: startRuntime,
}));
const request = () => ({ env: { PREFLIGHT_TEST: 'value' }, signal: new AbortController().signal });

for (const entry of [
  { account: {}, expected: 'not_connected' },
  { account: { apiKeySource: 'none', tokenSource: 'none' }, expected: 'not_connected' },
  // The shapes the Claude Code CLI reports for a logged-out user and a claude.ai
  // subscription login: a subscription names the account but no credential source.
  { account: { tokenSource: 'none', apiProvider: 'firstParty' }, expected: 'not_connected' },
  {
    account: {
      email: 'user@example.com',
      organization: 'Example',
      subscriptionType: 'Claude Max',
      apiProvider: 'firstParty',
    },
    expected: 'usable',
  },
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
test('Claude runtime failure is inconclusive, never usable', async () => {
  accountInfo.mockRejectedValueOnce(new Error('runtime unavailable: secret-test-key'));
  expect(
    await new ClaudeProvider().checkCredential({
      ...request(),
      env: { API_KEY: 'secret-test-key' },
    })
  ).toEqual({
    state: 'check_failed',
    source: 'native',
    evidence: 'runtime unavailable: [REDACTED]',
  });
});
for (const Provider of [CopilotProvider, OpencodeProvider]) {
  test(`${Provider.name} native login is not checked without starting a runtime`, async () => {
    expect(await new Provider().checkCredential()).toEqual({
      state: 'not_checked',
      source: 'native',
    });
    expect(startRuntime).not.toHaveBeenCalled();
  });
}

test('credential wire setting sources agree with the execution setting sources', () => {
  expect(checkCredentialRequestSchema.shape.settingSources.unwrap().element.options).toEqual([
    ...SETTING_SOURCES,
  ]);
});
test('Claude cannot admit a helper when the SDK does not expose its subprocess environment', async () => {
  account = { apiKeySource: 'apiKeyHelper' };
  expect(await new ClaudeProvider().checkCredential(request())).toEqual({
    state: 'check_failed',
    source: 'native',
    evidence: 'Claude SDK did not expose its subprocess environment',
  });
});

const { execFile: runInRunner } = childProcess;
const helpers = { succeeds: 'echo helper-key', empty: 'true', fails: 'exit 1' } as const;
for (const runnerKey of [
  undefined,
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_API_KEY',
]) {
  for (const [helperResult, helper] of Object.entries(helpers)) {
    const usable =
      helperResult === 'succeeds' || (runnerKey !== undefined && runnerKey !== 'CLAUDE_API_KEY');
    test(`Claude container helper ${helperResult}, runner key ${runnerKey ?? 'none'}: ${usable ? 'usable' : 'unusable'}`, async () => {
      account = { apiKeySource: 'apiKeyHelper' };
      const child = new childProcess.ChildProcess();
      Object.defineProperties(child, {
        stdin: { value: new PassThrough() },
        stdout: { value: new PassThrough() },
        stderr: { value: new PassThrough() },
      });
      const spawn = mock(() => child);
      // Stands in for `docker exec`: runs the in-runner command with the image's
      // inherited environment, which the forwarded env bag never contains.
      const execute = mock(
        (
          _command: string,
          args: string[],
          options: { signal: AbortSignal },
          callback: (
            error: childProcess.ExecFileException | null,
            stdout: string,
            stderr: string
          ) => void
        ) => {
          const command = args.slice(args.indexOf('runner') + 1);
          return runInRunner(
            command[0] ?? '',
            command.slice(1),
            {
              ...options,
              env: { PATH: process.env.PATH, ...(runnerKey ? { [runnerKey]: 'image-key' } : {}) },
            },
            callback
          );
        }
      );
      mock.module('node:child_process', () => ({ ...childProcess, spawn, execFile: execute }));
      query.mockImplementationOnce(({ options }) => {
        options.spawnClaudeCodeProcess?.({
          signal: new AbortController().signal,
          command: 'claude',
          args: [],
          cwd: '/runner',
          env: { CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' },
        });
        return {
          accountInfo,
          close,
          request: async () => ({ response: { effective: { apiKeyHelper: helper } } }),
        };
      });
      const status = await new ClaudeProvider().checkCredential({
        ...request(),
        cwd: '/runner',
        execContext: { kind: 'container', containerId: 'runner', execUser: 'worker' },
      });
      expect(status.state).toBe(usable ? 'usable' : 'unusable');
      expect(execute.mock.calls[0]?.[0]).toBe('docker');
      expect(execute.mock.calls[0]?.[1].slice(0, 9)).toEqual([
        'exec',
        '-i',
        '-u',
        'worker',
        '-w',
        '/runner',
        '-e',
        'CLAUDE_CODE_ENTRYPOINT=sdk-ts',
        'runner',
      ]);
    });
  }
}
