import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { MessageChunk, SendQueryOptions } from '../types';
import { createMockLogger } from '../test/mocks/logger';

const mockLogger = createMockLogger();
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
  BUNDLED_IS_BINARY: false,
  BUNDLED_VERSION: 'test',
  getArchonHome: () => '/tmp/archon-home-unused',
}));

import { TOOL_OUTPUT_MAX_CHARS } from '@archon/provider-contract';
import { runProviderConformance } from '@archon/provider-contract/conformance';
import { trackTempRoots } from '@archon/paths/test-utils';
import {
  THREAD_ID,
  TURN_ID,
  agentMessage,
  command,
  createFakeAppServer,
  errorNotification,
  fileChange,
  itemCompleted,
  itemStarted,
  mcpToolCall,
  plan,
  rateLimits,
  reasoning,
  tokenUsage,
  turnError,
  webSearch,
  type FakeTurnScript,
} from '../test/codex-app-server-fake';
import { CodexProvider } from './provider';
import type { CodexErrorInfo } from './protocol/v2/CodexErrorInfo';

const trackTempRoot = trackTempRoots();

/** A provider on a fake app-server that plays `script` for every turn. */
function providerWith(script: FakeTurnScript | (() => FakeTurnScript) = {}): {
  provider: CodexProvider;
  server: ReturnType<typeof createFakeAppServer>;
} {
  const server = createFakeAppServer(typeof script === 'function' ? script : () => script);
  return { provider: new CodexProvider(server), server };
}

async function run(
  provider: CodexProvider,
  options?: SendQueryOptions,
  resumeSessionId?: string,
  prompt = 'test prompt'
): Promise<MessageChunk[]> {
  const chunks: MessageChunk[] = [];
  for await (const chunk of provider.sendQuery(prompt, '/workspace', resumeSessionId, options)) {
    chunks.push(chunk);
  }
  return chunks;
}

/** The chunks before `settled`, which has its own checks. */
async function streamOf(
  script: FakeTurnScript,
  options?: SendQueryOptions
): Promise<MessageChunk[]> {
  const chunks = await run(providerWith(script).provider, options);
  expect(chunks.at(-1)).toEqual({ type: 'settled' });
  return chunks.slice(0, -1);
}

function resultOf(chunks: MessageChunk[]): Extract<MessageChunk, { type: 'result' }> {
  const results = chunks.filter(
    (c): c is Extract<MessageChunk, { type: 'result' }> => c.type === 'result'
  );
  expect(results).toHaveLength(1);
  return results[0];
}

function paramsOf(
  server: ReturnType<typeof createFakeAppServer>,
  method: string
): Record<string, unknown> | undefined {
  return server.processes.at(-1)?.requests.find(r => r.method === method)?.params;
}

async function fakeBinary(): Promise<string> {
  const dir = trackTempRoot(await mkdtemp(join(tmpdir(), 'codex-bin-')));
  const path = join(dir, 'codex');
  await writeFile(path, '');
  return path;
}

beforeEach(() => {
  mockLogger.warn.mockClear();
  mockLogger.info.mockClear();
});

describe('CodexProvider', () => {
  test('getType returns codex', () => {
    expect(new CodexProvider().getType()).toBe('codex');
  });

  test('getCapabilities returns the Codex capability set', () => {
    expect(new CodexProvider().getCapabilities()).toEqual({
      sessionResume: true,
      sessionFork: false,
      mcp: true,
      hooks: false,
      skills: false,
      plugins: false,
      agents: false,
      toolRestrictions: false,
      structuredOutput: 'enforced',
      requiresAllPropertiesRequired: true,
      envInjection: true,
      costControl: false,
      costReporting: false,
      tokenReporting: true,
      stopReasonReporting: false,
      turnCountReporting: false,
      resolvedModelReporting: false,
      effortControl: true,
      fallbackModel: false,
      sandbox: false,
      settingSources: false,
      nativeTools: false,
      containerExec: false,
    });
  });

  describe('a turn', () => {
    test('streams the reply and ends with the thread id and this turn’s usage', async () => {
      const chunks = await streamOf({
        notifications: [
          // A resumed thread first replays the previous turn's usage under its id.
          tokenUsage({ input: 999, output: 999 }, 'earlier-turn'),
          agentMessage('hello'),
          tokenUsage({ input: 120, output: 7, cached: 100, cacheWrite: 3 }),
        ],
      });
      expect(chunks).toEqual([
        { type: 'agent_message_chunk', text: 'hello' },
        {
          type: 'result',
          sessionId: THREAD_ID,
          tokens: { input: 120, output: 7, cacheRead: 100, cacheWrite: 3 },
        },
      ]);
    });

    test('a turn that used no tokens does not report the replayed usage of an earlier turn', async () => {
      const chunks = await streamOf({
        notifications: [tokenUsage({ input: 999, output: 999 }, 'earlier-turn')],
        completion: { status: 'failed', error: turnError('serverOverloaded', 'busy') },
      });
      expect(resultOf(chunks).tokens).toBeUndefined();
    });

    test('initializes, then starts a thread and a turn with Archon’s settings', async () => {
      const { provider, server } = providerWith();
      await run(provider, {
        model: 'gpt-request',
        assistantConfig: {
          model: 'gpt-config',
          modelReasoningEffort: 'low',
          webSearchMode: 'live',
          additionalDirectories: ['/extra'],
        },
        nodeConfig: { effort: 'high' },
      });

      expect(server.processes[0].methods).toEqual(['initialize', 'thread/start', 'turn/start']);
      expect(paramsOf(server, 'thread/start')).toEqual({
        cwd: '/workspace',
        sandbox: 'danger-full-access',
        approvalPolicy: 'never',
        model: 'gpt-request',
        config: {
          sandbox_workspace_write: { network_access: true, writable_roots: ['/extra'] },
          web_search: 'live',
        },
      });
      expect(paramsOf(server, 'turn/start')).toEqual({
        threadId: THREAD_ID,
        input: [{ type: 'text', text: 'test prompt', text_elements: [] }],
        effort: 'high',
      });
    });

    test('a workflow node turns the automatic skill catalog off; direct chat does not', async () => {
      const { provider, server } = providerWith();
      await run(provider, { nodeConfig: { nodeId: 'implement' } });
      expect(paramsOf(server, 'thread/start')?.config).toMatchObject({
        skills: { include_instructions: false },
      });

      await run(provider);
      expect(paramsOf(server, 'thread/start')?.config).not.toHaveProperty('skills');
    });

    test('resumes an existing thread and reports resumed', async () => {
      const { provider, server } = providerWith();
      const chunks = await run(provider, undefined, 'existing-thread');
      expect(paramsOf(server, 'thread/resume')).toMatchObject({
        threadId: 'existing-thread',
        cwd: '/workspace',
        excludeTurns: true,
      });
      expect(resultOf(chunks)).toMatchObject({ sessionId: 'existing-thread', resumed: true });
    });

    test('a thread that cannot be resumed fails the turn with Codex’s words', async () => {
      const { provider } = providerWith({
        errors: { 'thread/resume': { code: -32600, message: 'no rollout found for thread id x' } },
      });
      const result = resultOf(await run(provider, undefined, 'x'));
      expect(result.failure).toEqual({
        class: 'unknown',
        evidence: 'thread/resume failed (JSON-RPC -32600): no rollout found for thread id x',
      });
      expect(result.resumed).toBeUndefined();
    });

    test('the request env is laid over the process env, and CODEX_HOME is left as the user set it', async () => {
      const { provider, server } = providerWith();
      await run(provider, { env: { PATH: '/request/bin', ARCHON_TEST_ONLY: 'yes' } });
      const env = server.processes[0].env;
      expect(env.ARCHON_TEST_ONLY).toBe('yes');
      expect(env.PATH.split(process.platform === 'win32' ? ';' : ':')).toContain('/request/bin');
      expect(env.HOME).toBe(process.env.HOME as string);
      expect(env.CODEX_HOME).toBe(process.env.CODEX_HOME as string);
    });
  });

  describe('API key opt-in', () => {
    test('CODEX_API_KEY logs in with the key, held only by the process', async () => {
      const { provider, server } = providerWith();
      await run(provider, { env: { CODEX_API_KEY: 'sk-test-key' } });
      const process0 = server.processes[0];
      expect(process0.args).toEqual(['app-server', '-c', 'cli_auth_credentials_store="ephemeral"']);
      expect(process0.methods.slice(0, 2)).toEqual(['initialize', 'account/login/start']);
      expect(paramsOf(server, 'account/login/start')).toEqual({
        type: 'apiKey',
        apiKey: 'sk-test-key',
      });
    });

    test('without CODEX_API_KEY Codex uses the user’s own login', async () => {
      const original = process.env.CODEX_API_KEY;
      delete process.env.CODEX_API_KEY;
      try {
        const { provider, server } = providerWith();
        await run(provider, { env: { OPENAI_API_KEY: 'sk-not-for-codex' } });
        expect(server.processes[0].args).toEqual(['app-server']);
        expect(server.processes[0].methods).not.toContain('account/login/start');
      } finally {
        if (original !== undefined) process.env.CODEX_API_KEY = original;
      }
    });
  });

  describe('binary resolution', () => {
    test('every turn spawns the binary the current pin names, and a missing pin is misconfigured (#3573)', async () => {
      const { provider, server } = providerWith();
      const first = await fakeBinary();
      const second = await fakeBinary();

      await run(provider, { assistantConfig: { codexBinaryPath: first } });
      await run(provider, { assistantConfig: { codexBinaryPath: second } });
      expect(server.processes.map(p => p.binary)).toEqual([first, second]);

      const result = resultOf(
        await run(provider, { assistantConfig: { codexBinaryPath: '/nonexistent/codex-bin' } })
      );
      expect(result.failure?.class).toBe('misconfigured');
      expect(server.processes).toHaveLength(2);
    });

    test('a binary that vanishes before spawn is misconfigured', async () => {
      const { provider } = providerWith({ spawnError: 'ENOENT' });
      const result = resultOf(await run(provider));
      expect(result.failure?.class).toBe('misconfigured');
      expect(result.failure?.evidence).toContain('ENOENT');
    });
  });

  describe('tool calls', () => {
    test('a command is a tool call titled with the command, closed with its exit code and output', async () => {
      const chunks = await streamOf({
        notifications: [
          itemStarted(command('cmd-1', 'ls')),
          itemCompleted(command('cmd-1', 'ls', { exitCode: 0, output: 'a.ts\n' })),
          itemStarted(command('cmd-2', 'false')),
          itemCompleted(command('cmd-2', 'false', { exitCode: 1, output: '' })),
        ],
      });
      expect(chunks.slice(0, 4)).toEqual([
        {
          type: 'tool_call',
          toolCallId: 'cmd-1',
          name: 'command_execution',
          title: 'ls',
          rawInput: { command: 'ls' },
        },
        {
          type: 'tool_call_update',
          toolCallId: 'cmd-1',
          status: 'completed',
          exitCode: 0,
          output: 'a.ts\n',
        },
        {
          type: 'tool_call',
          toolCallId: 'cmd-2',
          name: 'command_execution',
          title: 'false',
          rawInput: { command: 'false' },
        },
        {
          type: 'tool_call_update',
          toolCallId: 'cmd-2',
          status: 'failed',
          exitCode: 1,
          output: '',
        },
      ]);
    });

    test('a declined command closes as failed', async () => {
      const chunks = await streamOf({
        notifications: [itemCompleted(command('cmd-1', 'rm -rf /', { status: 'declined' }))],
      });
      expect(chunks[1]).toMatchObject({ toolCallId: 'cmd-1', status: 'failed' });
    });

    test('command output past the contract cap is truncated and flagged', async () => {
      const chunks = await streamOf({
        notifications: [
          itemCompleted(
            command('cmd-1', 'cat big', {
              exitCode: 0,
              output: 'x'.repeat(TOOL_OUTPUT_MAX_CHARS + 5),
            })
          ),
        ],
      });
      expect(chunks[1]).toMatchObject({ outputTruncated: true });
      expect((chunks[1] as { output: string }).output).toHaveLength(TOOL_OUTPUT_MAX_CHARS);
    });

    test('web search, MCP and file-change items are tool calls; a file change opens on completion', async () => {
      const chunks = await streamOf({
        notifications: [
          itemCompleted(webSearch('ws-1', 'bun docs')),
          itemStarted(mcpToolCall('mcp-1', 'figma', 'get_file', 'inProgress', { key: 'abc' })),
          itemCompleted(
            mcpToolCall('mcp-1', 'figma', 'get_file', 'failed', { key: 'abc' }, 'not found')
          ),
          itemCompleted(fileChange('fc-1', [{ path: 'a.ts', kind: { type: 'add' }, diff: '+x' }])),
        ],
      });
      expect(chunks.slice(0, 6)).toEqual([
        {
          type: 'tool_call',
          toolCallId: 'ws-1',
          name: 'web_search',
          title: 'bun docs',
          rawInput: { query: 'bun docs' },
        },
        { type: 'tool_call_update', toolCallId: 'ws-1', status: 'completed' },
        {
          type: 'tool_call',
          toolCallId: 'mcp-1',
          name: 'get_file',
          title: 'figma/get_file',
          rawInput: { key: 'abc' },
        },
        { type: 'tool_call_update', toolCallId: 'mcp-1', status: 'failed', output: 'not found' },
        {
          type: 'tool_call',
          toolCallId: 'fc-1',
          name: 'file_change',
          rawInput: { changes: [{ path: 'a.ts', kind: { type: 'add' }, diff: '+x' }] },
        },
        { type: 'tool_call_update', toolCallId: 'fc-1', status: 'completed' },
      ]);
    });

    test('reasoning streams its summary as a thought; items with nothing to show stream nothing', async () => {
      const chunks = await streamOf({
        notifications: [
          itemCompleted(reasoning('r-1', ['first', 'second'])),
          itemCompleted(reasoning('r-2', [], ['raw'])),
          agentMessage('', 'm-empty'),
          itemCompleted(plan('p-1', 'step')),
        ],
      });
      expect(chunks).toEqual([
        { type: 'agent_thought_chunk', text: 'first\n\nsecond' },
        { type: 'result', sessionId: THREAD_ID },
      ]);
    });
  });

  describe('structured output', () => {
    const schema = {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        meta: { type: 'object', properties: { tag: { type: 'string' } } },
      },
      required: ['summary'],
    };

    test('sends the schema normalized for OpenAI strict mode', async () => {
      const { provider, server } = providerWith();
      await run(provider, { outputFormat: { type: 'json_schema', schema } });
      expect(paramsOf(server, 'turn/start')?.outputSchema).toEqual({
        type: 'object',
        properties: {
          summary: { type: 'string' },
          meta: {
            type: 'object',
            properties: { tag: { type: 'string' } },
            additionalProperties: false,
          },
        },
        required: ['summary'],
        additionalProperties: false,
      });
    });

    test('parses the last message onto structuredOutput (workflow output_format path)', async () => {
      const chunks = await streamOf(
        {
          notifications: [
            agentMessage('thinking first', 'm-1'),
            agentMessage('{"summary":"ok"}', 'm-2'),
          ],
        },
        { nodeConfig: { output_format: schema } }
      );
      expect(resultOf(chunks).structuredOutput).toEqual({ summary: 'ok' });
    });

    test('warns when the final message is not JSON', async () => {
      const chunks = await streamOf(
        { notifications: [agentMessage('not json')] },
        { outputFormat: { type: 'json_schema', schema } }
      );
      expect(chunks).toContainEqual(
        expect.objectContaining({ type: 'warning', code: 'codex.structured_output_not_json' })
      );
      expect(resultOf(chunks).structuredOutput).toBeUndefined();
    });

    test('leaves structuredOutput unset when no format was requested', async () => {
      const chunks = await streamOf({ notifications: [agentMessage('{"a":1}')] });
      expect(resultOf(chunks).structuredOutput).toBeUndefined();
    });
  });

  describe('systemPrompt delivery (issue #1837)', () => {
    async function promptSent(options?: SendQueryOptions, resume?: string): Promise<unknown> {
      const { provider, server } = providerWith();
      await run(provider, options, resume);
      const input = paramsOf(server, 'turn/start')?.input as { text: string }[];
      return input[0].text;
    }

    test.each([
      ['a string', { systemPrompt: 'AAA rules' }, 'AAA rules\n\n---\n\ntest prompt'],
      [
        'a string[] joined with blank lines',
        { systemPrompt: ['one', 'two'] },
        'one\n\ntwo\n\n---\n\ntest prompt',
      ],
      ['whitespace only', { systemPrompt: '   ' }, 'test prompt'],
      ['none', {}, 'test prompt'],
      [
        'node-level',
        { nodeConfig: { systemPrompt: 'node rules' } },
        'node rules\n\n---\n\ntest prompt',
      ],
      [
        'request-level over node-level',
        { systemPrompt: 'request', nodeConfig: { systemPrompt: 'node' } },
        'request\n\n---\n\ntest prompt',
      ],
    ])('%s', async (_label, options, expected) => {
      expect(await promptSent(options as SendQueryOptions)).toBe(expected);
    });

    test('a Claude preset object is dropped with a warning', async () => {
      expect(
        await promptSent({
          systemPrompt: { type: 'preset', preset: 'claude_code', append: 'extra' },
        } as SendQueryOptions)
      ).toBe('test prompt');
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ systemPromptType: 'object' }),
        'codex.system_prompt_dropped_preset'
      );
    });

    test('a resumed thread gets the prepend too', async () => {
      expect(await promptSent({ systemPrompt: 'AAA rules' }, 'existing')).toBe(
        'AAA rules\n\n---\n\ntest prompt'
      );
    });
  });

  describe('MCP config', () => {
    test('passes the node’s MCP file as mcp_servers, expanding env from the process and the request', async () => {
      const dir = trackTempRoot(await mkdtemp(join(tmpdir(), 'codex-provider-mcp-')));
      await writeFile(
        join(dir, 'mcp.json'),
        JSON.stringify({
          figma: {
            type: 'http',
            url: 'http://127.0.0.1:3845/mcp',
            headers: { Authorization: 'Bearer $ARCHON_CODEX_MCP_TOKEN' },
            startup_timeout_sec: 20,
          },
          local: { command: 'npx', args: ['-y', 'figma-mcp'], env: { TOKEN: '$FIGMA_TOKEN' } },
        })
      );
      process.env.ARCHON_CODEX_MCP_TOKEN = 'token-from-process';
      try {
        const { provider, server } = providerWith();
        for await (const _ of provider.sendQuery('p', dir, undefined, {
          env: { FIGMA_TOKEN: 'from-request' },
          nodeConfig: { nodeId: 'notify', mcp: 'mcp.json' },
        })) {
          // consume
        }
        expect(
          (paramsOf(server, 'thread/start')?.config as Record<string, unknown>).mcp_servers
        ).toEqual({
          figma: {
            url: 'http://127.0.0.1:3845/mcp',
            startup_timeout_sec: 20,
            http_headers: { Authorization: 'Bearer token-from-process' },
          },
          local: { command: 'npx', args: ['-y', 'figma-mcp'], env: { TOKEN: 'from-request' } },
        });
      } finally {
        delete process.env.ARCHON_CODEX_MCP_TOKEN;
      }
    });

    test('warns when the MCP config references undefined env vars', async () => {
      const dir = trackTempRoot(await mkdtemp(join(tmpdir(), 'codex-provider-mcp-warning-')));
      await writeFile(
        join(dir, 'mcp.json'),
        JSON.stringify({ figma: { command: 'figma-mcp', env: { TOKEN: '$ARCHON_CODEX_MISSING' } } })
      );
      const { provider } = providerWith();
      const chunks: MessageChunk[] = [];
      for await (const chunk of provider.sendQuery('p', dir, undefined, {
        nodeConfig: { mcp: 'mcp.json' },
      })) {
        chunks.push(chunk);
      }
      expect(chunks[0]).toEqual({
        type: 'warning',
        code: 'codex.mcp_env_vars_missing',
        message:
          'MCP config references undefined env vars: ARCHON_CODEX_MISSING. These will be empty strings - MCP servers may fail to authenticate.',
      });
    });
  });

  describe('failures', () => {
    test('a usage limit is quota_exhausted and resets when the full window does', async () => {
      const resetsAt = 1_791_143_381;
      const result = resultOf(
        await streamOf({
          notifications: [rateLimits({ usedPercent: 100, resetsAt })],
          completion: {
            status: 'failed',
            error: turnError('usageLimitExceeded', "You've hit your usage limit."),
          },
        })
      );
      expect(result).toMatchObject({
        isError: true,
        sessionId: THREAD_ID,
        failure: {
          class: 'quota_exhausted',
          resetAt: new Date(resetsAt * 1000).toISOString(),
          evidence: "You've hit your usage limit.",
        },
      });
    });

    test('an unavailable model gets model-access advice before Codex’s own words', async () => {
      const result = resultOf(
        await streamOf(
          {
            completion: {
              status: 'failed',
              error: turnError('other', '403 Forbidden: model not available'),
            },
          },
          { model: 'gpt-5.3-codex' }
        )
      );
      expect(result.failure?.class).toBe('unknown');
      expect(result.failure?.evidence).toContain(
        'Model "gpt-5.3-codex" is not available for your account'
      );
      expect(result.failure?.evidence).toContain('model: gpt-5.6-sol');
      expect(result.failure?.evidence).toContain('403 Forbidden: model not available');
    });

    test('a process that exits mid-turn is transient, with Codex’s errors as evidence', async () => {
      const result = resultOf(
        await streamOf({
          notifications: [errorNotification('Reconnecting... 1/5', true)],
          exitCode: 1,
        })
      );
      expect(result.failure?.class).toBe('transient');
      expect(result.failure?.evidence).toContain('exited (code 1)');
      expect(result.failure?.evidence).toContain('Reconnecting... 1/5');
    });

    test('a turn interrupted by someone other than Archon is unknown', async () => {
      const result = resultOf(await streamOf({ completion: { status: 'interrupted' } }));
      expect(result.failure?.class).toBe('unknown');
    });

    test('conforms to the provider contract', async () => {
      const turn =
        (script: FakeTurnScript, options?: SendQueryOptions) => (): AsyncIterable<MessageChunk> =>
          providerWith(script).provider.sendQuery('p', '/workspace', undefined, options);
      const failed = (info: CodexErrorInfo, message: string): FakeTurnScript => ({
        completion: { status: 'failed', error: turnError(info, message) },
      });
      const violations = await runProviderConformance({
        turns: [{ name: 'completed turn', run: turn({ notifications: [agentMessage('hi')] }) }],
        failureCases: [
          {
            name: 'missing credentials',
            expected: 'auth',
            evidence: 'Missing bearer',
            run: turn(
              failed({ httpConnectionFailed: { httpStatusCode: 401 } }, '401 Missing bearer')
            ),
          },
          {
            name: 'rate limit',
            expected: 'rate_limited',
            evidence: 'slow down',
            run: turn(failed('rateLimitExceeded', 'slow down')),
          },
          {
            name: 'session budget',
            expected: 'budget_exceeded',
            evidence: 'budget',
            run: turn(failed('sessionBudgetExceeded', 'session budget reached')),
          },
          {
            name: 'unsupported model',
            expected: 'unknown',
            evidence: 'not supported',
            run: turn(failed('other', "The 'x' model is not supported")),
          },
          {
            name: 'process exits mid-turn',
            expected: 'transient',
            evidence: 'exited',
            run: turn({
              notifications: [itemStarted(command('cmd-1', 'sleep 60'))],
              exitCode: 137,
            }),
          },
          {
            name: 'binary pin that does not exist',
            expected: 'misconfigured',
            evidence: 'does not exist',
            run: turn({}, { assistantConfig: { codexBinaryPath: '/nonexistent/codex-bin' } }),
          },
          {
            name: 'binary missing at spawn',
            expected: 'misconfigured',
            evidence: 'ENOENT',
            run: turn({ spawnError: 'ENOENT' }),
          },
        ],
        toolTurn: {
          name: 'tool turn',
          // The turn completes while a second command still runs: the provider closes it.
          run: turn({
            notifications: [
              itemStarted(command('cmd-1', 'ls')),
              itemStarted(command('cmd-2', 'sleep 60')),
              itemCompleted(command('cmd-1', 'ls', { exitCode: 0, output: 'a.ts' })),
            ],
          }),
        },
      });
      expect(violations).toEqual([]);
    });
  });

  describe('cancel', () => {
    test('interrupts the turn, closes the running command as cancelled, shuts down, and throws', async () => {
      const { provider, server } = providerWith({
        notifications: [itemStarted(command('cmd-1', 'sleep 60'))],
        completion: null,
      });
      const controller = new AbortController();
      const chunks: MessageChunk[] = [];
      let error: Error | undefined;
      try {
        for await (const chunk of provider.sendQuery('p', '/workspace', undefined, {
          abortSignal: controller.signal,
        })) {
          chunks.push(chunk);
          if (chunk.type === 'tool_call') controller.abort();
        }
      } catch (e) {
        error = e as Error;
      }

      expect(error?.message).toBe('Query aborted');
      expect(chunks.map(c => c.type)).toEqual(['tool_call', 'tool_call_update']);
      expect(chunks[1]).toMatchObject({ toolCallId: 'cmd-1', status: 'cancelled' });
      const process0 = server.processes[0];
      expect(paramsOf(server, 'turn/interrupt')).toEqual({ threadId: THREAD_ID, turnId: TURN_ID });
      expect(process0.stdinEnded).toBe(true);
      expect(process0.signals).toEqual([]);
    });

    test('an abort while the turn is being set up stops the process before any turn starts', async () => {
      const controller = new AbortController();
      const server = createFakeAppServer();
      const spawner = ((...args: Parameters<typeof server>) => {
        controller.abort();
        return server(...args);
      }) as typeof server;
      await expect(
        run(new CodexProvider(spawner), { abortSignal: controller.signal })
      ).rejects.toThrow('Query aborted');
      expect(server.processes[0].methods).not.toContain('turn/start');
      expect(server.processes[0].stdinEnded).toBe(true);
    });

    test('an abort before the turn starts throws without spawning', async () => {
      const { provider, server } = providerWith();
      const controller = new AbortController();
      controller.abort();
      await expect(run(provider, { abortSignal: controller.signal })).rejects.toThrow(
        'Query aborted'
      );
      expect(server.processes).toHaveLength(0);
    });
  });
});
