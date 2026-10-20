import * as containerSpawnModule from './container-spawn';
import { overStreams } from '../test/plugin';
import { createProvider, descriptor } from './index';
import { describe, test, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import type { Options, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { createMockLogger } from '../test/mocks/logger';
import type { IAgentProvider, MessageChunk } from '../types';

const tempRoots = trackTempRoots();

const mockLogger = createMockLogger();
mock.module('@archon/paths', () => ({
  BUNDLED_VERSION: 'test',
  createLogger: mock(() => mockLogger),
}));

type MockQuery = (...args: Parameters<typeof sdkQuery>) => AsyncGenerator<unknown, void, unknown>;

// Keep the SDK input signature while allowing tests to exercise malformed and
// forward-compatible events at the provider's runtime validation boundary.
const mockQuery = mock<MockQuery>(async function* (_params) {
  // Empty generator by default
});

// Mock the claude-agent-sdk
const sdkToolHandlers = new Map<
  string,
  (args: Record<string, unknown>) => Promise<{ content: { type: 'text'; text: string }[] }>
>();
mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  createSdkMcpServer: ({ name }: { name: string }) => ({
    type: 'sdk',
    name,
    instance: {
      registerTool: (
        name: string,
        _config: unknown,
        handler: (
          args: Record<string, unknown>
        ) => Promise<{ content: { type: 'text'; text: string }[] }>
      ) => {
        sdkToolHandlers.set(name, handler);
      },
    },
  }),
  query: mockQuery,
}));

import { TOOL_OUTPUT_MAX_CHARS, type ProviderStopReason } from '@archon/provider-contract';
import { runProviderConformance } from '@archon/provider-contract/conformance';
import { ClaudeProvider, shouldPassNoEnvFile } from './provider';
import * as claudeModule from './provider';
import * as binaryResolver from './binary-resolver';
import * as pluginsModule from './plugins';
import { ClassifiedProviderError } from '../shared/failure';

type SendQueryArgs = Parameters<ClaudeProvider['sendQuery']>;
type RequestOptions = NonNullable<SendQueryArgs[3]>;

let client: ClaudeProvider;
// Workflow nodes read the installed-plugin inventory before the session starts.
// Never run the real CLI here; a test that needs an inventory overrides this.
let pluginIdsSpy: ReturnType<typeof spyOn<typeof pluginsModule, 'readClaudePluginIds'>>;
beforeEach(() => {
  pluginIdsSpy = spyOn(pluginsModule, 'readClaudePluginIds').mockResolvedValue([]);
  client = new ClaudeProvider();
  mockQuery.mockClear();
  mockLogger.info.mockClear();
  mockLogger.warn.mockClear();
  mockLogger.error.mockClear();
  mockLogger.debug.mockClear();
});
afterEach(() => {
  pluginIdsSpy.mockRestore();
});

/**
 * Stream-shape tests check the normalized stream, so they drop the chunks the contract
 * adds at the end of every turn: `settled`, and the failure a stream that ended without
 * a result reports. Both have their own tests.
 */
function isTurnEnd(chunk: MessageChunk): boolean {
  return (
    chunk.type === 'settled' ||
    (chunk.type === 'result' && chunk.errorSubtype === 'stream_ended_without_result')
  );
}

/** Makes every SDK query yield `events`. */
function sdkYields(...events: unknown[]): void {
  mockQuery.mockImplementation(async function* () {
    yield* events;
  });
}

/** Every chunk one query streams. */
function chunksOf(...args: SendQueryArgs): Promise<MessageChunk[]> {
  return Array.fromAsync(client.sendQuery(...args));
}

/** What a query over `events` streams, without its turn end. */
async function streamOf(...events: unknown[]): Promise<MessageChunk[]> {
  sdkYields(...events);
  return (await chunksOf('test', '/workspace')).filter(chunk => !isTurnEnd(chunk));
}

/** The options the SDK received on query number `call`. */
function sdkOptions(call = 0): Options {
  const options = mockQuery.mock.calls[call]?.[0].options;
  if (!options) throw new Error(`SDK query ${String(call)} received no options`);
  return options;
}

/** Runs one query and returns the options it handed the SDK. */
async function optionsFor(
  request?: RequestOptions,
  resume?: string,
  cwd = '/workspace'
): Promise<Options> {
  sdkYields({ type: 'result', session_id: 'sid' });
  await chunksOf('test', cwd, resume, request);
  expect(mockQuery).toHaveBeenCalledTimes(1);
  return sdkOptions();
}

/** The typed failure a turn that failed before or while querying ended in. */
async function failureOf(
  gen: AsyncIterable<MessageChunk>
): Promise<{ class: string; evidence: string }> {
  let failure: { class: string; evidence: string } | undefined;
  for await (const chunk of gen) {
    if (chunk.type === 'result' && chunk.failure) failure = chunk.failure;
  }
  if (!failure) throw new Error('expected the turn to report a typed failure');
  return failure;
}

interface CollectedStream {
  chunks: Array<Record<string, unknown>>;
  error?: Error;
}

/** Every chunk a stream yields, and the error it threw, if any. */
async function collect(gen: AsyncIterable<Record<string, unknown>>): Promise<CollectedStream> {
  const chunks: Array<Record<string, unknown>> = [];
  try {
    for await (const chunk of gen) {
      chunks.push(chunk);
    }
  } catch (e) {
    return { chunks, error: e as Error };
  }
  return { chunks };
}

/** The one result a failed turn ends in; fails the test if the stream threw or has not exactly one. */
function onlyResult(stream: CollectedStream): Record<string, unknown> {
  expect(stream.error).toBeUndefined();
  const results = stream.chunks.filter(c => c.type === 'result');
  expect(results).toHaveLength(1);
  return results[0];
}

// The SDK does not throw on API-level failures (auth, billing, rate limit).
// It synthesizes an assistant message (model: '<synthetic>', wrapper
// `error` code) with the error prose, then emits a result with
// subtype: 'success' AND is_error: true — the same field pair as the
// legitimate stop-sequence carve-out (#1425). Shapes below are verbatim
// captures from claude CLI 2.1.210 (isolated config dir).
function syntheticAssistantMessage(errorCode: string, text: string): Record<string, unknown> {
  return {
    type: 'assistant',
    message: {
      model: '<synthetic>',
      stop_reason: 'stop_sequence',
      content: [{ type: 'text', text }],
      usage: { input_tokens: 0, output_tokens: 0 },
    },
    error: errorCode,
    session_id: 'sid-api-err',
  };
}

function apiErrorResult(text: string, status: number | null = null): Record<string, unknown> {
  return {
    type: 'result',
    subtype: 'success',
    is_error: true,
    api_error_status: status,
    result: text,
    stop_reason: 'stop_sequence',
    terminal_reason: 'api_error',
    total_cost_usd: 0,
    session_id: 'sid-api-err',
  };
}

function sdkThrown(message: string, fields: Record<string, unknown>): Error {
  return Object.assign(new Error(message), fields);
}

describe('shouldPassNoEnvFile', () => {
  // `--no-env-file` is a Bun runtime option, so only a JS entry point the SDK spawns
  // via Bun takes it. Native binaries (the SDK default since 0.2.x, the curl installer,
  // Homebrew) reject it as an unknown option; CWD .env leak protection comes from
  // stripCwdEnv() at entry, not from this flag.
  test.each([
    '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js',
    '/path/to/cli.mjs',
    '/path/to/cli.cjs',
  ])('passes the flag for the Bun-runnable entry point %s', cliPath => {
    expect(shouldPassNoEnvFile(cliPath)).toBe(true);
  });

  test.each([
    undefined,
    // The SDK never shipped these as entry points; accepting them would only widen misconfiguration.
    '/path/to/cli.ts',
    '/path/to/cli.tsx',
    '/path/to/cli.jsx',
    '/Users/test/.local/bin/claude',
    'C:\\Users\\test\\.local\\bin\\claude.exe',
    '/opt/homebrew/bin/claude',
    // Only a literal `.js` suffix counts.
    '/path/to/cli.json',
    '/path/to/cli.js.bak',
  ])('does not pass the flag for %p', cliPath => {
    expect(shouldPassNoEnvFile(cliPath)).toBe(false);
  });
});

describe('ClaudeProvider', () => {
  test('refuses to construct when running as root (UID 0)', () => {
    const spy = spyOn(claudeModule, 'getProcessUid').mockReturnValue(0);
    // IS_SANDBOX=1 bypasses the root check; clear it so the guard can trigger
    const savedSandbox = process.env.IS_SANDBOX;
    delete process.env.IS_SANDBOX;
    try {
      expect(() => new ClaudeProvider()).toThrow(
        'does not support bypassPermissions when running as root'
      );
    } finally {
      if (savedSandbox !== undefined) process.env.IS_SANDBOX = savedSandbox;
      spy.mockRestore();
    }
  });

  // `undefined` is Windows, where process.getuid is unavailable.
  test.each([1000, undefined])('constructs for UID %p', uid => {
    const spy = spyOn(claudeModule, 'getProcessUid').mockReturnValue(uid);
    expect(() => new ClaudeProvider()).not.toThrow();
    spy.mockRestore();
  });

  test('getType returns claude', () => {
    expect(client.getType()).toBe('claude');
  });

  test('returns full capability set for Claude provider', () => {
    expect(client.getCapabilities()).toMatchObject({
      backgroundWork: 'reported',
      sessionResume: true,
      sessionFork: true,
      mcp: true,
      hooks: true,
      skills: true,
      plugins: true,
      agents: true,
      toolRestrictions: true,
      structuredOutput: 'enforced',
      envInjection: true,
      costControl: true,
      costReporting: true,
      tokenReporting: true,
      stopReasonReporting: true,
      turnCountReporting: true,
      resolvedModelReporting: true,
      effortControl: true,
      fallbackModel: true,
      sandbox: true,
      settingSources: true,
      nativeTools: true,
    });
  });

  test('declares a tool-name vocabulary for allowed/denied_tools validation (#2084)', () => {
    const caps = client.getCapabilities();
    // Current names present; renamed legacy names deliberately absent so
    // validation can flag them with a targeted rename hint.
    expect(caps.knownToolNames).toContain('Agent');
    expect(caps.knownToolNames).toContain('Bash');
    expect(caps.knownToolNames).not.toContain('Task');
    expect(caps.renamedTools).toMatchObject({ Task: 'Agent' });
  });
});

describe('message stream', () => {
  test('yields text events from assistant messages', async () => {
    expect(
      await streamOf({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Hello, world!' }] },
      })
    ).toEqual([{ type: 'agent_message_chunk', text: 'Hello, world!' }]);
  });

  test('yields tool events from tool_use blocks', async () => {
    const chunks = await streamOf({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'npm test' } },
        ],
      },
    });

    // No hook reported the result, so the stream's end closes the call as cancelled.
    expect(chunks).toEqual([
      {
        type: 'tool_call',
        toolCallId: 'toolu_1',
        name: 'Bash',
        title: 'npm test',
        rawInput: { command: 'npm test' },
      },
      { type: 'tool_call_update', toolCallId: 'toolu_1', status: 'cancelled' },
    ]);
  });

  test('yields agent_thought_chunk from a thinking block', async () => {
    const chunks = await streamOf({
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: 'The tests import the mock first.' },
          { type: 'thinking', thinking: '' },
          { type: 'text', text: 'Done.' },
        ],
      },
    });

    expect(chunks).toEqual([
      { type: 'agent_thought_chunk', text: 'The tests import the mock first.' },
      { type: 'agent_message_chunk', text: 'Done.' },
    ]);
  });

  test('handles multiple content blocks in one message', async () => {
    const chunks = await streamOf({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'I will run a command.' },
          { type: 'tool_use', id: 'toolu_ls', name: 'Bash', input: { command: 'ls' } },
          { type: 'text', text: 'Command completed.' },
        ],
      },
    });

    expect(chunks.slice(0, 3)).toEqual([
      { type: 'agent_message_chunk', text: 'I will run a command.' },
      {
        type: 'tool_call',
        toolCallId: 'toolu_ls',
        name: 'Bash',
        title: 'ls',
        rawInput: { command: 'ls' },
      },
      { type: 'agent_message_chunk', text: 'Command completed.' },
    ]);
  });

  test('handles tool_use with empty input', async () => {
    const chunks = await streamOf({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 'toolu_x', name: 'SomeTool', input: undefined }],
      },
    });

    expect(chunks[0]).toEqual({
      type: 'tool_call',
      toolCallId: 'toolu_x',
      name: 'SomeTool',
      rawInput: {},
    });
  });

  test('ignores empty text blocks', async () => {
    const chunks = await streamOf({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: '' },
          { type: 'text', text: 'Real content' },
        ],
      },
    });

    expect(chunks).toEqual([{ type: 'agent_message_chunk', text: 'Real content' }]);
  });

  test('ignores other message types', async () => {
    const chunks = await streamOf(
      { type: 'system', content: 'system message' },
      { type: 'thinking', content: 'thinking...' },
      { type: 'tool_result', content: 'result' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Real response' }] } }
    );

    expect(chunks).toEqual([{ type: 'agent_message_chunk', text: 'Real response' }]);
  });

  test('reports every MCP server from init, connected ones included', async () => {
    const chunks = await streamOf({
      type: 'system',
      subtype: 'init',
      mcp_servers: [
        { name: 'github', status: 'connected' },
        { name: 'linear', status: 'needs-auth' },
        { name: 'broken', status: 'failed', error: 'spawn ENOENT' },
      ],
    });

    expect(chunks).toEqual([
      { type: 'mcp_server_status', server: 'github', status: 'connected' },
      { type: 'mcp_server_status', server: 'linear', status: 'needs_auth' },
      { type: 'mcp_server_status', server: 'broken', status: 'failed', error: 'spawn ENOENT' },
    ]);
  });

  test('reports compaction when it starts and when its boundary lands', async () => {
    const chunks = await streamOf(
      { type: 'system', subtype: 'status', status: 'compacting' },
      {
        type: 'system',
        subtype: 'compact_boundary',
        compact_metadata: { trigger: 'auto', pre_tokens: 180000, post_tokens: 24000 },
      },
      {
        type: 'system',
        subtype: 'compact_boundary',
        compact_metadata: { trigger: 'manual', pre_tokens: 90000 },
      },
      // A status that is not compaction yields nothing.
      { type: 'system', subtype: 'status', status: null }
    );

    expect(chunks).toEqual([
      { type: 'compaction', phase: 'started' },
      {
        type: 'compaction',
        phase: 'completed',
        trigger: 'auto',
        tokensBefore: 180000,
        tokensAfter: 24000,
      },
      { type: 'compaction', phase: 'completed', trigger: 'manual', tokensBefore: 90000 },
    ]);
  });

  test('reports session state running and requires_action, never idle', async () => {
    const chunks = await streamOf(
      { type: 'system', subtype: 'session_state_changed', state: 'running' },
      { type: 'system', subtype: 'session_state_changed', state: 'requires_action' },
      { type: 'system', subtype: 'session_state_changed', state: 'idle' }
    );

    expect(chunks).toEqual([
      { type: 'state_update', state: 'running' },
      { type: 'state_update', state: 'requires_action' },
    ]);
  });

  test('a rate_limit_event renews the watchdog and logs a warning', async () => {
    const chunks = await streamOf({
      type: 'rate_limit_event',
      rate_limit_info: { requests_remaining: 0, retry_after_ms: 5000 },
    });

    expect(chunks).toEqual([{ type: 'state_update', state: 'running' }]);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      { rateLimitInfo: { requests_remaining: 0, retry_after_ms: 5000 } },
      'claude.rate_limit_event'
    );
  });

  test('surfaces the SDK retrying a model call as a warning', async () => {
    const chunks = await streamOf(
      {
        type: 'system',
        subtype: 'api_retry',
        attempt: 3,
        max_retries: 10,
        retry_delay_ms: 8000,
        error_status: 529,
        error: 'overloaded',
      },
      {
        type: 'system',
        subtype: 'api_retry',
        attempt: 1,
        max_retries: 1,
        retry_delay_ms: 450,
        error_status: null,
        error: 'unknown',
      }
    );

    expect(chunks).toEqual([
      {
        type: 'warning',
        code: 'claude.api_retry',
        message:
          'Claude is retrying the model call (attempt 3 of 10, waiting 8s, HTTP 529 overloaded)',
      },
      {
        type: 'warning',
        code: 'claude.api_retry',
        message: 'Claude is retrying the model call (attempt 1 of 1, waiting 450ms, unknown)',
      },
    ]);
  });
});

describe('hook events (#2324)', () => {
  test('opts the SDK into lifecycle hook events for every surface', async () => {
    // The SDK defaults `includeHookEvents` to false, which suppresses
    // `hook_started` / `hook_response` for every hook type except
    // SessionStart and Setup. Without an explicit opt-in, a node-level
    // `PreToolUse` hook that denies Bash never reaches the workflow
    // `hook_activity` stream.
    expect(await optionsFor()).toMatchObject({ includeHookEvents: true });
  });

  test('forwards a denied PreToolUse hook through the chunk pipeline', async () => {
    const hook = { hook_id: 'h-1', hook_name: 'Bash', hook_event: 'PreToolUse' };
    const chunks = await streamOf(
      { type: 'system', subtype: 'hook_started', ...hook },
      { type: 'system', subtype: 'hook_response', ...hook, outcome: 'error', exit_code: 2 }
    );

    const forwarded = {
      type: 'hook',
      hookId: 'h-1',
      hookName: 'Bash',
      hookEvent: 'PreToolUse',
    } as const;
    expect(chunks).toEqual([
      { ...forwarded, status: 'started' },
      { ...forwarded, status: 'failed', exitCode: 2 },
    ]);
  });

  test('forwards a PostToolUse hook lifecycle', async () => {
    const hook = { hook_id: 'h-2', hook_name: 'Edit', hook_event: 'PostToolUse' };
    const chunks = await streamOf(
      { type: 'system', subtype: 'hook_started', ...hook },
      { type: 'system', subtype: 'hook_response', ...hook, outcome: 'success', exit_code: 0 }
    );

    const forwarded = {
      type: 'hook',
      hookId: 'h-2',
      hookName: 'Edit',
      hookEvent: 'PostToolUse',
    } as const;
    expect(chunks).toEqual([
      { ...forwarded, status: 'started' },
      { ...forwarded, status: 'succeeded', exitCode: 0 },
    ]);
  });

  test('yields hook_response with error outcome and no exit_code', async () => {
    const chunks = await streamOf({
      type: 'system',
      subtype: 'hook_response',
      hook_id: 'h-2',
      hook_name: 'Edit',
      hook_event: 'PreToolUse',
      outcome: 'error',
    });

    expect(chunks).toEqual([
      { type: 'hook', hookId: 'h-2', hookName: 'Edit', hookEvent: 'PreToolUse', status: 'failed' },
    ]);
    expect(chunks[0]).not.toHaveProperty('exitCode');
  });

  test('drops hook_progress frames (only emitted for async hooks — none registered)', async () => {
    const chunks = await streamOf(
      {
        type: 'system',
        subtype: 'hook_progress',
        hook_id: 'h-3',
        hook_name: 'Bash',
        hook_event: 'PreToolUse',
        stdout: 'still running...',
        stderr: '',
        output: '',
      },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Real response' }] } }
    );

    // Archon registers only synchronous hooks, and the hooks guide documents the carve-out.
    expect(chunks).toEqual([{ type: 'agent_message_chunk', text: 'Real response' }]);
  });
});

describe('subtasks and settling', () => {
  test('yields task_started chunk from SDK system message', async () => {
    const chunks = await streamOf({
      type: 'system',
      subtype: 'task_started',
      task_id: 't-1',
      description: 'Investigating the bug',
      task_type: 'general-purpose',
    });

    expect(chunks).toEqual([
      {
        type: 'subtask',
        taskId: 't-1',
        status: 'started',
        description: 'Investigating the bug',
        taskType: 'general-purpose',
      },
    ]);
  });

  test('yields task_progress with summary + usage + lastToolName', async () => {
    const usage = { total_tokens: 1234, tool_uses: 3, duration_ms: 28000 };
    const chunks = await streamOf({
      type: 'system',
      subtype: 'task_progress',
      task_id: 't-1',
      description: 'Working on auth',
      summary: 'Reading auth module',
      usage,
      last_tool_name: 'Read',
    });

    expect(chunks).toEqual([
      {
        type: 'subtask',
        taskId: 't-1',
        status: 'running',
        description: 'Working on auth',
        summary: 'Reading auth module',
        usage,
        lastToolName: 'Read',
      },
    ]);
  });

  test('yields task_notification with completed status', async () => {
    const chunks = await streamOf({
      type: 'system',
      subtype: 'task_notification',
      task_id: 't-1',
      status: 'completed',
      output_file: '/tmp/task-output.json',
      summary: 'Plan ready',
    });

    expect(chunks).toEqual([
      {
        type: 'subtask',
        taskId: 't-1',
        status: 'completed',
        summary: 'Plan ready',
        outputFile: '/tmp/task-output.json',
      },
    ]);
  });

  test('yields task_notification with failed status', async () => {
    const chunks = await streamOf({
      type: 'system',
      subtype: 'task_notification',
      task_id: 't-2',
      status: 'failed',
      output_file: '/tmp/task-2.json',
      summary: 'Task failed',
    });

    expect(chunks[0]).toMatchObject({ type: 'subtask', status: 'failed' });
  });

  test('emits complete task lifecycle in correct order', async () => {
    const chunks = await streamOf(
      {
        type: 'system',
        subtype: 'task_started',
        task_id: 't-1',
        description: 'Working on the bug',
      },
      {
        type: 'system',
        subtype: 'task_progress',
        task_id: 't-1',
        description: 'Working on the bug',
        summary: 'Reading stack trace',
      },
      {
        type: 'system',
        subtype: 'task_notification',
        task_id: 't-1',
        status: 'completed',
        output_file: '/tmp/t-1.json',
        summary: 'Done',
      }
    );

    expect(chunks.map(c => (c.type === 'subtask' ? c.status : c.type))).toEqual([
      'started',
      'running',
      'completed',
    ]);
  });

  test('closes an announced subtask whose notification is marked ambient', async () => {
    const chunks = await streamOf(
      { type: 'system', subtype: 'task_started', task_id: 't-1', description: 'Research' },
      {
        type: 'system',
        subtype: 'task_notification',
        task_id: 't-1',
        status: 'completed',
        summary: 'Done',
        ambient: true,
      }
    );

    expect(chunks).toEqual([
      { type: 'subtask', taskId: 't-1', status: 'started', description: 'Research' },
      { type: 'subtask', taskId: 't-1', status: 'completed', summary: 'Done' },
    ]);
  });

  test.each(['ambient', 'skip_transcript'])(
    'hides a %s task lifecycle while preserving its idle heartbeat',
    async flag => {
      const chunks = await streamOf(
        {
          type: 'system',
          subtype: 'task_started',
          task_id: 't-hidden',
          description: 'Housekeeping',
          [flag]: true,
        },
        {
          type: 'system',
          subtype: 'task_progress',
          task_id: 't-hidden',
          description: 'Still running',
        },
        {
          type: 'system',
          subtype: 'task_notification',
          task_id: 't-hidden',
          status: 'completed',
          summary: 'Finished',
        }
      );

      expect(chunks).toEqual([{ type: 'state_update', state: 'running' }]);
    }
  );

  test.each(['ambient', 'skip_transcript'])(
    'drops a housekeeping task_notification when the SDK sets %s',
    async flag => {
      const chunks = await streamOf({
        type: 'system',
        subtype: 'task_notification',
        task_id: 't-housekeeping',
        status: 'completed',
        summary: 'Housekeeping task finished',
        [flag]: true,
      });

      expect(chunks).toHaveLength(0);
    }
  );

  test('settles only when the session goes idle, not at a result while background work runs', async () => {
    // Recorded shape (CLI 2.1.282): a result arrives while a background agent runs,
    // a second result follows once it drains, and only then does the session go idle.
    let readAfterIdle = false;
    mockQuery.mockImplementation(async function* () {
      yield { type: 'system', subtype: 'session_state_changed', state: 'running' };
      yield { type: 'result', subtype: 'success', session_id: 's-1', is_error: false };
      yield {
        type: 'system',
        subtype: 'background_tasks_changed',
        tasks: [{ task_id: 't-1', task_type: 'local_agent', description: 'bg work' }],
      };
      yield {
        type: 'system',
        subtype: 'task_notification',
        task_id: 't-1',
        status: 'completed',
        output_file: '/tmp/t-1.md',
        summary: 'done',
      };
      yield { type: 'system', subtype: 'background_tasks_changed', tasks: [] };
      yield { type: 'result', subtype: 'success', session_id: 's-1', is_error: false };
      yield { type: 'system', subtype: 'session_state_changed', state: 'idle' };
      // The subprocess may linger after idle; the provider does not wait for it.
      readAfterIdle = true;
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'late' }] } };
    });

    const chunks = await chunksOf('test', '/workspace');

    // The background snapshot announces the task; its notification reports the end.
    expect(chunks.map(c => c.type)).toEqual([
      'state_update',
      'result',
      'subtask',
      'subtask',
      'result',
      'settled',
    ]);
    expect(readAfterIdle).toBe(false);
    // The CLI emits its session-state events only when asked.
    expect(sdkOptions().env?.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS).toBe('1');
  });

  test('an idle session before any result does not settle the turn', async () => {
    sdkYields(
      { type: 'system', subtype: 'session_state_changed', state: 'idle' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'answer' }] } },
      { type: 'result', subtype: 'success', session_id: 's-1', is_error: false }
    );

    const chunks = await chunksOf('test', '/workspace');
    expect(chunks.map(c => c.type)).toEqual(['agent_message_chunk', 'result', 'settled']);
  });

  test('wake turns can start more work before the final idle', async () => {
    mockQuery.mockImplementation(async function* () {
      for (let i = 0; i < 3; i++) {
        const taskId = `task-${String(i)}`;
        yield { type: 'system', subtype: 'session_state_changed', state: 'running' };
        yield {
          type: 'system',
          subtype: 'background_tasks_changed',
          tasks: [{ task_id: taskId, task_type: 'local_agent', description: taskId }],
        };
        yield { type: 'result', subtype: 'success', session_id: 's', result: taskId };
        yield { type: 'system', subtype: 'session_state_changed', state: 'idle' };
        yield { type: 'system', subtype: 'background_tasks_changed', tasks: [] };
        yield {
          type: 'system',
          subtype: 'task_notification',
          task_id: taskId,
          status: 'completed',
        };
      }
      yield { type: 'system', subtype: 'session_state_changed', state: 'running' };
      yield { type: 'result', subtype: 'success', session_id: 's', result: 'final' };
      yield { type: 'system', subtype: 'session_state_changed', state: 'idle' };
    });
    const chunks = await chunksOf('test', '/workspace');
    expect(chunks.filter(chunk => chunk.type === 'result').map(chunk => chunk.text)).toEqual([
      'task-0',
      'task-1',
      'task-2',
      'final',
    ]);
    expect(chunks.at(-1)).toEqual({ type: 'settled' });
  });

  test('a task announced before its background snapshot still requires the final idle', async () => {
    sdkYields(
      { type: 'system', subtype: 'task_started', task_id: 't' },
      {
        type: 'system',
        subtype: 'background_tasks_changed',
        tasks: [{ task_id: 't', task_type: 'local_bash', description: 'work' }],
      },
      { type: 'result', subtype: 'success', session_id: 's' },
      { type: 'system', subtype: 'session_state_changed', state: 'idle' },
      { type: 'system', subtype: 'background_tasks_changed', tasks: [] },
      { type: 'system', subtype: 'task_notification', task_id: 't', status: 'completed' }
    );
    const chunks = await chunksOf('test', '/workspace');
    expect(chunks.some(chunk => chunk.type === 'settled')).toBe(false);
    expect(chunks.flatMap(chunk => (chunk.type === 'subtask' ? [chunk.status] : []))).toEqual([
      'started',
      'completed',
    ]);
  });

  for (const subtype of ['task_started', 'task_progress']) {
    for (const finalIdle of [false, true]) {
      test(`direct ${subtype} requires a later idle after completion (final idle: ${String(finalIdle)})`, async () => {
        const finalTurn = [
          { type: 'system', subtype: 'session_state_changed', state: 'running' },
          { type: 'result', subtype: 'success', session_id: 's', result: 'final' },
          { type: 'system', subtype: 'session_state_changed', state: 'idle' },
        ];
        sdkYields(
          { type: 'system', subtype, task_id: 'direct' },
          { type: 'result', subtype: 'success', session_id: 's', result: 'first' },
          { type: 'system', subtype: 'session_state_changed', state: 'idle' },
          { type: 'system', subtype: 'task_notification', task_id: 'direct', status: 'completed' },
          ...(finalIdle ? finalTurn : [])
        );
        const chunks = await chunksOf('test', '/workspace');
        expect(chunks.some(chunk => chunk.type === 'settled')).toBe(finalIdle);
        expect(chunks.filter(chunk => chunk.type === 'result').at(-1)?.text).toBe(
          finalIdle ? 'final' : 'first'
        );
      });
    }
  }

  test('lost observation leaves a live task open and never settles', async () => {
    sdkYields(
      { type: 'system', subtype: 'task_started', task_id: 'live', description: 'never finished' },
      { type: 'result', subtype: 'success', session_id: 's', result: 'partial' },
      { type: 'system', subtype: 'session_state_changed', state: 'idle' }
    );
    const chunks = await chunksOf('test', '/workspace');
    expect(chunks.some(chunk => chunk.type === 'settled')).toBe(false);
    expect(chunks.filter(chunk => chunk.type === 'subtask')).toEqual([
      { type: 'subtask', taskId: 'live', status: 'started', description: 'never finished' },
    ]);
  });

  test('cancelling quiet background work closes streaming input without settling or inventing a stop', async () => {
    const abort = new AbortController();
    let inputClosed = false;
    mockQuery.mockImplementation(async function* ({ prompt, options }) {
      if (typeof prompt === 'string') throw new Error('Expected streaming input');
      const input = prompt[Symbol.asyncIterator]();
      await input.next();
      const closed = input.next().then(value => {
        inputClosed = value.done === true;
      });
      yield {
        type: 'system',
        subtype: 'background_tasks_changed',
        tasks: [{ task_id: 'server', task_type: 'local_bash', description: 'dev server' }],
      };
      yield { type: 'result', subtype: 'success', session_id: 's' };
      yield { type: 'system', subtype: 'session_state_changed', state: 'idle' };
      abort.abort();
      await closed;
      expect(options?.abortController?.signal.aborted).toBe(true);
      throw new Error('aborted');
    });
    const stream = await collect(
      client.sendQuery('test', '/workspace', undefined, { abortSignal: abort.signal })
    );
    expect(stream.error?.message).toBe('Query aborted');
    expect(inputClosed).toBe(true);
    expect(stream.chunks.some(chunk => chunk.type === 'settled')).toBe(false);
    expect(stream.chunks.filter(chunk => chunk.type === 'subtask')).toHaveLength(1);
  });
});

describe('tool call closing', () => {
  const hookOptions = { signal: new AbortController().signal };

  function postToolUse(args: Parameters<MockQuery>[0]) {
    return args.options?.hooks?.PostToolUse?.[0]?.hooks?.[0];
  }

  function toolUses(...calls: [id: string, name: string][]): unknown {
    return {
      type: 'assistant',
      message: { content: calls.map(([id, name]) => ({ type: 'tool_use', id, name, input: {} })) },
    };
  }

  test('PostToolUse hooks close each call as completed, failed or cancelled', async () => {
    mockQuery.mockImplementation(async function* (args) {
      const failureHook = args.options?.hooks?.PostToolUseFailure?.[0]?.hooks?.[0];
      yield toolUses(['success-id', 'Read'], ['error-id', 'Bash'], ['interrupt-id', 'Agent']);
      await postToolUse(args)?.(
        { tool_name: 'Read', tool_use_id: 'success-id', tool_response: 'ok' } as never,
        'success-id',
        hookOptions
      );
      await failureHook?.(
        {
          tool_name: 'Bash',
          tool_use_id: 'error-id',
          error: 'exit 1',
          is_interrupt: false,
        } as never,
        'error-id',
        hookOptions
      );
      await failureHook?.(
        {
          tool_name: 'Agent',
          tool_use_id: 'interrupt-id',
          error: 'stopped',
          is_interrupt: true,
        } as never,
        'interrupt-id',
        hookOptions
      );
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } };
    });

    const chunks = await chunksOf('test', '/workspace');

    // The provider's own updates, so the stream's end has nothing left to cancel.
    expect(chunks.filter(chunk => chunk.type === 'tool_call_update')).toEqual([
      { type: 'tool_call_update', toolCallId: 'success-id', status: 'completed', output: 'ok' },
      { type: 'tool_call_update', toolCallId: 'error-id', status: 'failed', output: 'exit 1' },
      {
        type: 'tool_call_update',
        toolCallId: 'interrupt-id',
        status: 'cancelled',
        output: 'stopped',
      },
    ]);
  });

  test('PostToolUse caps long tool output and marks it truncated', async () => {
    mockQuery.mockImplementation(async function* (args) {
      yield toolUses(['big-id', 'Read']);
      await postToolUse(args)?.(
        {
          tool_name: 'Read',
          tool_use_id: 'big-id',
          tool_response: 'x'.repeat(TOOL_OUTPUT_MAX_CHARS + 10),
        } as never,
        'big-id',
        hookOptions
      );
    });

    const chunks = await chunksOf('test', '/workspace');

    expect(chunks.filter(chunk => chunk.type === 'tool_call_update')).toEqual([
      {
        type: 'tool_call_update',
        toolCallId: 'big-id',
        status: 'completed',
        output: 'x'.repeat(TOOL_OUTPUT_MAX_CHARS),
        outputTruncated: true,
      },
    ]);
  });

  test('terminal tool result queue drain preserves hook outcome', async () => {
    mockQuery.mockImplementation(async function* (args) {
      yield toolUses(['late-id', 'Read']);
      await postToolUse(args)?.(
        { tool_name: 'Read', tool_use_id: 'late-id', tool_response: 'ok' } as never,
        'late-id',
        hookOptions
      );
    });

    expect(await chunksOf('test', '/workspace')).toContainEqual({
      type: 'tool_call_update',
      toolCallId: 'late-id',
      status: 'completed',
      output: 'ok',
    });
  });

  test('a tool call no hook reports closes from its tool_result block', async () => {
    sdkYields(
      toolUses(['denied-id', 'Bash']),
      {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'denied-id',
              is_error: true,
              content: [{ type: 'text', text: 'Permission denied' }],
            },
          ],
        },
      },
      { type: 'result', subtype: 'success', is_error: false, session_id: 's' }
    );

    const chunks = await chunksOf('test', '/workspace');

    expect(chunks.filter(chunk => chunk.type === 'tool_call_update')).toEqual([
      {
        type: 'tool_call_update',
        toolCallId: 'denied-id',
        status: 'failed',
        output: 'Permission denied',
      },
    ]);
    expect(chunks.findIndex(chunk => chunk.type === 'tool_call_update')).toBeLessThan(
      chunks.findIndex(chunk => chunk.type === 'result')
    );
  });

  test('a hook result closes its call once, and the later tool_result block is ignored', async () => {
    mockQuery.mockImplementation(async function* (args) {
      yield toolUses(['read-id', 'Read']);
      await postToolUse(args)?.(
        { tool_name: 'Read', tool_use_id: 'read-id', tool_response: 'file body' } as never,
        'read-id',
        hookOptions
      );
      // A hook result for a call this stream never started is not a tool call of this turn.
      await postToolUse(args)?.(
        { tool_name: 'Read', tool_use_id: 'stray-id', tool_response: 'x' } as never,
        'stray-id',
        hookOptions
      );
      yield {
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'read-id', content: 'file body' }],
        },
      };
      yield { type: 'result', subtype: 'success', is_error: false, session_id: 's' };
    });

    const chunks = await chunksOf('test', '/workspace');

    expect(chunks.filter(chunk => chunk.type === 'tool_call_update')).toEqual([
      { type: 'tool_call_update', toolCallId: 'read-id', status: 'completed', output: 'file body' },
    ]);
  });

  test('PostToolUse hook handles circular reference without crashing', async () => {
    mockQuery.mockImplementation(async function* (args) {
      const circular: Record<string, unknown> = { key: 'val' };
      circular.self = circular;
      await postToolUse(args)?.(
        { tool_name: 'TestTool', tool_use_id: 'tc-circ', tool_response: circular } as never,
        'tc-circ',
        hookOptions
      );
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } };
    });

    const chunks = await chunksOf('test', '/workspace');

    expect(chunks.some(c => c.type === 'agent_message_chunk')).toBe(true);
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'claude.post_tool_use_hook_error'
    );
  });
});

describe('result', () => {
  test('yields result event with session ID', async () => {
    const chunks = await streamOf({
      type: 'result',
      session_id: 'session-123-abc',
      usage: {
        input_tokens: 20,
        output_tokens: 5,
        cache_read_input_tokens: 70,
        cache_creation_input_tokens: 10,
      },
    });

    expect(chunks).toEqual([
      {
        type: 'result',
        sessionId: 'session-123-abc',
        tokens: { input: 100, output: 5, cacheRead: 70, cacheWrite: 10 },
      },
    ]);
  });

  test.each(['forked-skill', 'subagent', 'no-handoff'])(
    'includes every model’s tokens (%s)',
    async scenario => {
      const subagent = scenario === 'subagent';
      const tokens = {
        input_tokens: 20,
        output_tokens: 5,
        cache_read_input_tokens: 70,
        cache_creation_input_tokens: 10,
      };
      const noTokens = {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      };
      const helper = {
        inputTokens: 30,
        outputTokens: 15,
        cacheReadInputTokens: 40,
        cacheCreationInputTokens: 20,
      };
      const chunks = await streamOf({
        type: 'result',
        session_id: 'forked-skill',
        total_cost_usd: 0.2384,
        usage: scenario === 'forked-skill' ? noTokens : tokens,
        modelUsage: {
          main: {
            inputTokens: 20,
            outputTokens: 5,
            cacheReadInputTokens: 70,
            cacheCreationInputTokens: 10,
          },
          ...(subagent ? { helper } : {}),
        },
      });
      expect(chunks.find(chunk => chunk.type === 'result')).toMatchObject({
        cost: 0.2384,
        tokens: subagent
          ? { input: 190, output: 20, cacheRead: 110, cacheWrite: 30 }
          : { input: 100, output: 5, cacheRead: 70, cacheWrite: 10 },
      });
    }
  );

  test('marks a later unknown token interval after a known result', async () => {
    sdkYields(
      ...[
        [0.1, 100],
        [0.3, 50],
        [0.4, 60],
      ].map(([cost, input]) => ({
        type: 'result',
        session_id: 'reset-totals',
        total_cost_usd: cost,
        modelUsage: {
          main: {
            inputTokens: input,
            outputTokens: 20,
            cacheReadInputTokens: 30,
            cacheCreationInputTokens: 40,
          },
        },
      }))
    );
    const results = (await chunksOf('test', '/workspace')).filter(chunk => chunk.type === 'result');
    expect(results).toHaveLength(3);
    expect(results[0]).toMatchObject({
      tokens: { input: 170, output: 20, cacheRead: 30, cacheWrite: 40 },
      cost: 0.1,
    });
    expect(results[0]).not.toHaveProperty('tokensUnknown');
    for (const result of results.slice(1)) {
      expect(result).not.toHaveProperty('tokens');
      expect(result).toMatchObject({ tokensUnknown: true });
    }
    expect(results[1]).toMatchObject({ cost: expect.closeTo(0.2, 10) });
    expect(results[2]).toMatchObject({ cost: expect.closeTo(0.1, 10) });
    expect(
      mockLogger.warn.mock.calls.filter(call => call[1] === 'claude.query_tokens_unknown')
    ).toHaveLength(2);
  });

  test('yields result with structuredOutput when SDK result has structured_output', async () => {
    const chunks = await streamOf({
      type: 'result',
      session_id: 'sid-structured',
      structured_output: { type: 'BUG', severity: 'high' },
    });

    expect(chunks).toEqual([
      {
        type: 'result',
        sessionId: 'sid-structured',
        tokensUnknown: true,
        structuredOutput: { type: 'BUG', severity: 'high' },
      },
    ]);
  });

  test('yields result with cost, stopReason, numTurns, and a resolved model when SDK provides them', async () => {
    const chunks = await streamOf({
      type: 'result',
      session_id: 'sid-cost',
      total_cost_usd: 0.0042,
      stop_reason: 'end_turn',
      num_turns: 3,
      modelUsage: {
        'claude-sonnet-4-6': {
          inputTokens: 100,
          outputTokens: 50,
          cacheReadInputTokens: 10,
          cacheCreationInputTokens: 0,
        },
      },
    });

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({
      type: 'result',
      sessionId: 'sid-cost',
      cost: 0.0042,
      stopReason: 'end_turn',
      numTurns: 3,
      resolvedModel: { id: 'claude-sonnet-4-6' },
    });
    // Single-model usage is unambiguous — no ambiguity warning.
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  test('fresh cost and model remain available when SDK model output counts are absent', async () => {
    const chunks = await streamOf({
      type: 'result',
      session_id: 'spend-missing-output',
      total_cost_usd: 0.25,
      modelUsage: { 'claude-sonnet-4-6': {} },
    });
    expect(chunks[0]).toMatchObject({ cost: 0.25, resolvedModel: { id: 'claude-sonnet-4-6' } });
  });

  test('picks the greatest-output-token model and warns when modelUsage has multiple keys', async () => {
    // A subagent pinned via `agents:` (or a fallbackModel takeover) puts more
    // than one model in the record, and key order carries no guarantee — the
    // main model here is deliberately NOT first.
    const chunks = await streamOf({
      type: 'result',
      session_id: 'sid-multi-model',
      modelUsage: {
        'claude-haiku-4-5-20251001': {
          inputTokens: 400,
          outputTokens: 20,
          cacheReadInputTokens: 0,
        },
        'claude-sonnet-5': { inputTokens: 120, outputTokens: 900, cacheReadInputTokens: 10 },
      },
    });

    expect(chunks[0]).toMatchObject({ resolvedModel: { id: 'claude-sonnet-5' } });
    expect(mockLogger.warn).toHaveBeenCalledWith(
      { models: ['claude-haiku-4-5-20251001', 'claude-sonnet-5'], selected: 'claude-sonnet-5' },
      'claude.resolved_model_ambiguous'
    );
  });

  test('omits resolvedModel when modelUsage is an empty record', async () => {
    const chunks = await streamOf({
      type: 'result',
      session_id: 'sid-empty-usage',
      modelUsage: {},
    });

    expect(chunks[0]).not.toHaveProperty('resolvedModel');
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  test('omits cost, stopReason, numTurns, resolvedModel and structuredOutput when SDK result has none', async () => {
    const chunks = await streamOf({ type: 'result', session_id: 'sid-bare' });

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ type: 'result', sessionId: 'sid-bare' });
    for (const field of ['cost', 'stopReason', 'numTurns', 'resolvedModel', 'structuredOutput']) {
      expect(chunks[0]).not.toHaveProperty(field);
    }
  });

  test.each<[string, string | null, ProviderStopReason | undefined]>([
    ['success', 'end_turn', 'end_turn'],
    ['success', 'stop_sequence', 'end_turn'],
    ['success', 'max_tokens', 'max_tokens'],
    ['success', 'refusal', 'refusal'],
    ['error_max_turns', 'tool_use', 'max_turn_requests'],
    ['success', 'pause_turn', undefined],
    ['success', null, undefined],
  ])(
    'maps subtype %s with stop_reason %s to the stop reason %s',
    async (subtype, stopReason, expected) => {
      sdkYields({ type: 'result', subtype, session_id: 'sid', stop_reason: stopReason });

      const results = (await chunksOf('test', '/workspace')).filter(c => c.type === 'result');

      expect(results).toHaveLength(1);
      expect(results[0].stopReason).toBe(expected);
      if (expected === undefined) expect(results[0]).not.toHaveProperty('stopReason');
    }
  );

  test('a resume passes resume to the SDK and marks the result resumed (resume-or-error)', async () => {
    sdkYields({ type: 'result', session_id: 'resumed-sid' });

    const chunks = await chunksOf('prompt', '/workspace', 'session-to-resume');

    expect(sdkOptions()).toMatchObject({ cwd: '/workspace', resume: 'session-to-resume' });
    expect(chunks.find(c => c.type === 'result')).toMatchObject({ resumed: true });
  });

  test('result chunk omits resumed when no resumeSessionId', async () => {
    sdkYields({ type: 'result', session_id: 'fresh-sid' });

    const result = (await chunksOf('prompt', '/workspace')).find(c => c.type === 'result');

    expect(result).toBeDefined();
    // Contract is "omitted when no resume was requested", not "present-but-undefined".
    expect(result).not.toHaveProperty('resumed');
  });

  test('logs a failed result at error level', async () => {
    const chunks = await streamOf({
      type: 'result',
      session_id: 'sid-err',
      is_error: true,
      subtype: 'max_turns',
    });

    expect(chunks[0]).toMatchObject({
      type: 'result',
      isError: true,
      errorSubtype: 'max_turns',
      failure: { class: 'unknown', evidence: 'max_turns' },
    });
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ sessionIdPreview: 'sid-err', errorSubtype: 'max_turns' }),
      'claude.result_failed'
    );
  });

  test('#1425 treats is_error: true + subtype: success as clean success (stop_sequence)', async () => {
    // Claude Agent SDK's SDKResultSuccess types is_error as boolean (not literal
    // false). When a model is configured with stop sequences (e.g. via output_format /
    // json_schema enforcement) the SDK reports is_error: true alongside subtype:
    // 'success' and stop_reason: 'stop_sequence' — its way of signalling "non-default
    // termination, but not a failure". Text about errors from a real model stays output.
    const chunks = await streamOf(
      {
        type: 'assistant',
        message: {
          model: 'claude-sonnet-4-5',
          content: [{ type: 'text', text: 'Rate limit guidance: back off exponentially.' }],
        },
        session_id: 'sid-stop-seq',
      },
      {
        type: 'result',
        session_id: 'sid-stop-seq',
        is_error: true,
        subtype: 'success',
        stop_reason: 'stop_sequence',
      }
    );

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toEqual({
      type: 'agent_message_chunk',
      text: 'Rate limit guidance: back off exponentially.',
    });
    expect(chunks[1]).toMatchObject({
      type: 'result',
      sessionId: 'sid-stop-seq',
      stopReason: 'end_turn',
    });
    for (const field of ['isError', 'errorSubtype', 'errors', 'failure']) {
      expect(chunks[1]).not.toHaveProperty(field);
    }
    expect(mockLogger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ sessionIdPreview: 'sid-stop', stopReason: 'stop_sequence' }),
      'claude.result_success_validated'
    );
  });
});

describe('cost of a resumed or forked session is the query’s own spend', () => {
  // Totals recorded from real haiku runs on SDK 0.3.282, whose resumed and forked
  // sessions report total_cost_usd and modelUsage cumulatively.
  let configRoot: string;
  beforeEach(() => {
    configRoot = tempRoots(mkdtempSync(join(tmpdir(), 'claude-spend-')));
    mkdirSync(join(configRoot, 'projects', 'arbitrary-slug'), { recursive: true });
  });
  function persist<
    T extends {
      session_id: string;
      total_cost_usd: number;
      modelUsage: Record<string, unknown>;
    },
  >(result: T): T {
    writeFileSync(
      join(configRoot, 'projects', 'arbitrary-slug', result.session_id + '.jsonl'),
      JSON.stringify({
        type: 'cost-state',
        sessionId: result.session_id,
        totalCostUSD: result.total_cost_usd,
        modelUsage: result.modelUsage,
      }) + '\n'
    );
    return result;
  }
  const haiku = (costUSD: number, outputTokens: number): Record<string, unknown> => ({
    'claude-haiku-4-5-20251001': { inputTokens: 900, outputTokens, costUSD },
  });
  /** Makes the next query yield `result`, persisting it as the SDK would. */
  function yieldsPersisted(result: {
    session_id: string;
    total_cost_usd: number;
    modelUsage: Record<string, unknown>;
  }): void {
    mockQuery.mockImplementationOnce(async function* () {
      yield persist({ type: 'result', ...result });
    });
  }
  function resultFor(sessionId: string, total: number, outputTokens: number): void {
    yieldsPersisted({
      session_id: sessionId,
      total_cost_usd: total,
      modelUsage: haiku(total, outputTokens),
    });
  }
  /** The results of one query against this test's config root. */
  async function resultsOf(
    resumeSessionId?: string,
    options?: { forkSession: boolean }
  ): Promise<Extract<MessageChunk, { type: 'result' }>[]> {
    const chunks = await chunksOf('test', '/workspace', resumeSessionId, {
      ...options,
      env: { CLAUDE_CONFIG_DIR: configRoot },
    });
    return chunks.filter(chunk => chunk.type === 'result');
  }
  async function costOf(
    resumeSessionId?: string,
    options?: { forkSession: boolean }
  ): Promise<number | undefined> {
    return (await resultsOf(resumeSessionId, options)).at(-1)?.cost;
  }
  const tokensUnknownWarnings = (): number =>
    mockLogger.warn.mock.calls.filter(call => call[1] === 'claude.query_tokens_unknown').length;

  test.each([false, true])(
    'differences all token axes for resumes and forks (fork=%s)',
    async forkSession => {
      const sessionId = '10000000-0000-4000-8000-000000000097';
      persist({
        session_id: sessionId,
        total_cost_usd: 0.1,
        modelUsage: {
          main: {
            inputTokens: 100,
            outputTokens: 200,
            cacheReadInputTokens: 300,
            cacheCreationInputTokens: 400,
          },
        },
      });
      sdkYields({
        type: 'result',
        session_id: sessionId,
        total_cost_usd: 0.3,
        usage: { input_tokens: 1, output_tokens: 2 },
        modelUsage: {
          main: {
            inputTokens: 110,
            outputTokens: 220,
            cacheReadInputTokens: 330,
            cacheCreationInputTokens: 440,
          },
          helper: {
            inputTokens: 5,
            outputTokens: 0,
            cacheReadInputTokens: 6,
            cacheCreationInputTokens: 7,
          },
        },
      });
      expect((await resultsOf(sessionId, { forkSession }))[0]).toMatchObject({
        cost: expect.closeTo(0.2, 10),
        tokens: { input: 98, output: 20, cacheRead: 36, cacheWrite: 47 },
        resolvedModel: { id: 'main' },
      });
    }
  );

  test('per-query cost and tokens over one session sum to the SDK session total', async () => {
    const sessionId = '10000000-0000-4000-8000-000000000094';
    const cumulative = [
      { total: 0.030896, input: 900, output: 60, cacheRead: 2700, cacheWrite: 1500 },
      { total: 0.0356233, input: 1800, output: 120, cacheRead: 5400, cacheWrite: 2900 },
      { total: 0.05, input: 2700, output: 180, cacheRead: 8200, cacheWrite: 4400 },
    ];
    for (const step of cumulative) {
      yieldsPersisted({
        session_id: sessionId,
        total_cost_usd: step.total,
        modelUsage: {
          'claude-haiku-4-5-20251001': {
            inputTokens: step.input,
            outputTokens: step.output,
            cacheReadInputTokens: step.cacheRead,
            cacheCreationInputTokens: step.cacheWrite,
          },
        },
      });
    }
    const results = [
      ...(await resultsOf()),
      ...(await resultsOf(sessionId)),
      ...(await resultsOf(sessionId)),
    ];

    const final = cumulative[2];
    let cost = 0;
    let input = 0;
    let output = 0;
    for (const result of results) {
      if (result.tokens === undefined) throw new Error('every query must report cost and tokens');
      cost += result.cost ?? Number.NaN;
      input += result.tokens.input;
      output += result.tokens.output;
    }
    expect(results).toHaveLength(3);
    expect(cost).toBeCloseTo(final.total, 10);
    expect(input).toBe(final.input + final.cacheRead + final.cacheWrite);
    expect(output).toBe(final.output);
  });

  test.each(['legacy', 'backwards', 'missing-model', 'empty'])(
    'incomplete or inconsistent token baseline omits tokens (%s)',
    async scenario => {
      const sessionId = '10000000-0000-4000-8000-000000000096';
      const baseline = {
        inputTokens: 100,
        outputTokens: 10,
        cacheReadInputTokens: 30,
        cacheCreationInputTokens: 40,
      };
      const baselineUsage: Record<string, Record<string, unknown>> = {
        legacy: { main: { outputTokens: 10 } },
        empty: {},
      };
      persist({
        session_id: sessionId,
        total_cost_usd: 0.1,
        modelUsage: baselineUsage[scenario] ?? { main: baseline },
      });
      const current = {
        inputTokens: 110,
        outputTokens: 20,
        cacheReadInputTokens: scenario === 'backwards' ? 20 : 35,
        cacheCreationInputTokens: 45,
      };
      sdkYields({
        type: 'result',
        session_id: sessionId,
        total_cost_usd: 0.3,
        modelUsage: scenario === 'missing-model' ? {} : { main: current },
      });
      const result = (await resultsOf(sessionId))[0];
      expect(result).not.toHaveProperty('tokens');
      expect(result).toMatchObject({ cost: expect.closeTo(0.2, 10) });
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ baseline: 'known' }),
        'claude.query_tokens_unknown'
      );
      if (scenario !== 'missing-model')
        expect(result).toMatchObject({ resolvedModel: { id: 'main' } });
    }
  );

  test.each(['missing', 'legacy', 'empty'])(
    'keeps tokens unknown across later results (%s baseline)',
    async scenario => {
      const sessionId = '10000000-0000-4000-8000-000000000095';
      if (scenario !== 'missing')
        persist({
          session_id: sessionId,
          total_cost_usd: 0.1,
          modelUsage: scenario === 'empty' ? {} : { main: { outputTokens: 10 } },
        });
      sdkYields(
        ...[
          { cost: 0.3, increment: 0 },
          { cost: 0.5, increment: 10 },
        ].map(({ cost, increment }) => ({
          type: 'result',
          session_id: sessionId,
          total_cost_usd: cost,
          modelUsage: {
            main: {
              inputTokens: 100 + increment,
              outputTokens: 20 + increment,
              cacheReadInputTokens: 30 + increment,
              cacheCreationInputTokens: 40 + increment,
            },
          },
        }))
      );
      const results = await resultsOf(sessionId);
      expect(results).toHaveLength(2);
      for (const result of results) expect(result).not.toHaveProperty('tokens');
      if (scenario === 'missing') expect(results[0]).not.toHaveProperty('cost');
      else expect(results[0]).toMatchObject({ cost: expect.closeTo(0.2, 10) });
      expect(results[1]).toMatchObject({ cost: expect.closeTo(0.2, 10) });
      expect(tokensUnknownWarnings()).toBe(2);
    }
  );

  test('unknown baseline omits tokens even when main-agent usage is available', async () => {
    sdkYields({
      type: 'result',
      session_id: '20000000-0000-4000-8000-000000000097',
      total_cost_usd: 0.3,
      usage: { input_tokens: 1, output_tokens: 2 },
      modelUsage: {
        main: {
          inputTokens: 110,
          outputTokens: 220,
          cacheReadInputTokens: 330,
          cacheCreationInputTokens: 440,
        },
      },
    });
    expect((await resultsOf('20000000-0000-4000-8000-000000000097'))[0]).not.toHaveProperty(
      'tokens'
    );
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ baseline: 'unknown' }),
      'claude.query_tokens_unknown'
    );
  });

  test('snapshots request-scoped state before eager SDK startup changes it', async () => {
    const sessionId = '10000000-0000-4000-8000-000000000099';
    persist({ session_id: sessionId, total_cost_usd: 0.1, modelUsage: haiku(0.1, 10) });
    const previous = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = join(configRoot, 'ambient-canary');
    // Persists at query() time, before the stream is read.
    mockQuery.mockImplementationOnce(() => {
      const result = persist({
        type: 'result',
        session_id: sessionId,
        total_cost_usd: 0.3,
        modelUsage: haiku(0.3, 30),
      });
      return (async function* () {
        yield result;
      })();
    });
    try {
      expect(await costOf(sessionId)).toBeCloseTo(0.2, 10);
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previous;
    }
  });

  test.each([false, true])(
    'request home supplies the in-process baseline (fork=%s)',
    async forkSession => {
      const home = configRoot;
      configRoot = join(home, '.claude');
      mkdirSync(join(configRoot, 'projects', 'arbitrary-slug'), { recursive: true });
      const sessionId = '10000000-0000-4000-8000-000000000098';
      persist({ session_id: sessionId, total_cost_usd: 0.1, modelUsage: haiku(0.1, 10) });
      resultFor(sessionId, 0.3, 30);
      const homeKey = process.platform === 'win32' ? 'USERPROFILE' : 'HOME';
      const previous = process.env.CLAUDE_CONFIG_DIR;
      delete process.env.CLAUDE_CONFIG_DIR;
      try {
        const results = (
          await chunksOf('test', '/workspace', sessionId, { forkSession, env: { [homeKey]: home } })
        ).filter(chunk => chunk.type === 'result');
        expect(results[0]?.cost).toBeCloseTo(0.2, 10);
        expect(results[0]?.resolvedModel?.id).toBe('claude-haiku-4-5-20251001');
        expect(sdkOptions().env).toMatchObject({ [homeKey]: home });
      } finally {
        if (previous !== undefined) process.env.CLAUDE_CONFIG_DIR = previous;
      }
    }
  );

  test('a resumed turn reports what it spent, not the session total', async () => {
    resultFor('10000000-0000-4000-8000-000000000001', 0.030896, 55);
    expect(await costOf()).toBe(0.030896);

    resultFor('10000000-0000-4000-8000-000000000001', 0.0356233, 103);
    expect(await costOf('10000000-0000-4000-8000-000000000001')).toBeCloseTo(0.0047273, 10);
  });

  test('a fork reports its own spend, differenced against the source session', async () => {
    resultFor('10000000-0000-4000-8000-000000000002', 0.0356233, 103);
    await costOf();

    resultFor('10000000-0000-4000-8000-000000000003', 0.0421297, 151);
    expect(await costOf('10000000-0000-4000-8000-000000000002', { forkSession: true })).toBeCloseTo(
      0.0065064,
      10
    );

    // The fork's own totals become the baseline for resuming it.
    resultFor('10000000-0000-4000-8000-000000000003', 0.05, 180);
    expect(await costOf('10000000-0000-4000-8000-000000000003')).toBeCloseTo(0.0078703, 10);
  });

  test('resuming without a persisted baseline reports cost as unknown', async () => {
    // Created by an earlier process: its total includes turns this node did not run.
    resultFor('20000000-0000-4000-8000-000000000001', 0.0356233, 103);
    expect(await costOf('20000000-0000-4000-8000-000000000001')).toBeUndefined();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      { sessionIdPreview: '20000000', baseline: 'unknown' },
      'claude.query_cost_unknown'
    );
  });

  test('the resolved model is the one this query used, not the session’s busiest', async () => {
    const sessionId = '10000000-0000-4000-8000-000000000004';
    const opus = { 'claude-opus-5-5': { outputTokens: 4000, costUSD: 0.5 } };
    yieldsPersisted({ session_id: sessionId, total_cost_usd: 0.5, modelUsage: opus });
    await costOf();
    yieldsPersisted({
      session_id: sessionId,
      total_cost_usd: 0.51,
      modelUsage: { ...opus, 'claude-haiku-4-5-20251001': { outputTokens: 60, costUSD: 0.01 } },
    });

    expect((await resultsOf(sessionId)).at(-1)?.resolvedModel?.id).toBe(
      'claude-haiku-4-5-20251001'
    );
  });

  test('a resumed query with no new output names no model from earlier turns', async () => {
    // A crash or startup-error result can carry the session's totals unchanged.
    const totals = {
      session_id: '10000000-0000-4000-8000-000000000005',
      total_cost_usd: 0.6,
      modelUsage: {
        'claude-opus-5-5': { outputTokens: 5000, costUSD: 0.5 },
        'claude-haiku-4-5-20251001': { outputTokens: 100, costUSD: 0.1 },
      },
    };
    yieldsPersisted(totals);
    await costOf();
    yieldsPersisted(totals);

    const results = await resultsOf(totals.session_id);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ cost: 0 });
    expect(results[0]).not.toHaveProperty('resolvedModel');
  });

  test('without a baseline, a multi-model session names no model', async () => {
    yieldsPersisted({
      session_id: '20000000-0000-4000-8000-000000000002',
      total_cost_usd: 0.6,
      modelUsage: {
        'claude-opus-5-5': { outputTokens: 5000, costUSD: 0.5 },
        'claude-haiku-4-5-20251001': { outputTokens: 100, costUSD: 0.1 },
      },
    });

    const results = await resultsOf('20000000-0000-4000-8000-000000000002');
    expect(results[0]).not.toHaveProperty('resolvedModel');
    expect(results[0]).not.toHaveProperty('cost');
  });

  test('a total below the baseline reports cost as unknown', async () => {
    resultFor('10000000-0000-4000-8000-000000000006', 0.03, 50);
    await costOf();

    resultFor('10000000-0000-4000-8000-000000000006', 0.004, 20);
    expect(await costOf('10000000-0000-4000-8000-000000000006')).toBeUndefined();
  });
});

describe('SDK options', () => {
  test('passes request options through to the SDK', async () => {
    const sandbox = { enabled: true, network: { allowedDomains: [] } };
    const options = await optionsFor(
      {
        model: 'sonnet',
        maxBudgetUsd: 5.0,
        fallbackModel: 'claude-haiku-4-5',
        nodeConfig: { betas: ['context-1m-2025-08-07'], sandbox },
      },
      undefined,
      '/my/workspace'
    );

    expect(mockQuery.mock.calls[0][0].prompt).toEqual(expect.any(Object));
    expect(options).toMatchObject({
      cwd: '/my/workspace',
      model: 'sonnet',
      permissionMode: 'bypassPermissions',
      maxBudgetUsd: 5.0,
      fallbackModel: 'claude-haiku-4-5',
      betas: ['context-1m-2025-08-07'],
      sandbox,
    });
  });

  test('enables agentProgressSummaries by default for workflow nodes', async () => {
    expect(await optionsFor({ nodeConfig: { nodeId: 'plan' } })).toMatchObject({
      agentProgressSummaries: true,
    });
  });

  test('respects explicit agentProgressSummaries: false override', async () => {
    expect(
      await optionsFor({ nodeConfig: { nodeId: 'plan', agentProgressSummaries: false } })
    ).toMatchObject({ agentProgressSummaries: false });
  });

  test('does not set agentProgressSummaries for direct chat (no nodeConfig)', async () => {
    // The opt-in is for workflow nodes only; direct chat keeps the SDK default.
    expect(await optionsFor()).not.toHaveProperty('agentProgressSummaries');
  });

  test.each<[string, RequestOptions, Options['settingSources']]>([
    ['default to project + user', {}, ['project', 'user']],
    // A project-only config must NOT be silently widened to the default; that would
    // expand skill/command/agent scope for every project-only deployment.
    ['assistant project-only', { assistantConfig: { settingSources: ['project'] } }, ['project']],
    ['assistant empty', { assistantConfig: { settingSources: [] } }, []],
    [
      'node over assistant',
      {
        nodeConfig: { settingSources: ['project'] },
        assistantConfig: { settingSources: ['project', 'user'] },
      },
      ['project'],
    ],
    // An explicit empty array opts out of ALL setting sources.
    ['node empty, no assistant default', { nodeConfig: { settingSources: [] } }, []],
  ])('settingSources: %s', async (_label, request, expected) => {
    expect((await optionsFor(request)).settingSources).toEqual(expected);
  });

  test.each<[string, RequestOptions, string | undefined, Options['systemPrompt']]>([
    [
      'the claude_code preset by default',
      {},
      undefined,
      { type: 'preset', preset: 'claude_code', snapshot: false },
    ],
    [
      'a request systemPrompt over the preset',
      { systemPrompt: 'You are a security reviewer' },
      undefined,
      { type: 'custom', prompt: 'You are a security reviewer', snapshot: false },
    ],
    [
      'a request systemPrompt replacing the preset and its append',
      { systemPrompt: 'You are a reviewer', appendSystemPrompt: 'Workflows now: a, b' },
      undefined,
      { type: 'custom', prompt: 'You are a reviewer', snapshot: false },
    ],
    // SDK >= 0.3.267 records the system prompt and re-sends the record on resume
    // unless snapshot is false. A node that resumes another node's session, and a
    // chat turn whose append lists current workflows, must reach the model as sent.
    [
      'the preset with this request’s append on resume',
      { appendSystemPrompt: 'Workflows now: a, b', nodeConfig: {} },
      'earlier-session',
      { type: 'preset', preset: 'claude_code', append: 'Workflows now: a, b', snapshot: false },
    ],
  ])('system prompt: %s', async (_label, request, resume, expected) => {
    const options = await optionsFor(request, resume);
    expect(options.resume).toBe(resume);
    expect(options.systemPrompt).toEqual(expected);
  });

  test('omits effort from SDK when not provided in nodeConfig', async () => {
    expect(await optionsFor()).not.toHaveProperty('effort');
  });

  // #2556: Archon's ladder is the union of every provider's vocabulary, so a
  // Claude node can ask for every shared rung; values outside the SDK's slice
  // land on its nearest endpoint.
  test.each([
    ['high', 'high'],
    ['xhigh', 'xhigh'],
    ['minimal', 'low'],
    ['max', 'max'],
    ['ultra', 'max'],
    ['persistent', 'max'],
  ] as const)('effort %s reaches the SDK as %s', async (declared, applied) => {
    expect((await optionsFor({ nodeConfig: { effort: declared } })).effort).toBe(applied);
  });
});

describe('subprocess environment and binary', () => {
  test('subprocess env passes through all process.env keys (no allowlist filtering)', async () => {
    const originalKey = process.env.CUSTOM_USER_KEY;
    process.env.CUSTOM_USER_KEY = 'user-trusted-value';
    try {
      const options = await optionsFor();
      const env = options.env ?? {};
      // executableArgs is omitted when cliPath is undefined (dev mode, SDK
      // 0.2.x resolves a native binary).
      expect(options.executableArgs).toBeUndefined();
      expect(env.CUSTOM_USER_KEY).toBe('user-trusted-value');
      // Windows uses "Path" casing in spread objects and USERPROFILE instead of HOME
      expect(env.PATH ?? env.Path).toBe(process.env.PATH ?? process.env.Path);
      expect(env.HOME ?? env.USERPROFILE).toBe(process.env.HOME ?? process.env.USERPROFILE);
    } finally {
      if (originalKey !== undefined) process.env.CUSTOM_USER_KEY = originalKey;
      else delete process.env.CUSTOM_USER_KEY;
    }
  });

  test("a run's identity in the request env reaches the Claude Code process the agent's shell runs in", async () => {
    const identity = {
      WORKFLOW_ID: 'run-1',
      ARCHON_NODE_EXECUTION: '{"runId":"run-1","path":"notes"}',
      ARCHON_CLI_COMMAND: '["/opt/archon/bin/archon"]',
    };

    const options = await optionsFor({ env: identity });
    expect(options.env).toMatchObject(identity);
    expect(options.settingSources).toEqual(['project', 'user']);
  });

  test('requestOptions.env overrides buildSubprocessEnv values', async () => {
    // HOME is always in process.env -- override it to verify priority
    expect((await optionsFor({ env: { HOME: '/custom/home' } })).env?.HOME).toBe('/custom/home');
  });

  describe('CLAUDE_API_KEY -> ANTHROPIC_API_KEY mapping', () => {
    const ENV_KEYS_UNDER_TEST = [
      'CLAUDE_API_KEY',
      'ANTHROPIC_API_KEY',
      'CLAUDE_CODE_OAUTH_TOKEN',
    ] as const;
    type KeyEnv = Partial<Record<(typeof ENV_KEYS_UNDER_TEST)[number], string>>;
    let savedEnv: KeyEnv;

    beforeEach(() => {
      savedEnv = {};
      for (const key of ENV_KEYS_UNDER_TEST) savedEnv[key] = process.env[key];
    });

    afterEach(() => {
      for (const key of ENV_KEYS_UNDER_TEST) {
        const value = savedEnv[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });

    test.each<[string, KeyEnv, Record<string, string> | undefined, string | undefined]>([
      ['maps when only the API key is set', { CLAUDE_API_KEY: 'sk-test' }, undefined, 'sk-test'],
      [
        'does not clobber an explicit ANTHROPIC_API_KEY',
        { CLAUDE_API_KEY: 'sk-a', ANTHROPIC_API_KEY: 'sk-b' },
        undefined,
        'sk-b',
      ],
      [
        'OAuth token wins — no injection',
        { CLAUDE_API_KEY: 'sk-a', CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-x' },
        undefined,
        undefined,
      ],
      ['no key, no injection', {}, undefined, undefined],
      [
        'requestOptions.env still wins over the mapping',
        { CLAUDE_API_KEY: 'sk-a' },
        { ANTHROPIC_API_KEY: 'sk-override' },
        'sk-override',
      ],
      // Exact shape produced by deliverCredential()'s anthropic oauth branch: the
      // delivered env carries OAuth tokens only. The mirror must not inject the
      // install key alongside the user's subscription token (the CLI would prefer
      // the API key and rebill).
      [
        'per-user subscription via requestOptions.env suppresses the mirror',
        { CLAUDE_API_KEY: 'sk-install-fallback' },
        {
          CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-user',
          ANTHROPIC_OAUTH_TOKEN: 'sk-ant-oat01-user',
        },
        undefined,
      ],
      [
        'treats an empty-string ANTHROPIC_API_KEY as missing',
        { CLAUDE_API_KEY: 'sk-test', ANTHROPIC_API_KEY: '' },
        undefined,
        'sk-test',
      ],
    ])('%s', async (_label, hostEnv, requestEnv, expected) => {
      for (const key of ENV_KEYS_UNDER_TEST) {
        const value = hostEnv[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }

      const env = (await optionsFor({ env: requestEnv })).env ?? {};

      expect(env.ANTHROPIC_API_KEY).toBe(expected);
      expect(env.CLAUDE_API_KEY).toBe(hostEnv.CLAUDE_API_KEY);
      expect(env).toMatchObject(requestEnv ?? {});
      // Only the subprocess env copy is written — never process.env itself
      expect(process.env.ANTHROPIC_API_KEY).toBe(hostEnv.ANTHROPIC_API_KEY);
    });
  });

  test('passes executableArgs: [--no-env-file] when cliPath ends in a Bun-runnable JS extension', async () => {
    const cliPath = '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js';
    const spy = spyOn(binaryResolver, 'resolveClaudeBinaryPath').mockResolvedValue(cliPath);
    try {
      const options = await optionsFor();
      expect(options.executableArgs).toEqual(['--no-env-file']);
      expect(options.pathToClaudeCodeExecutable).toBe(cliPath);
    } finally {
      spy.mockRestore();
    }
  });

  test('container run skips host binary resolution even with a configured host path', async () => {
    // A compiled binary with no host Claude makes resolution throw; a container run
    // must not call it, because Claude is baked into the runner image.
    const spy = spyOn(binaryResolver, 'resolveClaudeBinaryPath').mockRejectedValue(
      new Error('Claude Code not found — set CLAUDE_BIN_PATH')
    );
    try {
      const options = await optionsFor({
        execContext: { kind: 'container', containerId: 'c-1' },
        assistantConfig: { claudeBinaryPath: '/missing-host-claude' },
      });

      expect(spy).not.toHaveBeenCalled();
      // The placeholder prevents SDK host resolution before the hook runs.
      expect(typeof options.spawnClaudeCodeProcess).toBe('function');
      expect(options.pathToClaudeCodeExecutable).toBe('claude');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('withFirstMessageTimeout', () => {
  const { withFirstMessageTimeout } = claudeModule;

  async function* stuckGen(): AsyncGenerator<string> {
    await new Promise(() => {});
    yield 'never';
  }

  test('completes normally when first event arrives before timeout', async () => {
    async function* fastGen(): AsyncGenerator<string> {
      yield 'hello';
      yield 'world';
    }
    const gen = withFirstMessageTimeout(fastGen(), new AbortController(), 50, {});
    expect((await gen.next()).value).toBe('hello');
    expect((await gen.next()).value).toBe('world');
  });

  test('handles generator that completes immediately without yielding', async () => {
    async function* emptyGen(): AsyncGenerator<string> {
      return;
    }
    const gen = withFirstMessageTimeout(emptyGen(), new AbortController(), 50, {});
    expect((await gen.next()).done).toBe(true);
  });

  test('a generator that never yields times out, aborts its controller and logs diagnostics', async () => {
    const controller = new AbortController();
    const diagnostics = {
      subprocessEnvKeys: ['PATH', 'HOME', 'CLAUDE_API_KEY'],
      parentClaudeKeys: ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT'],
      model: 'sonnet',
      platform: 'darwin',
    };
    const gen = withFirstMessageTimeout(stuckGen(), controller, 50, diagnostics);

    const error = await gen.next().then(
      () => undefined,
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('produced no output within 50ms');
    // Names issue #1067 for discoverability.
    expect((error as Error).message).toContain('1067');
    expect(controller.signal.aborted).toBe(true);
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ ...diagnostics, timeoutMs: 50 }),
      'claude.first_event_timeout'
    );
  });
});

describe('workflow node capabilities', () => {
  let workflowCwd: string;

  beforeEach(() => {
    workflowCwd = tempRoots(mkdtempSync(join(tmpdir(), 'archon-claude-workflow-')));
  });

  function stageSkill(root: string, name: string): void {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: test\n---\n`);
  }
  const stageClaudeSkill = (name: string): void =>
    stageSkill(join(workflowCwd, '.claude', 'skills'), name);
  /** Stages a skill under a user config dir and returns that dir. */
  function stageUserSkill(name: string): string {
    const configDir = join(workflowCwd, 'claude-config');
    stageSkill(join(configDir, 'skills'), name);
    return configDir;
  }
  const workflowOptions = (request: RequestOptions, resume?: string): Promise<Options> =>
    optionsFor(request, resume, workflowCwd);
  const workflowFailure = (request: RequestOptions): ReturnType<typeof failureOf> =>
    failureOf(client.sendQuery('test', workflowCwd, undefined, request));

  test('passes inline agents through without setting options.agent', async () => {
    const agents = {
      'brief-gen': {
        description: 'Summarises issues',
        prompt: 'Be concise.',
        model: 'haiku',
        tools: ['Bash', 'Read'],
      },
    };

    const options = await workflowOptions({ nodeConfig: { nodeId: 'agent-node', agents } });
    expect(options.agents).toMatchObject(agents);
    expect(options.agent).toBeUndefined();
  });

  test('workflow omission selects no skills and enables strict MCP', async () => {
    const options = await workflowOptions({ nodeConfig: { nodeId: 'closed-node' } });
    expect(options.agent).toBeUndefined();
    expect(options.agents).toBeUndefined();
    expect(options.allowedTools).toBeUndefined();
    expect(options.skills).toEqual([]);
    expect(options.strictMcpConfig).toBe(true);
    expect(options.mcpServers).toBeUndefined();
  });

  test('passes exact native skill selection while preserving inline agents', async () => {
    stageClaudeSkill('my-skill');

    const options = await workflowOptions({
      nodeConfig: {
        nodeId: 'skilled-node',
        skills: ['my-skill'],
        agents: { 'extra-sub': { description: 'd', prompt: 'p' } },
      },
    });

    expect(options.skills).toEqual(['my-skill']);
    expect(options.agent).toBeUndefined();
    expect(options.agents).toEqual({ 'extra-sub': { description: 'd', prompt: 'p' } });
  });

  test('native skills without allowed_tools leave the SDK tool set unrestricted', async () => {
    stageClaudeSkill('agent-browser');

    const options = await workflowOptions({
      nodeConfig: { nodeId: 'skilled-node', skills: ['agent-browser'] },
    });

    expect(options.skills).toEqual(['agent-browser']);
    expect(options.tools).toBeUndefined();
  });

  test('skills with allowed_tools includes Skill in the tools list', async () => {
    stageClaudeSkill('agent-browser');

    const options = await workflowOptions({
      nodeConfig: {
        nodeId: 'skilled-node',
        skills: ['agent-browser'],
        allowed_tools: ['Bash', 'Read'],
      },
    });

    expect(options.tools).toEqual(['Bash', 'Read', 'Skill']);
    expect(options.allowedTools).toContain('Skill');
  });

  test('fails before querying when a declared skill is unavailable to Claude', async () => {
    stageSkill(join(workflowCwd, '.agents', 'skills'), 'my-skill');

    const failure = await workflowFailure({
      nodeConfig: { nodeId: 'missing-skill', skills: ['my-skill'] },
    });

    expect(failure.class).toBe('misconfigured');
    expect(failure.evidence).toContain('.claude/skills/');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('warns but still runs when a declared skill is on no root at all', async () => {
    // Claude's built-in skills and `plugin:skill` names resolve inside the SDK
    // and exist under no skills directory. Throwing on "absent from disk" made
    // every one of them undeclarable (PR #2535 review), so an unresolved name
    // warns and lets the SDK decide.
    sdkYields({ type: 'result', session_id: 'sid' });

    const chunks = await chunksOf('test', workflowCwd, undefined, {
      nodeConfig: { nodeId: 'builtin-skill', skills: ['dataviz'] },
    });

    expect(sdkOptions().skills).toEqual(['dataviz']);
    expect(chunks.filter(chunk => chunk.type === 'warning')).toEqual([
      {
        type: 'warning',
        code: 'claude.skills_unresolved',
        message: expect.stringContaining('built-in'),
      },
    ]);
  });

  test('names only the unreachable skill when a built-in is declared alongside it', async () => {
    stageSkill(join(workflowCwd, '.agents', 'skills'), 'stranded-skill');

    const failure = await workflowFailure({
      nodeConfig: { nodeId: 'mixed', skills: ['dataviz', 'stranded-skill'] },
    });

    // 'dataviz' resolves nowhere on disk and may be a built-in, so it must not
    // be blamed in an error about a misplaced install.
    expect(failure.evidence).toContain('stranded-skill');
    expect(failure.evidence).not.toContain('dataviz');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('resolves user skills from the effective CLAUDE_CONFIG_DIR on host', async () => {
    const configDir = stageUserSkill('custom-skill');

    const options = await workflowOptions({
      env: { CLAUDE_CONFIG_DIR: configDir },
      nodeConfig: { nodeId: 'custom-config', skills: ['custom-skill'] },
    });

    expect(options.skills).toEqual(['custom-skill']);
  });

  test.each<[string, () => RequestOptions, RegExp]>([
    [
      'a user-only skill when effective settingSources is project-only',
      () => ({
        env: { CLAUDE_CONFIG_DIR: stageUserSkill('user-only') },
        assistantConfig: { settingSources: ['project'] },
        nodeConfig: { nodeId: 'project-only', skills: ['user-only'] },
      }),
      /enabled Claude-native skill directory/,
    ],
    [
      'a project-only skill when per-node settingSources is user-only',
      () => {
        stageClaudeSkill('project-only');
        return {
          nodeConfig: { nodeId: 'user-only', skills: ['project-only'], settingSources: ['user'] },
        };
      },
      /enabled Claude-native skill directory/,
    ],
    [
      'every declared skill when per-node settingSources is empty',
      () => {
        stageClaudeSkill('disabled');
        return {
          assistantConfig: { settingSources: ['project', 'user'] },
          nodeConfig: { nodeId: 'no-sources', skills: ['disabled'], settingSources: [] },
        };
      },
      /effective settingSources currently enables none/,
    ],
    [
      'every declared skill when assistant-level settingSources is empty',
      () => {
        stageClaudeSkill('assistant-disabled');
        return {
          assistantConfig: { settingSources: [] },
          nodeConfig: { nodeId: 'assistant-no-sources', skills: ['assistant-disabled'] },
        };
      },
      /effective settingSources currently enables none/,
    ],
  ])('rejects %s', async (_label, request, evidence) => {
    expect((await workflowFailure(request())).evidence).toMatch(evidence);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('container workflows fail before spend for a host user-only skill', async () => {
    const failure = await workflowFailure({
      env: { CLAUDE_CONFIG_DIR: stageUserSkill('user-only') },
      execContext: { kind: 'container', containerId: 'c-1' },
      nodeConfig: { nodeId: 'container-skill', skills: ['user-only'] },
    });

    expect(failure.class).toBe('misconfigured');
    expect(failure.evidence).toContain('Container workflows');
    expect(failure.evidence).toContain('project-local .claude/skills/');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('container workflows accept a declared project-local skill', async () => {
    stageClaudeSkill('container-project-skill');

    const options = await workflowOptions({
      execContext: { kind: 'container', containerId: 'c-1' },
      nodeConfig: { nodeId: 'container-project', skills: ['container-project-skill'] },
    });

    expect(options.skills).toEqual(['container-project-skill']);
    expect(options.strictMcpConfig).toBe(true);
  });

  test('uses the same closed capability options when resuming', async () => {
    sdkYields({ type: 'result', session_id: 'sid' });

    for (const sessionId of [undefined, 'resume-me']) {
      await chunksOf('test', workflowCwd, sessionId, { nodeConfig: { nodeId: 'closed-node' } });
    }

    expect(mockQuery).toHaveBeenCalledTimes(2);
    for (const call of [0, 1]) {
      expect(sdkOptions(call).skills).toEqual([]);
      expect(sdkOptions(call).strictMcpConfig).toBe(true);
    }
    expect(sdkOptions(1).resume).toBe('resume-me');
  });

  test('strict MCP passes exactly the workflow-declared server map', async () => {
    mockQuery.mockImplementation(() =>
      Object.assign(
        (async function* () {
          yield { type: 'result', session_id: 'sid' };
        })(),
        {
          initializationResult: async () => ({}),
          mcpServerStatus: async () => [{ name: 'declared', status: 'connected' }],
          close: () => {},
        }
      )
    );
    const mcpPath = join(workflowCwd, 'mcp.json');
    writeFileSync(mcpPath, JSON.stringify({ declared: { command: 'node', args: ['server.mjs'] } }));

    await chunksOf('test', workflowCwd, undefined, {
      nodeConfig: { nodeId: 'mcp-node', mcp: mcpPath },
    });
    const options = sdkOptions();

    expect(options.strictMcpConfig).toBe(true);
    expect(Object.keys(options.mcpServers ?? {})).toEqual(['declared']);
    expect(options.allowedTools).toContain('mcp__declared__*');
  });

  test('keeps partial non-workflow nodeConfig on ambient defaults', async () => {
    const options = await workflowOptions({ nodeConfig: { allowed_tools: [] } });

    expect(options.skills).toBeUndefined();
    expect(options.strictMcpConfig).toBeUndefined();
    expect(options.tools).toEqual([]);
  });

  test('does not grant Skill to a non-workflow call that carries skills', async () => {
    // The `options.skills` narrowing is gated on the workflow path. Granting
    // the Skill tool outside that gate would expose the whole ambient catalog
    // instead of a declared subset (PR #2535 review).
    const options = await workflowOptions({
      nodeConfig: { allowed_tools: ['Read'], skills: ['my-skill'] },
    });

    expect(options.skills).toBeUndefined();
    expect(options.tools).toEqual(['Read']);
    expect(options.allowedTools ?? []).not.toContain('Skill');
  });
});

describe('workflow-node plugin scope', () => {
  const builtinInit = {
    type: 'system',
    subtype: 'init',
    session_id: 'sid',
    plugins: [{ name: 'agents-md', path: 'builtin', source: 'agents-md@builtin' }],
  };
  const initWith = (plugin: { name: string; path: string; source: string }): unknown => ({
    ...builtinInit,
    plugins: [...builtinInit.plugins, plugin],
  });

  function nodeChunks(
    nodeConfig: Record<string, unknown>,
    request?: RequestOptions,
    resume?: string
  ) {
    return chunksOf('test', tmpdir(), resume, { ...request, nodeConfig });
  }

  test('a node that names nothing turns off every installed plugin and keeps native settings', async () => {
    pluginIdsSpy.mockResolvedValue(['posthog@official', 'prp-core@prp']);
    sdkYields(builtinInit, { type: 'result', session_id: 'sid' });

    await nodeChunks({ nodeId: 'closed-node' });

    const options = sdkOptions();
    expect(options.settings).toEqual({
      enabledPlugins: { 'posthog@official': false, 'prp-core@prp': false },
      syncClaudeAiPlugins: false,
    });
    expect(options.settingSources).toEqual(['project', 'user']);
    expect(options.strictMcpConfig).toBe(true);
  });

  test('delivered auth disables key helpers while retaining capability settings', async () => {
    pluginIdsSpy.mockResolvedValue(['posthog@official']);
    sdkYields(builtinInit, { type: 'result', session_id: 'sid' });

    await nodeChunks(
      { nodeId: 'title' },
      {
        env: { CLAUDE_CODE_OAUTH_TOKEN: 'user-token' },
        protectedEnvKeys: ['CLAUDE_CODE_OAUTH_TOKEN'],
        userCredentialEnvKeys: ['CLAUDE_CODE_OAUTH_TOKEN'],
      }
    );

    const options = sdkOptions();
    expect(options.settings).toMatchObject({
      apiKeyHelper: '',
      enabledPlugins: { 'posthog@official': false },
    });
    expect(options.settingSources).toEqual(['project', 'user']);
  });

  test('a named plugin is the only one enabled', async () => {
    pluginIdsSpy.mockResolvedValue(['posthog@official', 'prp-core@prp']);
    sdkYields(initWith({ name: 'posthog', path: '/p', source: 'posthog@official' }), {
      type: 'result',
      session_id: 'sid',
    });

    const chunks = await nodeChunks({ nodeId: 'named', plugins: ['posthog@official'] });

    expect(sdkOptions().settings).toEqual({
      enabledPlugins: { 'posthog@official': true, 'prp-core@prp': false },
      syncClaudeAiPlugins: false,
    });
    expect(chunks.find(c => c.type === 'result')?.isError).toBeUndefined();
  });

  test('a named plugin that is not installed fails as misconfigured before the session starts', async () => {
    pluginIdsSpy.mockResolvedValue(['prp-core@prp']);

    const chunks = await nodeChunks({ nodeId: 'named', plugins: ['posthog@official'] });

    expect(mockQuery).not.toHaveBeenCalled();
    const result = chunks.find(c => c.type === 'result');
    expect(result?.failure?.class).toBe('misconfigured');
    expect(result?.failure?.evidence).toContain('posthog@official');
  });

  test('a failed inventory read fails as misconfigured before the session starts', async () => {
    pluginIdsSpy.mockRejectedValue(
      new ClassifiedProviderError('misconfigured', 'Cannot list Claude plugins: boom')
    );

    const chunks = await nodeChunks({ nodeId: 'closed-node' });

    expect(mockQuery).not.toHaveBeenCalled();
    expect(chunks.find(c => c.type === 'result')?.failure).toEqual({
      class: 'misconfigured',
      evidence: 'Cannot list Claude plugins: boom',
    });
  });

  test('a plugin that loaded without being named fails the node and ends the query', async () => {
    let ended = false;
    let modelTurnReached = false;
    mockQuery.mockImplementation(async function* () {
      try {
        yield initWith({ name: 'synced', path: '/s', source: 'synced@claude-ai' });
        modelTurnReached = true;
        yield { type: 'result', session_id: 'sid' };
      } finally {
        ended = true;
      }
    });

    const chunks = await nodeChunks({ nodeId: 'closed-node' });

    expect(modelTurnReached).toBe(false);
    expect(ended).toBe(true);
    const result = chunks.find(c => c.type === 'result');
    expect(result?.failure?.class).toBe('misconfigured');
    expect(result?.failure?.evidence).toContain('synced@claude-ai');
  });

  test('direct chat reads no inventory and sets no plugin settings', async () => {
    sdkYields({ type: 'result', session_id: 'sid' });

    await chunksOf('chat', tmpdir());
    await nodeChunks({ allowed_tools: ['Read'] });

    expect(pluginIdsSpy).not.toHaveBeenCalled();
    expect(sdkOptions(0).settings).toBeUndefined();
    expect(sdkOptions(1).settings).toBeUndefined();
  });

  test('a resumed node gets the same plugin scope as a fresh one', async () => {
    pluginIdsSpy.mockResolvedValue(['posthog@official']);
    sdkYields(builtinInit, { type: 'result', session_id: 'sid' });

    await nodeChunks({ nodeId: 'closed-node' }, undefined, 'prior-session');

    expect(sdkOptions().resume).toBe('prior-session');
    expect(sdkOptions().settings).toMatchObject({ enabledPlugins: { 'posthog@official': false } });
  });
});

describe('typed failures (#1797, #3524)', () => {
  /** The result of one query over `events`. */
  async function resultOf(...events: unknown[]): Promise<Record<string, unknown>> {
    sdkYields(...events);
    return onlyResult(await collect(client.sendQuery('test', '/workspace')));
  }

  /** The result of one query whose SDK stream throws `error`. */
  async function thrownResult(error: Error, cwd = '/workspace'): Promise<Record<string, unknown>> {
    mockQuery.mockImplementation(async function* () {
      throw error;
    });
    return onlyResult(await collect(client.sendQuery('test', cwd)));
  }

  test.each([
    ['authentication_failed', 'auth'],
    ['oauth_org_not_allowed', 'auth'],
    ['account_on_hold', 'auth'],
    ['verification_required', 'auth'],
    ['cloud_credential_error', 'auth'],
    ['billing_error', 'quota_exhausted'],
    ['rate_limit', 'rate_limited'],
    ['overloaded', 'overloaded'],
    ['server_error', 'transient'],
    ['invalid_request', 'unknown'],
    ['model_not_found', 'misconfigured'],
    ['max_output_tokens', 'unknown'],
    ['unknown', 'unknown'],
  ])('API error code %s reports a %s failure and keeps the evidence', async (code, expected) => {
    const text = 'API Error: opaque vendor evidence';
    sdkYields(syntheticAssistantMessage(code, text), apiErrorResult(text));

    const stream = await collect(client.sendQuery('test', '/workspace'));
    const result = onlyResult(stream);

    expect(result.isError).toBe(true);
    expect(result.failure).toEqual({ class: expected, evidence: text });
    // The error prose is never output.
    expect(stream.chunks.filter(c => c.type === 'agent_message_chunk')).toHaveLength(0);
    // The provider makes one SDK call; retry belongs to the engine.
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  test('a reworded message with the same code keeps the same class', async () => {
    const classes: unknown[] = [];
    for (const text of ['Invalid API key · Fix external API key', 'Unauthorized: key revoked']) {
      const result = await resultOf(
        syntheticAssistantMessage('authentication_failed', text),
        apiErrorResult(text)
      );
      classes.push((result.failure as { class: string }).class);
    }
    expect(classes).toEqual(['auth', 'auth']);
  });

  test('text that reads as a different class does not change the code’s class', async () => {
    // "rate limit" and "401" in the words of a server_error stay transient.
    const text = 'rate limit reached, 401 unauthorized, credit balance too low';
    const result = await resultOf(
      syntheticAssistantMessage('server_error', text),
      apiErrorResult(text)
    );
    expect(result.failure).toEqual({ class: 'transient', evidence: text });
  });

  test.each([
    [429, 'rate_limited'],
    [401, 'auth'],
    [403, 'auth'],
    [529, 'transient'],
    [500, 'transient'],
    [400, 'unknown'],
    [null, 'unknown'],
  ])('a catch-all code with HTTP status %p reports a %s failure', async (status, expected) => {
    // #1341's "tool use concurrency" 400 is one of these: its status carries no
    // class, so it is `unknown` whatever its words say.
    const text = 'API Error: 400 due to tool use concurrency issues.';
    const result = await resultOf(
      syntheticAssistantMessage('unknown', text),
      apiErrorResult(text, status)
    );
    expect((result.failure as { class: string }).class).toBe(expected);
  });

  test('a rate limit inside a rejected subscription window is an exhausted quota with its reset', async () => {
    const text = "You've hit your session limit · resets 3pm";
    const result = await resultOf(
      {
        type: 'rate_limit_event',
        rate_limit_info: { status: 'rejected', resetsAt: 1790367600, rateLimitType: 'five_hour' },
      },
      syntheticAssistantMessage('rate_limit', text),
      apiErrorResult(text, 429)
    );
    expect(result.failure).toEqual({
      class: 'quota_exhausted',
      resetAt: new Date(1790367600 * 1000).toISOString(),
      evidence: text,
    });
  });

  test('a rate limit while the subscription window is still allowed is load shedding', async () => {
    const text = 'Rate limited · Try again later';
    const result = await resultOf(
      {
        type: 'rate_limit_event',
        rate_limit_info: { status: 'allowed_warning', resetsAt: 1790367600 },
      },
      syntheticAssistantMessage('rate_limit', text),
      apiErrorResult(text, 429)
    );
    expect(result.failure).toEqual({ class: 'rate_limited', evidence: text });
  });

  test('an api_error result without a synthetic message is still a failure', async () => {
    const result = await resultOf(apiErrorResult('Something went wrong upstream'));
    expect(result.failure).toEqual({ class: 'unknown', evidence: 'Something went wrong upstream' });
  });

  test('a spend-limit result reports budget_exceeded and keeps its cost and subtype', async () => {
    const result = await resultOf({
      type: 'result',
      subtype: 'error_max_budget_usd',
      is_error: true,
      errors: ['Reached maximum budget ($0.50)'],
      total_cost_usd: 0.51,
      session_id: 'sid-budget',
    });
    expect(result.failure).toEqual({
      class: 'budget_exceeded',
      evidence: 'error_max_budget_usd: Reached maximum budget ($0.50)',
    });
    expect(result.errorSubtype).toBe('error_max_budget_usd');
    expect(result.errors).toEqual(['Reached maximum budget ($0.50)']);
    expect(result.cost).toBeCloseTo(0.51);
  });

  test('an error_during_execution result keeps its subtype and reports unknown', async () => {
    sdkYields({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      errors: ['No conversation found with session ID: stale'],
      session_id: 'sid-stale',
    });

    const result = onlyResult(await collect(client.sendQuery('test', '/workspace', 'stale')));
    expect(result.errorSubtype).toBe('error_during_execution');
    expect(result.failure).toEqual({
      class: 'unknown',
      evidence: 'error_during_execution: No conversation found with session ID: stale',
    });
  });

  test.each([
    ['gateway_signin_required', 'auth'],
    ['org_pin_api_key_conflict', 'auth'],
    ['worktree_unverified', 'transient'],
    ['org_config_required_unavailable', 'transient'],
    ['org_config_refused', 'auth'],
    ['proxy_invalid', 'misconfigured'],
    ['cli_version_too_old', 'misconfigured'],
    ['bypass_root', 'misconfigured'],
    ['managed_settings_invalid', 'misconfigured'],
    ['provider_not_allowed', 'misconfigured'],
    ['temp_dir_unusable', 'misconfigured'],
    ['cwd_unavailable', 'misconfigured'],
    ['shell_tool_missing', 'misconfigured'],
    ['remote_settings_required_unavailable', 'unknown'],
    ['org_verify_failed', 'unknown'],
  ])('a startup failure for %s reports %s, classified by its reason', async (reason, expected) => {
    const text = 'Claude Code could not start.';
    const result = await resultOf({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      errors: [text],
      startup_failure_reason: reason,
      session_id: 'sid-startup',
    });
    expect(result.failure).toEqual({
      class: expected,
      evidence: `error_during_execution (${reason}): ${text}`,
    });
    // The CLI writes that result for every known cause only when asked to; without
    // the variable some causes reach Archon as a bare exit code.
    expect(sdkOptions().env?.CLAUDE_CODE_STARTUP_FAILURE_RESULTS).toBe('1');
  });

  test('a stream ending after a synthetic error reports it as the failure', async () => {
    // The stream ends abnormally, with no result event.
    sdkYields(syntheticAssistantMessage('billing_error', 'Credit balance is too low'));

    const stream = await collect(client.sendQuery('test', '/workspace'));
    expect(onlyResult(stream).failure).toEqual({
      class: 'quota_exhausted',
      evidence: 'Credit balance is too low',
    });
    expect(stream.chunks.filter(c => c.type === 'agent_message_chunk')).toHaveLength(0);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['process_exited_nonzero', 'Claude Code process exited with code 1', 'transient'],
    ['process_killed_by_signal', 'Claude Code process terminated by signal SIGKILL', 'transient'],
    ['initialize_timeout', 'Claude Code did not initialize in 60000ms', 'transient'],
    ['error_result', 'unauthorized: 401 rate limit', 'unknown'],
  ])(
    'a thrown SDK error with errorClass %s reports its typed class',
    async (errorClass, message, expected) => {
      mockQuery.mockImplementation(async function* (args) {
        args.options?.stderr?.('diagnostic: something broke');
        throw sdkThrown(message, { errorClass });
      });

      const result = onlyResult(await collect(client.sendQuery('test', '/workspace')));
      const failure = result.failure as { class: string; evidence: string };
      expect(failure.class).toBe(expected);
      expect(failure.evidence).toContain(message);
      expect(failure.evidence).toContain('diagnostic: something broke');
      expect(mockQuery).toHaveBeenCalledTimes(1);
    }
  );

  test('keeps all stderr output in the failure evidence', async () => {
    mockQuery.mockImplementation(async function* (args) {
      args.options?.stderr?.('Spawning Claude Code process: node cli.js');
      args.options?.stderr?.('AJV validation: schema loaded');
      args.options?.stderr?.('startup diagnostic: ready');
      throw new Error('process exited with code 1');
    });

    const failure = await failureOf(client.sendQuery('test', '/workspace'));
    expect(failure.evidence).toContain('stderr:');
    expect(failure.evidence).toContain('AJV validation');
    expect(failure.evidence).toContain('startup diagnostic');
  });

  test('a thrown error with no typed field is unknown whatever its words say', async () => {
    const result = await thrownResult(
      new Error('process exited with code 1: unauthorized, rate limit')
    );
    expect((result.failure as { class: string }).class).toBe('unknown');
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  // The SDK reports a spawn failure caused by a MISSING WORKING DIRECTORY as a
  // libc/architecture mismatch, because posix_spawn returns ENOENT against the
  // executable's path and the SDK only checks that the executable exists.
  test('a launch failure in a missing working directory names the directory', async () => {
    const result = await thrownResult(
      sdkThrown(
        'Claude Code native binary at /pkg/claude exists but failed to launch. ' +
          "This usually means the binary does not match this system's libc.",
        { errorClass: 'executable_launch_failed' }
      ),
      '/worktrees/removed-by-cleanup'
    );
    const failure = result.failure as { class: string; evidence: string };
    expect(failure.class).toBe('misconfigured');
    expect(failure.evidence).toMatch(
      /working directory "\/worktrees\/removed-by-cleanup" does not exist/
    );
    expect(failure.evidence).toMatch(/The binary is fine/);
  });

  test('a launch failure in an existing working directory keeps the SDK message', async () => {
    const message = 'Claude Code native binary at /pkg/claude exists but failed to launch.';
    const result = await thrownResult(
      sdkThrown(message, { errorClass: 'executable_launch_failed' }),
      process.cwd()
    );
    expect(result.failure).toEqual({ class: 'misconfigured', evidence: message });
  });

  test.each([
    ['executable_not_found', { errorClass: 'executable_not_found' }],
    ['a spawn ENOENT', { code: 'ENOENT' }],
  ])('%s is misconfigured', async (_label, fields) => {
    const message = 'Claude Code executable not found at /missing/claude';
    const result = await thrownResult(sdkThrown(message, fields), process.cwd());
    expect(result.failure).toEqual({ class: 'misconfigured', evidence: message });
  });

  test('a missing MCP config file is misconfigured, before any query', async () => {
    const failure = await failureOf(
      client.sendQuery('test', process.cwd(), undefined, {
        nodeConfig: { mcp: 'does-not-exist.mcp.json' },
      })
    );
    expect(failure.class).toBe('misconfigured');
    expect(failure.evidence).toContain('MCP config file not found');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('a first-event timeout is transient, not a cancellation', async () => {
    mockQuery.mockImplementation(async function* () {
      await new Promise(() => {}); // hang forever
      yield { type: 'result', session_id: 'never' };
    });
    const original = process.env.ARCHON_CLAUDE_FIRST_EVENT_TIMEOUT_MS;
    process.env.ARCHON_CLAUDE_FIRST_EVENT_TIMEOUT_MS = '50';
    try {
      const result = onlyResult(await collect(client.sendQuery('test', '/workspace')));
      const failure = result.failure as { class: string; evidence: string };
      expect(failure.class).toBe('transient');
      expect(failure.evidence).toContain('produced no output within 50ms');
    } finally {
      if (original !== undefined) process.env.ARCHON_CLAUDE_FIRST_EVENT_TIMEOUT_MS = original;
      else delete process.env.ARCHON_CLAUDE_FIRST_EVENT_TIMEOUT_MS;
    }
  });

  test('a CLI that never initializes its MCP servers hits the same first-event timeout', async () => {
    const root = tempRoots(mkdtempSync(join(tmpdir(), 'claude-mcp-silent-')));
    const mcp = join(root, 'mcp.json');
    writeFileSync(mcp, JSON.stringify({ declared: { command: 'fixture' } }));
    let statusReads = 0;
    mockQuery.mockImplementation(() =>
      Object.assign(
        (async function* () {
          await new Promise(() => {});
        })(),
        {
          initializationResult: () => new Promise(() => {}),
          mcpServerStatus: async () => {
            statusReads++;
            return [];
          },
          close: () => {},
        }
      )
    );
    const original = process.env.ARCHON_CLAUDE_FIRST_EVENT_TIMEOUT_MS;
    process.env.ARCHON_CLAUDE_FIRST_EVENT_TIMEOUT_MS = '50';
    try {
      const result = onlyResult(
        await collect(client.sendQuery('test', root, undefined, { nodeConfig: { mcp } }))
      );
      const failure = result.failure as { class: string; evidence: string };
      expect(failure.class).toBe('transient');
      expect(failure.evidence).toContain('produced no output within 50ms');
      expect(statusReads).toBe(0);
    } finally {
      if (original !== undefined) process.env.ARCHON_CLAUDE_FIRST_EVENT_TIMEOUT_MS = original;
      else delete process.env.ARCHON_CLAUDE_FIRST_EVENT_TIMEOUT_MS;
    }
  });

  test('a caller abort still throws Query aborted rather than reporting a failure', async () => {
    const abortController = new AbortController();
    mockQuery.mockImplementation(async function* () {
      abortController.abort();
      throw sdkThrown('Claude Code process aborted by user', { errorClass: 'aborted' });
    });

    const stream = await collect(
      client.sendQuery('test', '/workspace', undefined, { abortSignal: abortController.signal })
    );
    expect(stream.error?.message).toBe('Query aborted');
    expect(stream.chunks.filter(c => c.type === 'result')).toHaveLength(0);
  });

  test('an aborted stream closes its open tool calls before the abort propagates', async () => {
    const abortController = new AbortController();
    mockQuery.mockImplementation(async function* () {
      yield {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'toolu_a', name: 'Bash', input: { command: 'sleep 60' } },
            { type: 'tool_use', id: 'toolu_b', name: 'Read', input: {} },
          ],
        },
      };
      abortController.abort();
      throw sdkThrown('Claude Code process aborted by user', { errorClass: 'aborted' });
    });

    const stream = await collect(
      client.sendQuery('test', '/workspace', undefined, { abortSignal: abortController.signal })
    );
    expect(stream.error?.message).toBe('Query aborted');
    expect(stream.chunks.map(c => [c.type, c.toolCallId, c.status])).toEqual([
      ['tool_call', 'toolu_a', undefined],
      ['tool_call', 'toolu_b', undefined],
      ['tool_call_update', 'toolu_a', 'cancelled'],
      ['tool_call_update', 'toolu_b', 'cancelled'],
    ]);
  });

  test('a stream that ends without a result reports a failure before it settles', async () => {
    sdkYields({ type: 'assistant', message: { content: [{ type: 'text', text: 'partial' }] } });

    const stream = await collect(client.sendQuery('test', '/workspace'));
    const result = onlyResult(stream);
    expect(result.errorSubtype).toBe('stream_ended_without_result');
    expect(result.failure).toEqual({
      class: 'unknown',
      evidence: 'Claude Code ended the turn without a result',
    });
    expect(stream.chunks.map(c => c.type)).toEqual(['agent_message_chunk', 'result', 'settled']);
  });

  test('an error after the turn reported its result does not add a second result', async () => {
    mockQuery.mockImplementation(async function* () {
      yield { type: 'result', subtype: 'success', is_error: false, session_id: 'sid-done' };
      throw sdkThrown('Claude Code process exited with code 1', {
        errorClass: 'process_exited_nonzero',
      });
    });

    const result = onlyResult(await collect(client.sendQuery('test', '/workspace')));
    expect(result).not.toHaveProperty('failure');
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ resultReported: true }),
      'query_error'
    );
  });

  test('legitimate output that merely mentions the error phrases is untouched', async () => {
    // A real model turn (real model id, no wrapper error field, clean result)
    // whose TEXT happens to discuss login errors — e.g. a node writing docs
    // about auth failures. Must flow through as a normal success.
    sdkYields(
      {
        type: 'assistant',
        message: {
          model: 'claude-sonnet-4-5',
          content: [
            {
              type: 'text',
              text: 'If auth fails you may see "Not logged in · Please run /login".',
            },
          ],
        },
        session_id: 'sid-legit',
      },
      {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'done',
        session_id: 'sid-legit',
      }
    );

    const stream = await collect(client.sendQuery('test', '/workspace'));
    expect(
      stream.chunks.some(c => typeof c.text === 'string' && c.text.includes('Not logged in'))
    ).toBe(true);
    const result = onlyResult(stream);
    expect(result).not.toHaveProperty('isError');
    expect(result).not.toHaveProperty('failure');
  });

  test('real-model message carrying an error code (e.g. max_output_tokens) is not suppressed', async () => {
    // A REAL (non-synthetic) message can carry a wrapper error code alongside
    // genuine truncated output. Only '<synthetic>' content is SDK error prose.
    sdkYields(
      {
        type: 'assistant',
        message: {
          model: 'claude-sonnet-4-5',
          content: [{ type: 'text', text: 'partial output before truncation' }],
        },
        error: 'max_output_tokens',
        session_id: 'sid-trunc',
      },
      { type: 'result', subtype: 'success', is_error: false, session_id: 'sid-trunc' }
    );

    const stream = await collect(client.sendQuery('test', '/workspace'));
    expect(stream.chunks.some(c => c.text === 'partial output before truncation')).toBe(true);
    expect(onlyResult(stream)).not.toHaveProperty('failure');
  });

  test('fail-safe: synthetic error contradicted by a clean result yields the withheld text late', async () => {
    sdkYields(syntheticAssistantMessage('server_error', 'Upstream hiccup'), {
      type: 'result',
      subtype: 'success',
      is_error: false,
      session_id: 'sid-recovered',
    });

    const stream = await collect(client.sendQuery('test', '/workspace'));
    expect(stream.chunks).toContainEqual({ type: 'agent_message_chunk', text: 'Upstream hiccup' });
    expect(onlyResult(stream)).not.toHaveProperty('failure');
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'server_error' }),
      'claude.synthetic_error_not_confirmed'
    );
  });
});

describe('provider contract', () => {
  /** A background bash task that outlives the first idle and is reported by a wake turn. */
  function backgroundBashCase(client: IAgentProvider, root: string) {
    let runtimeEnded = false;
    const usage = (input: number, output: number, cacheRead: number, cacheWrite: number) => ({
      main: {
        inputTokens: input,
        outputTokens: output,
        cacheReadInputTokens: cacheRead,
        cacheCreationInputTokens: cacheWrite,
      },
    });
    return {
      name: 'streaming background bash survives idle and a wake turn',
      runtimeStatus: () => (runtimeEnded ? ('completed' as const) : ('running' as const)),
      run: () => {
        runtimeEnded = false;
        mockQuery.mockImplementation(async function* ({ prompt }) {
          if (typeof prompt === 'string') throw new Error('Print mode kills background tasks');
          const input = prompt[Symbol.asyncIterator]();
          expect((await input.next()).value).toMatchObject({ message: { content: 'test' } });
          let inputEnded = false;
          const closing = input.next().then(value => {
            inputEnded = value.done === true;
          });
          yield {
            type: 'system',
            subtype: 'background_tasks_changed',
            tasks: [
              { task_id: 'bash', task_type: 'local_bash', description: 'write output' },
              { task_id: 'watcher', task_type: 'monitor', description: 'ambient', ambient: true },
            ],
          };
          yield { type: 'system', subtype: 'task_progress', task_id: 'watcher' };
          yield {
            type: 'result',
            subtype: 'success',
            session_id: 's',
            result: 'first',
            modelUsage: usage(100, 20, 30, 40),
            total_cost_usd: 0.1,
          };
          yield { type: 'system', subtype: 'session_state_changed', state: 'idle' };
          await Promise.resolve();
          expect(inputEnded).toBe(false);
          writeFileSync(join(root, 'background-output.txt'), 'finished');
          yield { type: 'system', subtype: 'background_tasks_changed', tasks: [] };
          runtimeEnded = true;
          yield {
            type: 'system',
            subtype: 'task_notification',
            task_id: 'bash',
            status: 'completed',
            output_file: join(root, 'background-output.txt'),
          };
          yield { type: 'system', subtype: 'session_state_changed', state: 'running' };
          yield {
            type: 'result',
            subtype: 'success',
            session_id: 's',
            result: 'final',
            modelUsage: usage(110, 25, 37, 49),
            total_cost_usd: 0.3,
          };
          yield { type: 'system', subtype: 'session_state_changed', state: 'idle' };
          await closing;
        });
        return client.sendQuery('test', '/workspace');
      },
    };
  }

  test.each([false, true])('conforms to the provider contract (streams: %s)', async remote => {
    const client = remote ? overStreams(createProvider, descriptor) : createProvider();
    function turn(events: unknown[] | Error): () => AsyncIterable<unknown> {
      return () => {
        mockQuery.mockImplementation(async function* () {
          if (events instanceof Error) throw events;
          yield* events;
        });
        return client.sendQuery('test', '/workspace');
      };
    }
    const backgroundRoot = tempRoots(mkdtempSync(join(tmpdir(), 'claude-background-')));
    const backgroundCase = backgroundBashCase(client, backgroundRoot);
    const violations = await runProviderConformance({
      capabilities: client.getCapabilities(),
      backgroundCases: [backgroundCase],
      turns: [
        {
          name: 'plain turn',
          run: turn([
            { type: 'result', subtype: 'success', is_error: false, session_id: 's' },
            { type: 'system', subtype: 'session_state_changed', state: 'idle' },
          ]),
        },
        {
          name: 'result before background work drains',
          run: turn([
            { type: 'result', subtype: 'success', is_error: false, session_id: 's' },
            {
              type: 'system',
              subtype: 'background_tasks_changed',
              tasks: [{ task_id: 't', task_type: 'local_agent', description: 'bg' }],
            },
            { type: 'system', subtype: 'background_tasks_changed', tasks: [] },
            { type: 'system', subtype: 'task_notification', task_id: 't', status: 'completed' },
            { type: 'result', subtype: 'success', is_error: false, session_id: 's' },
            { type: 'system', subtype: 'session_state_changed', state: 'idle' },
          ]),
        },
        {
          name: 'turn the SDK retried',
          run: turn([
            {
              type: 'system',
              subtype: 'api_retry',
              attempt: 1,
              max_retries: 10,
              retry_delay_ms: 1000,
              error_status: 429,
              error: 'rate_limit',
            },
            { type: 'result', subtype: 'success', is_error: false, session_id: 's' },
          ]),
        },
        {
          name: 'CLI without session-state events',
          run: turn([{ type: 'result', subtype: 'success', is_error: false, session_id: 's' }]),
        },
      ],
      failureCases: [
        {
          name: 'rejected login',
          expected: 'auth',
          evidence: 'Not logged in',
          run: turn([
            syntheticAssistantMessage('authentication_failed', 'Not logged in'),
            apiErrorResult('Not logged in'),
          ]),
        },
        {
          name: 'overloaded API',
          expected: 'overloaded',
          evidence: 'Overloaded',
          run: turn([
            syntheticAssistantMessage('overloaded', 'Overloaded'),
            apiErrorResult('Overloaded', 529),
          ]),
        },
        {
          name: 'spend limit',
          expected: 'budget_exceeded',
          evidence: 'Reached maximum budget',
          run: turn([
            {
              type: 'result',
              subtype: 'error_max_budget_usd',
              is_error: true,
              errors: ['Reached maximum budget'],
              session_id: 's',
            },
          ]),
        },
        {
          name: 'CLI below the minimum version',
          expected: 'misconfigured',
          evidence: 'Claude Code is too old',
          run: turn([
            {
              type: 'result',
              subtype: 'error_during_execution',
              is_error: true,
              errors: ['Claude Code is too old'],
              startup_failure_reason: 'cli_version_too_old',
              session_id: 's',
            },
          ]),
        },
        {
          name: 'crashed subprocess',
          expected: 'transient',
          evidence: 'exited with code 1',
          run: turn(
            sdkThrown('Claude Code process exited with code 1', {
              errorClass: 'process_exited_nonzero',
            })
          ),
        },
        {
          name: 'stream ended without a result',
          expected: 'unknown',
          evidence: 'without a result',
          run: turn([
            { type: 'assistant', message: { content: [{ type: 'text', text: 'partial' }] } },
          ]),
        },
        {
          name: 'unclassified error',
          expected: 'unknown',
          evidence: 'something unexpected',
          run: turn(new Error('something unexpected')),
        },
        {
          name: 'workflow node with a plugin it does not name',
          expected: 'misconfigured',
          evidence: 'synced@claude-ai',
          run: () => {
            sdkYields(
              {
                type: 'system',
                subtype: 'init',
                session_id: 's',
                plugins: [{ name: 'synced', path: '/s', source: 'synced@claude-ai' }],
              },
              { type: 'result', subtype: 'success', is_error: false, session_id: 's' }
            );
            return client.sendQuery('test', '/workspace', undefined, {
              nodeConfig: { nodeId: 'closed-node' },
            });
          },
        },
      ],
      forkTurn: {
        name: 'forked session',
        source: 's',
        run: () => {
          sdkYields({ type: 'result', subtype: 'success', is_error: false, session_id: 's-fork' });
          return client.sendQuery('test', '/workspace', 's', { forkSession: true });
        },
      },
      toolTurn: {
        name: 'tool turn with an interrupted call',
        run: () => {
          mockQuery.mockImplementation(async function* (args) {
            const successHook = args.options?.hooks?.PostToolUse?.[0]?.hooks?.[0];
            const failureHook = args.options?.hooks?.PostToolUseFailure?.[0]?.hooks?.[0];
            const hookOptions = { signal: new AbortController().signal };
            yield {
              type: 'assistant',
              message: {
                content: [
                  { type: 'tool_use', id: 'toolu_read', name: 'Read', input: { path: 'a' } },
                  { type: 'tool_use', id: 'toolu_bash', name: 'Bash', input: { command: 'sleep' } },
                ],
              },
            };
            await successHook?.(
              { tool_name: 'Read', tool_use_id: 'toolu_read', tool_response: 'a' } as never,
              'toolu_read',
              hookOptions
            );
            await failureHook?.(
              {
                tool_name: 'Bash',
                tool_use_id: 'toolu_bash',
                error: 'interrupted',
                is_interrupt: true,
              } as never,
              'toolu_bash',
              hookOptions
            );
            yield { type: 'result', subtype: 'success', is_error: false, session_id: 's' };
            yield { type: 'system', subtype: 'session_state_changed', state: 'idle' };
          });
          return client.sendQuery('test', '/workspace');
        },
      },
    });
    expect(await Bun.file(join(backgroundRoot, 'background-output.txt')).text()).toBe('finished');
    const backgroundStream = await collect(backgroundCase.run());
    expect(
      backgroundStream.chunks.some(chunk => chunk.type === 'subtask' && chunk.taskId === 'watcher')
    ).toBe(false);
    expect(
      backgroundStream.chunks
        .filter(chunk => chunk.type === 'result')
        .map(chunk => [chunk.text, chunk.cost, chunk.tokens])
    ).toEqual([
      ['first', 0.1, { input: 170, output: 20, cacheRead: 30, cacheWrite: 40 }],
      ['final', 0.19999999999999998, { input: 26, output: 5, cacheRead: 7, cacheWrite: 9 }],
    ]);
    expect(violations).toEqual([]);
  });

  test('native tool callbacks and chunks match over streams', async () => {
    const handler = mock(async (input: Record<string, unknown>) => JSON.stringify(input));
    const options = {
      nativeTools: [
        {
          name: 'manage_run',
          description: 'Inspect a run',
          inputSchema: {
            properties: { action: { kind: 'string' as const } },
            required: ['action'],
          },
          handler,
        },
      ],
    };
    const chunks: MessageChunk[][] = [];
    for (const provider of [createProvider(), overStreams(createProvider, descriptor)]) {
      mockQuery.mockImplementation(async function* ({ options }) {
        expect(options?.mcpServers?.archon).toBeDefined();
        const result = await sdkToolHandlers.get('manage_run')!({ action: 'inspect' });
        yield {
          type: 'result',
          subtype: 'success',
          session_id: 'tool-session',
          result: result.content[0].text,
        };
      });
      chunks.push(
        await Array.fromAsync(provider.sendQuery('inspect', '/workspace', undefined, options))
      );
    }
    expect(chunks[1]).toEqual(chunks[0]);
    expect(chunks[0]).toContainEqual(
      expect.objectContaining({ type: 'result', text: '{"action":"inspect"}' })
    );
    expect(handler).toHaveBeenCalledTimes(2);
  });

  test('container spawn hook receives request environment over streams', async () => {
    const canary = 'ARCHON_P4_HOST_SECRET';
    process.env[canary] = 'host-secret';
    const envs: NodeJS.ProcessEnv[] = [];
    const hookSpy = spyOn(containerSpawnModule, 'buildContainerSpawn').mockImplementation(
      () => spawnOptions => {
        envs.push(spawnOptions.env);
        throw new Error('fixture-container-hook');
      }
    );
    try {
      for (const provider of [createProvider(), overStreams(createProvider, descriptor)]) {
        mockQuery.mockImplementation(async function* ({ options }) {
          expect(options?.spawnClaudeCodeProcess).toBeDefined();
          expect(() =>
            options!.spawnClaudeCodeProcess!({
              command: 'claude',
              args: [],
              env: options?.env ?? {},
              signal: new AbortController().signal,
            })
          ).toThrow('fixture-container-hook');
          yield { type: 'result', subtype: 'success', session_id: 'container-session' };
        });
        await Array.fromAsync(
          provider.sendQuery('container', '/workspace', undefined, {
            execContext: { kind: 'container', containerId: 'fixture-container' },
            env: { ANTHROPIC_API_KEY: 'request-secret', PROJECT_VAR: 'configured' },
          })
        );
      }
      expect(envs[1]).toEqual(envs[0]);
      expect(envs[1]).not.toHaveProperty(canary);
      expect(envs[1]).toMatchObject({
        ANTHROPIC_API_KEY: 'request-secret',
        PROJECT_VAR: 'configured',
      });
    } finally {
      hookSpy.mockRestore();
      delete process.env[canary];
    }
  });

  test('diagnostic hook uses configured binary resolution over streams', async () => {
    const resolver = spyOn(binaryResolver, 'resolveClaudeBinaryWithSource').mockResolvedValue({
      path: process.execPath,
      source: 'config',
    });
    try {
      const request = {
        signal: new AbortController().signal,
        assistantConfig: { claudeBinaryPath: process.execPath },
      };
      const direct = await createProvider().diagnose(request);
      expect(await overStreams(createProvider, descriptor).diagnose!(request)).toEqual(direct);
      expect(direct.checks[0].status).toBe('ok');
      expect(resolver).toHaveBeenCalledWith(process.execPath);
    } finally {
      resolver.mockRestore();
    }
  });
});

describe('required MCP admission', () => {
  test('rejects before yielding SDK input, including container and resumed queries', async () => {
    const root = tempRoots(mkdtempSync(join(tmpdir(), 'claude-mcp-ready-')));
    const mcp = join(root, 'mcp.json');
    writeFileSync(mcp, JSON.stringify({ declared: { command: 'missing' } }));
    for (const container of [false, true]) {
      let inputs = 0;
      let closed = false;
      let inputTask: Promise<void> | undefined;
      mockQuery.mockImplementation(params => {
        const stream = (async function* () {
          if (typeof params.prompt !== 'string') {
            for await (const _input of params.prompt) {
              inputs++;
              break;
            }
          }
        })();
        return Object.assign(stream, {
          initializationResult: async () => {
            inputTask = (async () => {
              if (typeof params.prompt !== 'string')
                for await (const _input of params.prompt) {
                  inputs++;
                  break;
                }
            })();
          },
          mcpServerStatus: async () => [
            { name: 'declared', status: 'failed', error: 'spawn ENOENT' },
          ],
          close: () => {
            closed = true;
          },
        });
      });
      const chunks = await Array.fromAsync(
        (container ? overStreams(createProvider, descriptor) : new ClaudeProvider()).sendQuery(
          'hi',
          root,
          'existing',
          {
            nodeConfig: { mcp },
            ...(container
              ? {
                  execContext: {
                    kind: 'container' as const,
                    containerId: 'fixture',
                    execUser: 'user',
                  },
                }
              : {}),
          }
        )
      );
      await inputTask;
      expect(inputs).toBe(0);
      expect(closed).toBe(true);
      expect(chunks).toContainEqual(
        expect.objectContaining({
          type: 'result',
          failure: {
            class: 'misconfigured',
            evidence: expect.stringContaining('declared'),
          },
        })
      );
      expect(JSON.stringify(chunks)).toContain('spawn ENOENT');
    }
  });
});

for (const mode of ['success', 'abort', 'return'] as const) {
  test(`required MCP ${mode} preserves input ordering and cleanup`, async () => {
    const root = tempRoots(mkdtempSync(join(tmpdir(), 'claude-mcp-gate-')));
    const mcp = join(root, 'mcp.json');
    writeFileSync(mcp, JSON.stringify({ declared: { command: 'fixture' } }));
    const controller = new AbortController();
    let inputs = 0;
    let reads = 0;
    let closed = false;
    let inputTask: Promise<void> | undefined;
    const connected = Promise.withResolvers<void>();
    mockQuery.mockImplementation(params => {
      const source = params.prompt;
      const stream = (async function* () {
        await inputTask;
        yield { type: 'result', subtype: 'success', session_id: 'session', is_error: false };
      })();
      return Object.assign(stream, {
        initializationResult: async () => {
          inputTask = (async () => {
            if (typeof source !== 'string')
              for await (const _input of source) {
                inputs++;
                expect(reads).toBeGreaterThan(1);
                break;
              }
          })();
        },
        mcpServerStatus: async () => {
          reads++;
          if (reads > 1) await connected.promise;
          return [{ name: 'declared', status: reads === 1 ? 'pending' : 'connected' }];
        },
        close: () => {
          closed = true;
        },
      });
    });
    const stream = new ClaudeProvider().sendQuery('hi', root, undefined, {
      nodeConfig: { mcp },
      abortSignal: controller.signal,
      nativeTools: [
        {
          name: 'internal',
          description: 'test',
          inputSchema: { properties: {}, required: [] },
          handler: async () => '',
        },
      ],
    });
    expect((await stream.next()).value).toEqual({
      type: 'mcp_server_status',
      server: 'declared',
      status: 'pending',
    });
    expect(inputs).toBe(0);
    if (mode === 'abort') {
      controller.abort();
      await expect(stream.next()).rejects.toThrow('Query aborted');
    } else if (mode === 'return') {
      await stream.return(undefined);
    } else {
      connected.resolve();
      await Array.fromAsync(stream);
    }
    await inputTask;
    expect(inputs).toBe(mode === 'success' ? 1 : 0);
    expect(closed).toBe(true);
  });
}
