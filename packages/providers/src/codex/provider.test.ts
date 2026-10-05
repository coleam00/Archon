import { describe, test, expect, mock, beforeEach, beforeAll, afterAll } from 'bun:test';
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

import { TOOL_OUTPUT_MAX_CHARS, type ProviderFailureClass } from '@archon/provider-contract';
import {
  checkFailureClasses,
  runProviderConformance,
  type ProviderBackgroundCase,
} from '@archon/provider-contract/conformance';
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
  subAgentActivity,
  tokenUsage,
  turnCompleted,
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
  if (script.exitCode !== undefined || script.startupFailure || script.spawnError) {
    expect(chunks.some(chunk => chunk.type === 'settled')).toBe(false);
    return chunks;
  }
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

// Notification ordering and item shapes from the 0.160.0 #3728 probe, with fixture IDs.
function backgroundCase(agent: boolean): ProviderBackgroundCase {
  const bg = {
    ...command('exec-1', 'sleep 20'),
    source: 'unifiedExecStartup' as const,
    processId: '94316',
  };
  const taskId = agent ? 'agent:child-thread' : `command:${THREAD_ID}:exec-1`;
  const runtime = new Map<string, Extract<MessageChunk, { type: 'subtask' }>['status']>();
  return {
    name: agent ? 'subagent outlives its parent' : 'unified exec outlives its turn',
    runtimeStatus: id => runtime.get(id),
    run: async function* () {
      runtime.clear();
      runtime.set(taskId, 'started');
      const { provider, server } = providerWith({
        notifications: [
          itemStarted(agent ? subAgentActivity('started') : bg),
          ...(agent ? [itemCompleted(subAgentActivity('started'))] : []),
          turnCompleted('completed'),
        ],
        completion: null,
      });
      for await (const chunk of provider.sendQuery('p', '/workspace')) {
        yield chunk;
        if (chunk.type === 'result') {
          expect(server.processes[0].stdinEnded).toBe(false);
          runtime.set(taskId, 'completed');
          if (agent) {
            server.processes[0].send(itemStarted(subAgentActivity('completed')));
            server.processes[0].send(itemCompleted(subAgentActivity('completed')));
          } else
            server.processes[0].send(itemCompleted({ ...bg, status: 'completed', exitCode: 0 }));
        }
      }
    },
  };
}

const originalCodexHome = process.env.CODEX_HOME;
beforeAll(async () => {
  process.env.CODEX_HOME = trackTempRoot(await mkdtemp(join(tmpdir(), 'codex-home-')));
});
afterAll(() => {
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
});

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
      backgroundWork: 'reported' as const,
      sessionResume: true,
      sessionFork: true,
      mcp: true,
      hooks: false,
      skills: false,
      plugins: true,
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

  describe('background work', () => {
    test('keeps the app-server alive after the result until both observed lifecycles end', async () => {
      const bg = {
        ...command('exec-1', 'sleep 20'),
        source: 'unifiedExecStartup' as const,
        processId: '94316',
      };
      const { provider, server } = providerWith({
        notifications: [
          itemStarted(subAgentActivity('started')),
          itemCompleted(subAgentActivity('started')),
          itemStarted(bg),
          agentMessage('parent answer'),
          turnCompleted('completed'),
        ],
        completion: null,
      });
      const chunks: MessageChunk[] = [];
      for await (const chunk of provider.sendQuery('p', '/workspace')) {
        chunks.push(chunk);
        const process = server.processes[0];
        if (chunk.type === 'result') {
          expect(process.stdinEnded).toBe(false);
          process.send(itemCompleted({ ...bg, status: 'completed', exitCode: 0 }));
        } else if (
          chunk.type === 'subtask' &&
          chunk.status === 'completed' &&
          chunk.taskType === 'command_execution'
        ) {
          expect(process.stdinEnded).toBe(false);
          process.send(itemStarted(subAgentActivity('completed')));
          process.send(itemCompleted(subAgentActivity('completed')));
        }
      }
      expect(chunks.filter(c => c.type === 'subtask').map(c => c.status)).toEqual([
        'started',
        'started',
        'completed',
        'completed',
      ]);
      expect(chunks.filter(c => c.type === 'tool_call_update')).toEqual([]);
      expect(chunks.at(-1)).toEqual({ type: 'settled' });
      expect(server.processes[0].stdinEnded).toBe(true);
    });

    test('tracks a child process started after the parent result without adopting child replies or unrelated work', async () => {
      const bg = { ...command('exec-child', 'sleep 20'), source: 'unifiedExecStartup' as const };
      const { provider, server } = providerWith({
        notifications: [
          itemStarted(subAgentActivity('started', 'unrelated-child'), 'unrelated-thread'),
          itemStarted(subAgentActivity('started')),
          agentMessage('{"answer":"parent"}'),
          turnCompleted('completed'),
        ],
        completion: null,
      });
      const chunks: MessageChunk[] = [];
      for await (const chunk of provider.sendQuery('p', '/workspace', undefined, {
        nodeConfig: {
          output_format: {
            type: 'json_schema',
            schema: {
              type: 'object',
              properties: { answer: { type: 'string' } },
              required: ['answer'],
              additionalProperties: false,
            },
          },
        },
      })) {
        chunks.push(chunk);
        const process = server.processes[0];
        if (chunk.type === 'result') {
          process.send(itemStarted(bg, 'child-thread', 'child-turn'));
          process.send(
            itemCompleted(
              {
                type: 'agentMessage',
                id: 'child-reply',
                text: 'child answer',
                phase: null,
                memoryCitation: null,
                delivery: null,
                questions: null,
              },
              'child-thread',
              'child-turn'
            )
          );
          process.send(turnCompleted('completed', null, TURN_ID, 'child-thread'));
          process.send(itemStarted(subAgentActivity('completed')));
        } else if (
          chunk.type === 'subtask' &&
          chunk.taskType === 'local_agent' &&
          chunk.status === 'completed'
        ) {
          expect(process.stdinEnded).toBe(false);
          process.send(
            itemCompleted({ ...bg, status: 'completed', exitCode: 0 }, 'child-thread', 'child-turn')
          );
        }
      }
      expect(chunks.filter(c => c.type === 'subtask').map(c => c.status)).toEqual([
        'started',
        'started',
        'completed',
        'completed',
      ]);
      expect(chunks.filter(c => c.type === 'agent_message_chunk')).toEqual([
        { type: 'agent_message_chunk', text: '{"answer":"parent"}' },
      ]);
      expect(resultOf(chunks).structuredOutput).toEqual({ answer: 'parent' });
      expect(chunks.at(-1)).toEqual({ type: 'settled' });
    });

    test.each(['completed', 'failed', 'declined'] as const)(
      'reports unified exec terminal status %s from the runtime',
      async status => {
        const bg = { ...command('exec-1', 'exit 1'), source: 'unifiedExecStartup' as const };
        const { provider, server } = providerWith({
          notifications: [
            itemStarted(bg),
            turnCompleted('failed', turnError('other', 'parent failed')),
          ],
          completion: null,
        });
        const chunks: MessageChunk[] = [];
        for await (const chunk of provider.sendQuery('p', '/workspace')) {
          chunks.push(chunk);
          if (chunk.type === 'result') {
            expect(server.processes[0].stdinEnded).toBe(false);
            server.processes[0].send(itemCompleted({ ...bg, status, exitCode: 1 }));
          }
        }
        expect(chunks.filter(c => c.type === 'subtask').map(c => c.status)).toEqual([
          'started',
          status === 'declined' ? 'stopped' : status,
        ]);
        expect(chunks.at(-1)).toEqual({ type: 'settled' });
      }
    );

    test('cancellation after a result leaves observed work live and does not settle', async () => {
      const { provider, server } = providerWith({
        notifications: [itemStarted(subAgentActivity('started')), turnCompleted('completed')],
        completion: null,
      });
      const controller = new AbortController();
      const chunks: MessageChunk[] = [];
      const consume = async (): Promise<void> => {
        for await (const chunk of provider.sendQuery('p', '/workspace', undefined, {
          abortSignal: controller.signal,
        })) {
          chunks.push(chunk);
          if (chunk.type === 'result') {
            server.processes[0].send(itemCompleted(subAgentActivity('interrupted')));
            server.processes[0].send(itemCompleted(subAgentActivity('interacted')));
            controller.abort();
          }
        }
      };
      await expect(consume()).rejects.toThrow('Query aborted');
      expect(chunks.map(c => c.type)).toEqual(['subtask', 'result']);
      expect(server.processes[0].stdinEnded).toBe(true);
    });

    test('an abnormal process exit after the final notification is not a settle', async () => {
      const { provider, server } = providerWith({
        notifications: [turnCompleted('completed')],
        exitCode: 137,
      });
      const chunks = await run(provider);
      expect(chunks.map(c => c.type)).toEqual(['result']);
      expect(server.processes[0].signals).toEqual([]);
    });

    test('lost observation after the result never invents an end or settles', async () => {
      const { provider, server } = providerWith({
        notifications: [itemStarted(subAgentActivity('started')), turnCompleted('completed')],
        completion: null,
      });
      const chunks: MessageChunk[] = [];
      for await (const chunk of provider.sendQuery('p', '/workspace')) {
        chunks.push(chunk);
        if (chunk.type === 'result') server.processes[0].exit(137);
      }
      expect(chunks.map(c => c.type)).toEqual(['subtask', 'result']);
      expect(chunks[0]).toMatchObject({ status: 'started' });
      expect(server.processes[0].stdinEnded).toBe(false);
    });
  });

  describe('a turn', () => {
    test('streams the reply and ends with the thread id and this turn’s usage', async () => {
      const chunks = await streamOf({
        notifications: [
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

    // Snapshots recorded from `codex app-server` 0.160.0: a turn of three requests on a new
    // thread, then a resumed turn of two requests on the same thread.
    test('a turn of several requests records all of them, once each', async () => {
      const chunks = await streamOf({
        notifications: [
          tokenUsage({ input: 26598, output: 37, cached: 7168 }),
          tokenUsage(
            { input: 53291, output: 59, cached: 33536 },
            { input: 26693, output: 22, cached: 26368 }
          ),
          tokenUsage(
            { input: 80066, output: 64, cached: 60032 },
            { input: 26775, output: 5, cached: 26496 }
          ),
          // Codex re-sends its current snapshot without a new request.
          tokenUsage(
            { input: 80066, output: 64, cached: 60032 },
            { input: 26775, output: 5, cached: 26496 }
          ),
        ],
      });
      expect(resultOf(chunks).tokens).toEqual({
        input: 80066,
        output: 64,
        cacheRead: 60032,
        cacheWrite: 0,
      });
    });

    test('a resumed turn records only its own requests, not the thread’s earlier turns', async () => {
      const { provider } = providerWith({
        notifications: [
          tokenUsage(
            { input: 106866, output: 99, cached: 86656 },
            { input: 26800, output: 35, cached: 26624 }
          ),
          tokenUsage(
            { input: 133758, output: 105, cached: 113280 },
            { input: 26892, output: 6, cached: 26624 }
          ),
        ],
      });
      const chunks = await run(provider, undefined, THREAD_ID);
      expect(resultOf(chunks).tokens).toEqual({
        input: 26800 + 26892,
        output: 35 + 6,
        cacheRead: 26624 + 26624,
        cacheWrite: 0,
      });
    });

    test('a turn that used no tokens does not report another turn’s usage', async () => {
      const chunks = await streamOf({
        notifications: [tokenUsage({ input: 999, output: 999 }, undefined, 'earlier-turn')],
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

    test('a resumed thread gets the same settings a new one would', async () => {
      const dir = trackTempRoot(await mkdtemp(join(tmpdir(), 'codex-provider-resume-')));
      await writeFile(join(dir, 'mcp.json'), JSON.stringify({ local: { command: 'mcp-server' } }));
      const options: SendQueryOptions = {
        model: 'gpt-request',
        assistantConfig: { webSearchMode: 'live', additionalDirectories: ['/extra'] },
        nodeConfig: { nodeId: 'implement', mcp: 'mcp.json' },
      };
      const { provider, server } = providerWith();
      for await (const _ of provider.sendQuery('p', dir, undefined, options)) {
        // consume
      }
      const started = paramsOf(server, 'thread/start');
      for await (const _ of provider.sendQuery('p', dir, 'existing-thread', options)) {
        // consume
      }
      const { threadId, excludeTurns, ...resumed } = paramsOf(server, 'thread/resume') ?? {};
      expect({ threadId, excludeTurns }).toEqual({
        threadId: 'existing-thread',
        excludeTurns: true,
      });
      expect(started).toBeDefined();
      expect(resumed).toEqual(started ?? {});
    });

    test('a fork continues the thread in a new one with the settings a new thread gets', async () => {
      const dir = trackTempRoot(await mkdtemp(join(tmpdir(), 'codex-provider-fork-')));
      await writeFile(join(dir, 'mcp.json'), JSON.stringify({ local: { command: 'mcp-server' } }));
      const options: SendQueryOptions = {
        model: 'gpt-request',
        assistantConfig: { webSearchMode: 'live', additionalDirectories: ['/extra'] },
        nodeConfig: { nodeId: 'implement', mcp: 'mcp.json' },
      };
      const { provider, server } = providerWith({ configuredServers: ['posthog'] });
      for await (const _ of provider.sendQuery('p', dir, undefined, options)) {
        // consume
      }
      const started = paramsOf(server, 'thread/start');
      const chunks: MessageChunk[] = [];
      for await (const chunk of provider.sendQuery('p', dir, 'existing-thread', {
        ...options,
        forkSession: true,
      })) {
        chunks.push(chunk);
      }
      expect(server.processes.at(-1)?.methods).not.toContain('thread/resume');
      const { threadId, excludeTurns, ...forked } = paramsOf(server, 'thread/fork') ?? {};
      expect({ threadId, excludeTurns }).toEqual({
        threadId: 'existing-thread',
        excludeTurns: true,
      });
      // The scoped config is not stored with the source thread; without it the fork would
      // load the user's MCP servers and plugins again.
      expect(started?.config).toMatchObject({ mcp_servers: { posthog: { enabled: false } } });
      expect(forked).toEqual(started ?? {});
      expect(resultOf(chunks)).toMatchObject({
        sessionId: 'existing-thread-fork-1',
        resumed: true,
      });
    });

    test('two runs continuing one thread at once each get their own fork', async () => {
      const { provider } = providerWith();
      const runs = await Promise.all(
        [1, 2].map(() => run(provider, { forkSession: true }, 'existing-thread'))
      );
      const ids = runs.map(chunks => resultOf(chunks).sessionId);
      expect(new Set(['existing-thread', ...ids]).size).toBe(3);
    });

    test('a thread that cannot be forked fails the turn without trying another way', async () => {
      const { provider, server } = providerWith({
        errors: { 'thread/fork': { code: -32600, message: 'no rollout found for thread id x' } },
      });
      const result = resultOf(await run(provider, { forkSession: true }, 'x'));
      expect(result.failure).toEqual({
        class: 'unknown',
        evidence: 'thread/fork failed (JSON-RPC -32600): no rollout found for thread id x',
      });
      expect(server.processes[0].methods).toEqual(['initialize', 'thread/fork']);
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

    // #3562 renamed Archon's setup variables instead of stripping Codex's own names
    // here. This fails if the provider starts filtering CODEX_ACCESS_TOKEN out.
    test('the Codex env is not stripped of a user’s own CODEX_ACCESS_TOKEN (#3562)', async () => {
      const original = process.env.CODEX_ACCESS_TOKEN;
      process.env.CODEX_ACCESS_TOKEN = 'user-codex-token';
      try {
        const { provider, server } = providerWith();
        await run(provider, { env: { ARCHON_CODEX_ACCESS_TOKEN: 'archon-setup-token' } });
        expect(server.processes[0].env.CODEX_ACCESS_TOKEN).toBe('user-codex-token');
      } finally {
        if (original === undefined) delete process.env.CODEX_ACCESS_TOKEN;
        else process.env.CODEX_ACCESS_TOKEN = original;
      }
    });
  });

  describe('API key opt-in', () => {
    test('CODEX_API_KEY logs in with the key, held only by the process', async () => {
      const { provider, server } = providerWith();
      const chunks = await run(provider, { env: { CODEX_API_KEY: 'sk-test-key' } });
      expect(resultOf(chunks).failure).toBeUndefined();
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

    test.each([
      ['ENOENT', 'misconfigured'],
      ['EACCES', 'misconfigured'],
      ['ENOEXEC', 'misconfigured'],
      ['EPERM', 'misconfigured'],
      ['E2BIG', 'misconfigured'],
      ['ENAMETOOLONG', 'misconfigured'],
      ['ELOOP', 'misconfigured'],
      ['EMFILE', 'transient'],
    ] satisfies [string, ProviderFailureClass][])(
      'a spawn that fails with %s is %s',
      async (errno, expected) => {
        const { provider } = providerWith({ spawnError: errno });
        const result = resultOf(await run(provider));
        expect(result.failure?.class).toBe(expected);
        expect(result.failure?.evidence).toContain(errno);
      }
    );
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

  describe('title request scope', () => {
    test('fresh and resumed titles use empty scope and read-only, overriding node declarations', async () => {
      for (const nodeConfig of [
        undefined,
        { nodeId: 'implement', plugins: ['alpha@fixture'], mcp: 'nonexistent.json' },
      ]) {
        const options: SendQueryOptions = { purpose: 'title-generation', nodeConfig };
        const { provider, server } = providerWith({ configuredServers: ['posthog'] });
        for (const resumeId of [undefined, 'existing-thread']) {
          expect(resultOf(await run(provider, options, resumeId)).failure).toBeUndefined();
          const method = resumeId ? 'thread/resume' : 'thread/start';
          expect(server.processes.at(-1)?.methods).toEqual([
            'initialize',
            'config/read',
            method,
            'mcpServerStatus/list',
            'turn/start',
          ]);
          expect(server.processes.at(-1)?.args).toEqual(['app-server']);
          expect(paramsOf(server, method)).toMatchObject({
            sandbox: 'read-only',
            approvalPolicy: 'never',
            config: {
              skills: { include_instructions: false },
              features: { apps: false, plugins: false },
              mcp_servers: { posthog: { enabled: false } },
            },
          });
        }
      }
    });

    test('titles fail closed when inventory rejects or an undeclared server is live', async () => {
      for (const script of [
        {
          errors: { 'config/read': { code: -32600, message: 'Invalid request: unknown variant' } },
        },
        { mcpStatusPages: [[{ name: 'posthog', pluginId: null, runtimeStatus: 'connected' }]] },
      ] satisfies FakeTurnScript[]) {
        const { provider, server } = providerWith(script);
        const options: SendQueryOptions = { purpose: 'title-generation' };
        expect(resultOf(await run(provider, options)).failure?.class).toBe('misconfigured');
        expect(server.processes[0].methods).not.toContain('turn/start');
      }
    });
  });

  describe('workflow node scope', () => {
    const node = { nodeConfig: { nodeId: 'implement' } } satisfies SendQueryOptions;

    test('a fresh, resumed or forked thread loads no ambient plugin, app or server, and is checked before its turn', async () => {
      const { provider, server } = providerWith({ configuredServers: ['posthog'] });
      for (const [resumeId, forkSession, threadMethod] of [
        [undefined, false, 'thread/start'],
        ['existing-thread', false, 'thread/resume'],
        ['existing-thread', true, 'thread/fork'],
      ] as const) {
        const result = resultOf(await run(provider, { ...node, forkSession }, resumeId));
        expect(result.failure).toBeUndefined();
        expect(server.processes.at(-1)?.methods).toEqual([
          'initialize',
          'config/read',
          threadMethod,
          'mcpServerStatus/list',
          'turn/start',
        ]);
        expect(paramsOf(server, threadMethod)?.config).toMatchObject({
          features: { apps: false, plugins: false },
          mcp_servers: { posthog: { enabled: false } },
        });
      }
    });

    test('a named plugin stays on without its MCP servers; other installed plugins are off', async () => {
      const { provider, server } = providerWith({
        installedPlugins: { 'alpha@fixture': ['alpha_srv'], 'beta@fixture': ['beta_srv'] },
      });
      await run(provider, { nodeConfig: { nodeId: 'implement', plugins: ['alpha@fixture'] } });
      expect(paramsOf(server, 'plugin/read')).toMatchObject({ pluginName: 'alpha' });
      // Plugins on for the process, so a user's global plugins-off still lists them.
      expect(server.processes[0].args).toEqual(['app-server', '-c', 'features.plugins=true']);
      expect(paramsOf(server, 'thread/start')?.config).toMatchObject({
        features: { apps: false, plugins: true },
        plugins: {
          'alpha@fixture': { enabled: true, mcp_servers: { alpha_srv: { enabled: false } } },
          'beta@fixture': { enabled: false },
        },
      });
    });

    test('a live server the node did not declare fails misconfigured before the turn, across pages', async () => {
      const { provider, server } = providerWith({
        mcpStatusPages: [
          [{ name: 'posthog', pluginId: null, runtimeStatus: 'disabled' }],
          [
            {
              name: 'cua_repl',
              pluginId: 'computer-use@openai-bundled',
              runtimeStatus: 'starting',
            },
          ],
        ],
      });
      const result = resultOf(await run(provider, node));
      expect(result.failure?.class).toBe('misconfigured');
      expect(result.failure?.evidence).toContain(
        'Codex loaded MCP servers this node does not declare: cua_repl (plugin computer-use@openai-bundled)'
      );
      expect(result.sessionId).toBe(THREAD_ID);
      expect(server.processes[0].methods).not.toContain('turn/start');
    });

    test('a configured server Codex still reports live fails, though the thread config named it', async () => {
      const { provider } = providerWith({
        configuredServers: ['posthog'],
        mcpStatusPages: [[{ name: 'posthog', pluginId: null, runtimeStatus: 'connected' }]],
      });
      const result = resultOf(await run(provider, node));
      expect(result.failure?.evidence).toContain('does not declare: posthog.');
    });

    test('a status this Codex version does not list counts as live', async () => {
      const { provider } = providerWith({
        mcpStatusPages: [
          // A status a newer Codex might add; the generated union does not have it.
          [{ name: 'posthog', pluginId: null, runtimeStatus: 'suspended' as 'disabled' }],
        ],
      });
      const result = resultOf(await run(provider, node));
      expect(result.failure?.class).toBe('misconfigured');
      expect(result.failure?.evidence).toContain('does not declare: posthog.');
    });

    test('a declared live server passes the check', async () => {
      const dir = trackTempRoot(await mkdtemp(join(tmpdir(), 'codex-provider-scope-')));
      await writeFile(join(dir, 'mcp.json'), JSON.stringify({ local: { command: 'mcp-server' } }));
      const { provider, server } = providerWith({
        mcpStatusPages: [[{ name: 'local', pluginId: null, runtimeStatus: 'connected' }]],
      });
      const chunks: MessageChunk[] = [];
      for await (const chunk of provider.sendQuery('p', dir, undefined, {
        nodeConfig: { nodeId: 'implement', mcp: 'mcp.json' },
      })) {
        chunks.push(chunk);
      }
      expect(resultOf(chunks).failure).toBeUndefined();
      expect(server.processes[0].methods).toContain('turn/start');
    });

    test('a named plugin that is not installed fails misconfigured before any thread', async () => {
      const { provider, server } = providerWith({ installedPlugins: { 'alpha@fixture': [] } });
      const result = resultOf(
        await run(provider, { nodeConfig: { nodeId: 'implement', plugins: ['ghost@fixture'] } })
      );
      expect(result.failure).toEqual({
        class: 'misconfigured',
        evidence:
          'Codex plugin not installed in /home/user/.codex: ghost@fixture. Installed: alpha@fixture. ' +
          'Name plugins by their exact `name@marketplace` id from `codex plugin list`.',
      });
      expect(server.processes[0].methods).not.toContain('thread/start');
    });

    test('an inventory request Codex rejects fails misconfigured before any thread', async () => {
      const { provider, server } = providerWith({
        errors: { 'config/read': { code: -32600, message: 'Invalid request: unknown variant' } },
      });
      const result = resultOf(await run(provider, node));
      expect(result.failure?.class).toBe('misconfigured');
      expect(result.failure?.evidence).toContain('config/read failed');
      expect(server.processes[0].methods).not.toContain('thread/start');
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

    test('a process that exits before answering anything is misconfigured, with its stderr as evidence', async () => {
      const result = resultOf(
        await streamOf({
          startupFailure: {
            code: 2,
            stderr: "error: unexpected argument '--bogus' found\n",
          },
        })
      );
      expect(result.failure?.class).toBe('misconfigured');
      expect(result.failure?.evidence).toContain('exited (code 2)');
      expect(result.failure?.evidence).toContain("unexpected argument '--bogus'");
    });

    test('a process that exits mid-turn still reports the thread, so the next attempt can resume it', async () => {
      const result = resultOf(await streamOf({ exitCode: 1 }));
      expect(result.sessionId).toBe(THREAD_ID);
    });

    test('errors Codex recovered from leave a completed turn clean', async () => {
      const chunks = await streamOf({
        notifications: [errorNotification('Reconnecting... 1/5', true), agentMessage('done')],
      });
      expect(resultOf(chunks)).toEqual({ type: 'result', sessionId: THREAD_ID });
    });

    test('each retry Codex announces is a warning with its cause and no vendor text', async () => {
      const chunks = await streamOf({
        notifications: [
          errorNotification('Reconnecting... 1/5 (secret vendor body)', true, {
            responseStreamDisconnected: { httpStatusCode: 503 },
          }),
          errorNotification('Reconnecting... 2/5', true, 'serverOverloaded'),
          errorNotification('stream ended', false, 'other'),
          agentMessage('done'),
        ],
      });
      const warnings = chunks.filter(chunk => chunk.type === 'warning');
      expect(warnings).toEqual([
        {
          type: 'warning',
          code: 'codex.will_retry',
          message:
            'Codex is retrying the model call (retry 1 this turn, responseStreamDisconnected, HTTP 503)',
        },
        {
          type: 'warning',
          code: 'codex.will_retry',
          message: 'Codex is retrying the model call (retry 2 this turn, serverOverloaded)',
        },
      ]);
    });

    test('a replayed completion of an earlier turn does not end this one', async () => {
      const chunks = await streamOf({
        notifications: [
          turnCompleted('failed', turnError('other', 'earlier failure'), 'earlier-turn'),
          agentMessage('done'),
        ],
      });
      expect(chunks).toEqual([
        { type: 'agent_message_chunk', text: 'done' },
        { type: 'result', sessionId: THREAD_ID },
      ]);
    });

    test('a process killed by a signal before it answers is transient', async () => {
      const result = resultOf(
        await streamOf({ startupFailure: { signal: 'SIGKILL', stderr: '' } })
      );
      expect(result.failure?.class).toBe('transient');
      expect(result.failure?.evidence).toContain('signal SIGKILL');
    });

    test('stderr that mentions a model does not earn model-access advice', async () => {
      const result = resultOf(
        await streamOf({
          startupFailure: { code: 1, stderr: 'error: model catalog file not found\n' },
        })
      );
      expect(result.failure?.evidence).toContain('model catalog file not found');
      expect(result.failure?.evidence).not.toContain('is not available for your account');
    });

    test('a credential Codex echoes to stderr never reaches the failure evidence', async () => {
      const result = resultOf(
        await streamOf(
          {
            startupFailure: {
              code: 1,
              stderr: 'error: login failed for key sk-echoed-secret-1234\n',
            },
          },
          { env: { CODEX_API_KEY: 'sk-echoed-secret-1234' } }
        )
      );
      expect(result.failure?.evidence).toContain('login failed for key [REDACTED]');
      expect(JSON.stringify(result)).not.toContain('sk-echoed-secret-1234');
    });

    test('protected commit author values never reach startup failure evidence', async () => {
      const env = {
        GIT_AUTHOR_NAME: 'connected-author',
        GIT_AUTHOR_EMAIL: '42+connected-author@users.noreply.github.com',
      };
      const chunks = await streamOf(
        {
          startupFailure: {
            code: 1,
            stderr: `bad config for ${env.GIT_AUTHOR_NAME} <${env.GIT_AUTHOR_EMAIL}>`,
          },
        },
        { env, protectedEnvKeys: Object.keys(env) }
      );
      expect(resultOf(chunks).failure?.evidence).toContain(
        'bad config for [REDACTED] <[REDACTED]>'
      );
      expect(JSON.stringify(chunks)).not.toContain(env.GIT_AUTHOR_NAME);
      expect(JSON.stringify(chunks)).not.toContain(env.GIT_AUTHOR_EMAIL);
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
        capabilities: new CodexProvider().getCapabilities(),
        backgroundCases: [backgroundCase(true), backgroundCase(false)],
        turns: [
          { name: 'completed turn', run: turn({ notifications: [agentMessage('hi')] }) },
          {
            name: 'turn Codex retried',
            run: turn({
              notifications: [
                errorNotification('Reconnecting... 1/5', true, 'serverOverloaded'),
                agentMessage('hi'),
              ],
            }),
          },
        ],
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
            name: 'binary pin that does not exist',
            expected: 'misconfigured',
            evidence: 'does not exist',
            run: turn({}, { assistantConfig: { codexBinaryPath: '/nonexistent/codex-bin' } }),
          },
        ],
        forkTurn: {
          name: 'forked thread',
          source: 'existing-thread',
          run: () =>
            providerWith().provider.sendQuery('p', '/workspace', 'existing-thread', {
              forkSession: true,
            }),
        },
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
      expect(
        await checkFailureClasses([
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
            name: 'binary that exits before answering',
            expected: 'misconfigured',
            evidence: 'stdin is not a terminal',
            run: turn({ startupFailure: { code: 1, stderr: 'Error: stdin is not a terminal' } }),
          },
          {
            name: 'binary missing at spawn',
            expected: 'misconfigured',
            evidence: 'ENOENT',
            run: turn({ spawnError: 'ENOENT' }),
          },
        ])
      ).toEqual([]);
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

    test('a Codex that answers neither the interrupt nor stdin close is stopped with SIGTERM', async () => {
      const server = createFakeAppServer(() => ({
        notifications: [itemStarted(command('cmd-1', 'sleep 60'))],
        completion: null,
        ignoreInterrupt: true,
        ignoreStdinClose: true,
      }));
      const provider = new CodexProvider(server, 20);
      const controller = new AbortController();
      let error: Error | undefined;
      try {
        for await (const chunk of provider.sendQuery('p', '/workspace', undefined, {
          abortSignal: controller.signal,
        })) {
          if (chunk.type === 'tool_call') controller.abort();
        }
      } catch (e) {
        error = e as Error;
      }

      expect(error?.message).toBe('Query aborted');
      expect(server.processes[0].methods).toContain('turn/interrupt');
      expect(server.processes[0].stdinEnded).toBe(true);
      expect(server.processes[0].signals).toEqual(['SIGTERM']);
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
