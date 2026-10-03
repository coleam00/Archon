import { describe, test, expect, mock, beforeEach, type Mock } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Codex as SdkCodex, Thread as SdkThread, Usage } from '@openai/codex-sdk';
import type { MessageChunk } from '../types';
import { createMockLogger } from '../test/mocks/logger';

const mockLogger = createMockLogger();
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
}));

/** Default usage matching Codex SDK's Usage type (required on TurnCompletedEvent) */
const defaultUsage = {
  input_tokens: 10,
  cached_input_tokens: 0,
  cache_write_input_tokens: 0,
  output_tokens: 5,
  reasoning_output_tokens: 0,
} satisfies Usage;

type MockRunStreamed = (
  ...args: Parameters<SdkThread['runStreamed']>
) => Promise<{ events: AsyncGenerator<unknown, void, unknown> }>;
type MockThread = { id: string | null; runStreamed: Mock<MockRunStreamed> };
type MockStartThread = (...args: Parameters<SdkCodex['startThread']>) => MockThread;
type MockResumeThread = (...args: Parameters<SdkCodex['resumeThread']>) => MockThread;
type MockCodexConstructor = (...args: ConstructorParameters<typeof SdkCodex>) => {
  startThread: Mock<MockStartThread>;
  resumeThread: Mock<MockResumeThread>;
};

// Create mock runStreamed first (before it's referenced)
const mockRunStreamed = mock<MockRunStreamed>((_input, _options) =>
  Promise.resolve({
    events: (async function* () {
      yield { type: 'turn.completed', usage: defaultUsage };
    })(),
  })
);

// Create a mock thread object factory
const createMockThread = (id: string | null): MockThread => ({
  id,
  runStreamed: mockRunStreamed,
});

// Create mock functions for Codex SDK that use createMockThread
const mockStartThread = mock<MockStartThread>(() => createMockThread('new-thread-id'));
const mockResumeThread = mock<MockResumeThread>(() => createMockThread('resumed-thread-id'));

// Mock Codex class
const MockCodex = mock<MockCodexConstructor>(() => ({
  startThread: mockStartThread,
  resumeThread: mockResumeThread,
}));

// Mock the Codex SDK
mock.module('@openai/codex-sdk', () => ({
  Codex: MockCodex,
}));

// Stream-shape tests below drop the trailing `settled` chunk; it has its own tests.
import { TOOL_OUTPUT_MAX_CHARS } from '@archon/provider-contract';
import { runProviderConformance } from '@archon/provider-contract/conformance';
import { CodexProvider, resetCodexSingleton } from './provider';

/** The typed failure a Codex turn ended in. */
async function codexFailure(
  gen: AsyncIterable<MessageChunk>
): Promise<{ class: string; evidence: string }> {
  let failure: { class: string; evidence: string } | undefined;
  for await (const chunk of gen) {
    if (chunk.type === 'result' && chunk.failure) failure = chunk.failure;
  }
  if (!failure) throw new Error('expected the turn to report a typed failure');
  return failure;
}

describe('CodexProvider', () => {
  let client: CodexProvider;

  beforeEach(() => {
    resetCodexSingleton();
    client = new CodexProvider();
    MockCodex.mockClear();
    mockStartThread.mockClear();
    mockResumeThread.mockClear();
    mockRunStreamed.mockClear();
    mockLogger.info.mockClear();
    mockLogger.warn.mockClear();
    mockLogger.error.mockClear();
    mockLogger.debug.mockClear();

    // Setup default mock thread
    mockStartThread.mockReturnValue(createMockThread('new-thread-id'));
    mockResumeThread.mockReturnValue(createMockThread('resumed-thread-id'));
  });

  describe('getType', () => {
    test('returns codex', () => {
      expect(client.getType()).toBe('codex');
    });
  });

  describe('getCapabilities', () => {
    test('returns limited capability set for Codex provider', () => {
      const caps = client.getCapabilities();
      expect(caps).toEqual({
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
  });

  describe('sendQuery', () => {
    test.each([
      ['omitted', undefined],
      ['empty', []],
      ['non-empty', ['prp-issue']],
    ])(
      'disables automatic skill instructions for workflow nodes when skills are %s',
      async (_label, skills) => {
        for await (const _ of client.sendQuery('test prompt', '/workspace', undefined, {
          nodeConfig: { nodeId: 'investigate', ...(skills === undefined ? {} : { skills }) },
        })) {
          // consume
        }

        expect(MockCodex).toHaveBeenCalledWith(
          expect.objectContaining({
            config: { skills: { include_instructions: false } },
          })
        );
      }
    );

    test('leaves direct non-workflow Codex calls on the native skill setting', async () => {
      for await (const _ of client.sendQuery('test prompt', '/workspace')) {
        // consume
      }

      expect(MockCodex).toHaveBeenCalledTimes(1);
      expect(MockCodex.mock.calls[0]?.[0]).not.toHaveProperty('config');
    });

    test('uses the workflow skill-catalog override when resuming a thread', async () => {
      for await (const _ of client.sendQuery('test prompt', '/workspace', 'existing-thread', {
        nodeConfig: { nodeId: 'investigate' },
      })) {
        // consume
      }

      expect(MockCodex).toHaveBeenCalledWith(
        expect.objectContaining({
          config: { skills: { include_instructions: false } },
        })
      );
      expect(mockResumeThread).toHaveBeenCalledWith(
        'existing-thread',
        expect.objectContaining({ workingDirectory: '/workspace' })
      );
    });

    test('warns and retries a resumed MCP thread without catalog suppression when the binary rejects the key', async () => {
      const testDir = await mkdtemp(join(tmpdir(), 'codex-provider-skill-fallback-'));
      await writeFile(
        join(testDir, 'mcp.json'),
        JSON.stringify({ figma: { type: 'http', url: 'http://127.0.0.1:3845/mcp' } })
      );
      let calls = 0;
      mockRunStreamed.mockImplementation(() => {
        calls++;
        const call = calls;
        return Promise.resolve({
          events: (async function* () {
            if (call === 1) {
              throw new Error(
                'Error loading config: unknown field `include_instructions` in `skills`'
              );
            }
            yield { type: 'turn.completed', usage: defaultUsage };
          })(),
        });
      });

      const chunks: MessageChunk[] = [];
      try {
        for await (const chunk of client.sendQuery('test prompt', testDir, 'existing-thread', {
          nodeConfig: { nodeId: 'investigate', mcp: 'mcp.json' },
        })) {
          if (chunk.type !== 'settled') chunks.push(chunk);
        }
      } finally {
        await rm(testDir, { recursive: true, force: true });
      }

      expect(MockCodex).toHaveBeenCalledTimes(2);
      expect(MockCodex.mock.calls[0]?.[0]).toMatchObject({
        config: {
          skills: { include_instructions: false },
          mcp_servers: { figma: expect.objectContaining({ url: 'http://127.0.0.1:3845/mcp' }) },
        },
      });
      const initialConfig = MockCodex.mock.calls[0]?.[0]?.config;
      const fallbackConfig = MockCodex.mock.calls[1]?.[0]?.config;
      expect(initialConfig).toBeDefined();
      const { skills: _skills, ...initialConfigWithoutSkills } = initialConfig ?? {};
      expect(fallbackConfig).toEqual(initialConfigWithoutSkills);
      expect(mockResumeThread).toHaveBeenCalledTimes(2);
      expect(mockResumeThread).toHaveBeenNthCalledWith(
        2,
        'existing-thread',
        expect.objectContaining({ workingDirectory: testDir })
      );
      expect(chunks[0]).toEqual({
        type: 'warning',
        code: 'codex.skill_catalog_suppression_unsupported',
        message: expect.stringContaining('Continuing with native skill discovery enabled'),
      });
      expect(chunks.at(-1)).toMatchObject({
        type: 'result',
        sessionId: 'resumed-thread-id',
        resumed: true,
      });
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ nodeId: 'investigate' }),
        'codex.workflow_skill_catalog_suppression_unsupported'
      );
    });

    test('does not replay a turn when a catalog config error arrives after provider output', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield {
            type: 'item.completed',
            item: { id: 'message-1', type: 'agent_message', text: 'already emitted' },
          };
          throw new Error('Error loading config: unknown field `include_instructions` in `skills`');
        })(),
      });

      const chunks: MessageChunk[] = [];
      for await (const chunk of client.sendQuery('test prompt', '/workspace', undefined, {
        nodeConfig: { nodeId: 'investigate' },
      })) {
        if (chunk.type !== 'settled') chunks.push(chunk);
      }

      expect(chunks).toContainEqual({ type: 'agent_message_chunk', text: 'already emitted' });
      // The error after output is the turn's failure; the turn is not replayed.
      expect(chunks.at(-1)).toMatchObject({
        type: 'result',
        failure: { class: 'unknown', evidence: expect.stringContaining('include_instructions') },
      });
      expect(MockCodex).toHaveBeenCalledTimes(1);
      expect(mockLogger.warn).not.toHaveBeenCalledWith(
        expect.anything(),
        'codex.workflow_skill_catalog_suppression_unsupported'
      );
    });

    test('does not treat unrelated Codex failures as catalog compatibility errors', async () => {
      mockRunStreamed.mockRejectedValue(new Error('authentication failed'));

      const failure = await codexFailure(
        client.sendQuery('test prompt', '/workspace', undefined, {
          nodeConfig: { nodeId: 'investigate' },
        })
      );
      expect(failure).toEqual({ class: 'unknown', evidence: 'authentication failed' });
      expect(mockLogger.warn).not.toHaveBeenCalledWith(
        expect.anything(),
        'codex.workflow_skill_catalog_suppression_unsupported'
      );
    });

    test('yields text events from agent_message items', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield {
            type: 'item.completed',
            item: { type: 'agent_message', text: 'Hello from Codex!' },
          };
          yield {
            type: 'turn.completed',
            usage: { ...defaultUsage, cached_input_tokens: 7, cache_write_input_tokens: 3 },
          };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test prompt', '/workspace')) {
        if (chunk.type !== 'settled') chunks.push(chunk);
      }

      expect(chunks).toHaveLength(2);
      expect(chunks[0]).toEqual({ type: 'agent_message_chunk', text: 'Hello from Codex!' });
      expect(chunks[1]).toEqual({
        type: 'result',
        sessionId: 'new-thread-id',
        tokens: { input: 10, output: 5, cacheRead: 7, cacheWrite: 3 },
      });
    });

    test('omits tokens when turn.completed has no usage', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield { type: 'turn.completed' };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test prompt', '/workspace')) {
        if (chunk.type !== 'settled') chunks.push(chunk);
      }

      expect(chunks).toEqual([{ type: 'result', sessionId: 'new-thread-id' }]);
    });

    test('preserves reported zero token usage', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield {
            type: 'turn.completed',
            usage: { ...defaultUsage, input_tokens: 0, output_tokens: 0 },
          };
        })(),
      });
      const chunks = [];
      for await (const chunk of client.sendQuery('test prompt', '/workspace')) {
        if (chunk.type !== 'settled') chunks.push(chunk);
      }
      expect(chunks).toEqual([
        {
          type: 'result',
          sessionId: 'new-thread-id',
          tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ]);
    });

    test('captures the new-thread id from the thread.started event (resumable sessionId)', async () => {
      // The real Codex SDK assigns a NEW thread's id during the run, via the
      // thread.started event — not synchronously on startThread(). Simulate a
      // thread whose .id is still null and assert the result carries the id from
      // the event, so persist_session / suspend-resume have a resumable id.
      mockStartThread.mockReturnValue({ id: null, runStreamed: mockRunStreamed });
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield { type: 'thread.started', thread_id: 'evt-thread-id' };
          yield {
            type: 'item.completed',
            item: { type: 'agent_message', text: 'stored' },
          };
          yield { type: 'turn.completed', usage: defaultUsage };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('remember X', '/workspace')) {
        if (chunk.type !== 'settled') chunks.push(chunk);
      }

      expect(chunks[chunks.length - 1]).toEqual({
        type: 'result',
        sessionId: 'evt-thread-id',
        tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
      });
    });

    test('captured thread id flows through the turn.failed result', async () => {
      mockStartThread.mockReturnValue({ id: null, runStreamed: mockRunStreamed });
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield { type: 'thread.started', thread_id: 'evt-thread-id' };
          yield { type: 'turn.failed', error: { message: 'boom' } };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('x', '/workspace')) {
        if (chunk.type !== 'settled') chunks.push(chunk);
      }

      expect(chunks.find(c => c.type === 'result')).toMatchObject({
        type: 'result',
        sessionId: 'evt-thread-id',
        isError: true,
      });
    });

    test('captured thread id flows through the stream_incomplete result', async () => {
      mockStartThread.mockReturnValue({ id: null, runStreamed: mockRunStreamed });
      mockRunStreamed.mockResolvedValue({
        // Stream closes without turn.completed/turn.failed → fail-stop result.
        events: (async function* () {
          yield { type: 'thread.started', thread_id: 'evt-thread-id' };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('x', '/workspace')) {
        if (chunk.type !== 'settled') chunks.push(chunk);
      }

      expect(chunks.find(c => c.type === 'result')).toMatchObject({
        type: 'result',
        sessionId: 'evt-thread-id',
        isError: true,
        errorSubtype: 'codex_stream_incomplete',
      });
    });

    test('an empty thread.started thread_id keeps the snapshot id (guard)', async () => {
      // Default startThread snapshot id is 'new-thread-id'; an empty event id
      // must not overwrite it (and would otherwise warn, not emit sessionId: '').
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield { type: 'thread.started', thread_id: '' };
          yield { type: 'item.completed', item: { type: 'agent_message', text: 'ok' } };
          yield { type: 'turn.completed', usage: defaultUsage };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('x', '/workspace')) {
        if (chunk.type !== 'settled') chunks.push(chunk);
      }

      expect(chunks.find(c => c.type === 'result')).toMatchObject({
        type: 'result',
        sessionId: 'new-thread-id',
      });
    });

    /** The chunks a turn streams for the given Codex events, without the trailing `settled`. */
    async function streamOf(...events: unknown[]): Promise<MessageChunk[]> {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield* events;
        })(),
      });
      const chunks: MessageChunk[] = [];
      for await (const chunk of client.sendQuery('test prompt', '/workspace')) {
        if (chunk.type !== 'settled') chunks.push(chunk);
      }
      return chunks;
    }

    const turnCompleted = { type: 'turn.completed', usage: defaultUsage };
    const okResult: MessageChunk = {
      type: 'result',
      sessionId: 'new-thread-id',
      tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
    };

    test('a command_execution item is a tool call titled with the command', async () => {
      const command = { id: 'cmd-1', type: 'command_execution', command: 'npm test' };
      const chunks = await streamOf(
        { type: 'item.started', item: { ...command, status: 'in_progress' } },
        {
          type: 'item.completed',
          item: {
            ...command,
            status: 'completed',
            aggregated_output: 'tests passed\n',
            exit_code: 0,
          },
        },
        turnCompleted
      );

      expect(chunks).toEqual([
        {
          type: 'tool_call',
          toolCallId: 'cmd-1',
          name: 'command_execution',
          title: 'npm test',
          rawInput: { command: 'npm test' },
        },
        {
          type: 'tool_call_update',
          toolCallId: 'cmd-1',
          status: 'completed',
          output: 'tests passed\n',
          exitCode: 0,
        },
        okResult,
      ]);
    });

    test('a command that exits nonzero closes as failed with its exit code', async () => {
      const command = { id: 'cmd-2', type: 'command_execution', command: 'npm test' };
      const chunks = await streamOf(
        { type: 'item.started', item: { ...command, status: 'in_progress' } },
        {
          type: 'item.completed',
          // Codex reports the item completed even when the process failed.
          item: { ...command, status: 'completed', aggregated_output: 'failure\n', exit_code: 1 },
        },
        turnCompleted
      );

      expect(chunks[1]).toEqual({
        type: 'tool_call_update',
        toolCallId: 'cmd-2',
        status: 'failed',
        output: 'failure\n',
        exitCode: 1,
      });
    });

    test('command output past the contract cap is truncated and flagged', async () => {
      const command = { id: 'cmd-big', type: 'command_execution', command: 'cat big' };
      const chunks = await streamOf(
        {
          type: 'item.completed',
          item: {
            ...command,
            status: 'completed',
            aggregated_output: 'x'.repeat(TOOL_OUTPUT_MAX_CHARS + 10),
            exit_code: 0,
          },
        },
        turnCompleted
      );

      expect(chunks[1]).toMatchObject({
        type: 'tool_call_update',
        toolCallId: 'cmd-big',
        status: 'completed',
        output: 'x'.repeat(TOOL_OUTPUT_MAX_CHARS),
        outputTruncated: true,
      });
    });

    test('reasoning items stream as agent_thought_chunk', async () => {
      const chunks = await streamOf(
        { type: 'item.completed', item: { id: 'r-1', type: 'reasoning', text: 'Let me think' } },
        turnCompleted
      );

      expect(chunks[0]).toEqual({ type: 'agent_thought_chunk', text: 'Let me think' });
    });

    test('a web_search item is a tool call titled with the query', async () => {
      const search = { id: 'search-1', type: 'web_search', query: 'codex sdk' };
      const chunks = await streamOf(
        { type: 'item.started', item: search },
        { type: 'item.completed', item: search },
        turnCompleted
      );

      expect(chunks).toEqual([
        {
          type: 'tool_call',
          toolCallId: 'search-1',
          name: 'web_search',
          title: 'codex sdk',
          rawInput: { query: 'codex sdk' },
        },
        { type: 'tool_call_update', toolCallId: 'search-1', status: 'completed' },
        okResult,
      ]);
    });

    test('todo_list items stream nothing', async () => {
      const chunks = await streamOf(
        {
          type: 'item.completed',
          item: { id: 'todo-1', type: 'todo_list', items: [{ text: 'Scan', completed: false }] },
        },
        turnCompleted
      );

      expect(chunks).toEqual([okResult]);
    });

    test('a file_change item is a tool call opened and closed on completion', async () => {
      const changes = [
        { kind: 'add', path: 'src/new.ts' },
        { kind: 'update', path: 'src/app.ts' },
      ];
      const chunks = await streamOf(
        {
          type: 'item.completed',
          item: { id: 'fc-1', type: 'file_change', status: 'completed', changes },
        },
        {
          type: 'item.completed',
          item: { id: 'fc-2', type: 'file_change', status: 'failed', changes },
        },
        {
          type: 'item.completed',
          item: {
            id: 'fc-3',
            type: 'file_change',
            status: 'failed',
            changes,
            error: { message: 'patch did not apply' },
          },
        },
        turnCompleted
      );

      expect(chunks).toEqual([
        { type: 'tool_call', toolCallId: 'fc-1', name: 'file_change', rawInput: { changes } },
        { type: 'tool_call_update', toolCallId: 'fc-1', status: 'completed' },
        { type: 'tool_call', toolCallId: 'fc-2', name: 'file_change', rawInput: { changes } },
        { type: 'tool_call_update', toolCallId: 'fc-2', status: 'failed' },
        { type: 'tool_call', toolCallId: 'fc-3', name: 'file_change', rawInput: { changes } },
        {
          type: 'tool_call_update',
          toolCallId: 'fc-3',
          status: 'failed',
          output: 'patch did not apply',
        },
        okResult,
      ]);
    });

    test('an mcp_tool_call is named for the tool, titled server/tool, and keeps its arguments', async () => {
      const call = {
        id: 'mcp-1',
        type: 'mcp_tool_call',
        server: 'fs',
        tool: 'readFile',
        arguments: { path: 'README.md', limit: 10 },
      };
      const content = [{ type: 'text', text: 'file contents' }];
      const chunks = await streamOf(
        { type: 'item.started', item: { ...call, status: 'in_progress' } },
        { type: 'item.completed', item: { ...call, status: 'completed', result: { content } } },
        { type: 'item.started', item: { ...call, id: 'mcp-2', status: 'in_progress' } },
        {
          type: 'item.completed',
          item: { ...call, id: 'mcp-2', status: 'failed', error: { message: 'Permission denied' } },
        },
        turnCompleted
      );

      expect(chunks).toEqual([
        {
          type: 'tool_call',
          toolCallId: 'mcp-1',
          name: 'readFile',
          title: 'fs/readFile',
          rawInput: { path: 'README.md', limit: 10 },
        },
        {
          type: 'tool_call_update',
          toolCallId: 'mcp-1',
          status: 'completed',
          output: JSON.stringify(content),
        },
        {
          type: 'tool_call',
          toolCallId: 'mcp-2',
          name: 'readFile',
          title: 'fs/readFile',
          rawInput: { path: 'README.md', limit: 10 },
        },
        {
          type: 'tool_call_update',
          toolCallId: 'mcp-2',
          status: 'failed',
          output: 'Permission denied',
        },
        okResult,
      ]);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ server: 'fs', tool: 'readFile' }),
        'mcp_tool_call_failed'
      );
    });

    test('a stream that ends mid-command closes the command as cancelled before the failure', async () => {
      const chunks = await streamOf({
        type: 'item.started',
        item: {
          id: 'cmd-open',
          type: 'command_execution',
          command: 'sleep 60',
          status: 'in_progress',
        },
      });

      expect(chunks.map(c => c.type)).toEqual(['tool_call', 'tool_call_update', 'result']);
      expect(chunks[1]).toEqual({
        type: 'tool_call_update',
        toolCallId: 'cmd-open',
        status: 'cancelled',
      });
      expect(chunks[2]).toMatchObject({ type: 'result', isError: true });
    });

    test('a turn that completes with a command still running closes it as cancelled', async () => {
      const chunks = await streamOf(
        {
          type: 'item.started',
          item: {
            id: 'cmd-open',
            type: 'command_execution',
            command: 'sleep 60',
            status: 'in_progress',
          },
        },
        turnCompleted
      );

      expect(chunks).toEqual([
        expect.objectContaining({ type: 'tool_call', toolCallId: 'cmd-open' }),
        { type: 'tool_call_update', toolCallId: 'cmd-open', status: 'cancelled' },
        okResult,
      ]);
    });

    test('creates new thread with sandbox/network settings', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield { type: 'turn.completed', usage: defaultUsage };
        })(),
      });

      for await (const _ of client.sendQuery('test prompt', '/my/workspace')) {
        // consume
      }

      expect(mockStartThread).toHaveBeenCalledWith(
        expect.objectContaining({
          workingDirectory: '/my/workspace',
          skipGitRepoCheck: true,
          sandboxMode: 'danger-full-access',
          networkAccessEnabled: true,
          approvalPolicy: 'never',
        })
      );
    });

    test('resumes existing thread with sandbox/network settings', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield { type: 'turn.completed', usage: defaultUsage };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test prompt', '/workspace', 'existing-thread')) {
        if (chunk.type !== 'settled') chunks.push(chunk);
      }

      expect(mockResumeThread).toHaveBeenCalledWith(
        'existing-thread',
        expect.objectContaining({
          workingDirectory: '/workspace',
          skipGitRepoCheck: true,
          sandboxMode: 'danger-full-access',
          networkAccessEnabled: true,
          approvalPolicy: 'never',
        })
      );
      expect(mockStartThread).not.toHaveBeenCalled();
      // No thread.started re-fires on resume → the snapshot (resumeThread's id) survives.
      expect(chunks.find(c => c.type === 'result')).toMatchObject({
        sessionId: 'resumed-thread-id',
      });
    });

    test('falls back to new thread when resume fails and notifies user', async () => {
      const resumeError = new Error('Thread not found');
      mockResumeThread.mockImplementation(() => {
        throw resumeError;
      });
      mockStartThread.mockReturnValue(createMockThread('fallback-thread'));

      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield { type: 'turn.completed', usage: defaultUsage };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace', 'bad-thread-id')) {
        if (chunk.type !== 'settled') chunks.push(chunk);
      }

      expect(mockResumeThread).toHaveBeenCalled();
      expect(mockStartThread).toHaveBeenCalledWith(
        expect.objectContaining({
          workingDirectory: '/workspace',
          skipGitRepoCheck: true,
          sandboxMode: 'danger-full-access',
          networkAccessEnabled: true,
          approvalPolicy: 'never',
        })
      );
      expect(mockLogger.error).toHaveBeenCalledWith(
        { err: resumeError, sessionIdPreview: 'bad-thre' },
        'resume_thread_failed'
      );
      // Verify user is notified about session loss
      expect(chunks[0]).toEqual({
        type: 'warning',
        code: 'codex.resume_failed',
        message: expect.stringContaining('Could not resume previous session'),
      });
      expect(chunks[1]).toEqual({
        type: 'result',
        sessionId: 'fallback-thread',
        tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
        // A requested resume that fell back to a fresh thread is reported as cold.
        resumed: false,
      });
    });

    test('reports resumed:true on the result when an existing thread resumes', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield { type: 'turn.completed', usage: defaultUsage };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace', 'existing-thread')) {
        if (chunk.type !== 'settled') chunks.push(chunk);
      }

      expect(chunks.find(c => c.type === 'result')).toMatchObject({ resumed: true });
    });

    test('passes model and codex options via assistantConfig to thread options', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield { type: 'turn.completed', usage: defaultUsage };
        })(),
      });

      for await (const _ of client.sendQuery('test prompt', '/workspace', undefined, {
        model: 'gpt-5.6-sol',
        assistantConfig: {
          modelReasoningEffort: 'ultra',
          webSearchMode: 'live',
          additionalDirectories: ['/other/repo'],
        },
      })) {
        // consume
      }

      expect(mockStartThread).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'gpt-5.6-sol',
          modelReasoningEffort: 'ultra',
          webSearchMode: 'live',
          additionalDirectories: ['/other/repo'],
        })
      );
    });

    // #2556: `effort:` is Archon's one reasoning-depth spelling. Codex reads it
    // off nodeConfig like every other effort-capable provider and translates it
    // to the SDK's `modelReasoningEffort` here, instead of the engine having to
    // know which field Codex wants.
    test('applies nodeConfig.effort as modelReasoningEffort', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield { type: 'turn.completed', usage: defaultUsage };
        })(),
      });

      for await (const _ of client.sendQuery('test prompt', '/workspace', undefined, {
        nodeConfig: { nodeId: 'n1', effort: 'high' },
      })) {
        // consume
      }

      expect(mockStartThread).toHaveBeenCalledWith(
        expect.objectContaining({ modelReasoningEffort: 'high' })
      );
    });

    test('nodeConfig.effort beats assistants.codex.modelReasoningEffort', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield { type: 'turn.completed', usage: defaultUsage };
        })(),
      });

      for await (const _ of client.sendQuery('test prompt', '/workspace', undefined, {
        assistantConfig: { modelReasoningEffort: 'low' },
        nodeConfig: { nodeId: 'n1', effort: 'minimal' },
      })) {
        // consume
      }

      expect(mockStartThread).toHaveBeenCalledWith(
        expect.objectContaining({ modelReasoningEffort: 'minimal' })
      );
    });

    test.each(['max', 'ultra', 'persistent'] as const)(
      'passes `effort: %s` to the SDK natively',
      async effort => {
        mockRunStreamed.mockResolvedValue({
          events: (async function* () {
            yield { type: 'turn.completed', usage: defaultUsage };
          })(),
        });

        for await (const _ of client.sendQuery('test prompt', '/workspace', undefined, {
          nodeConfig: { nodeId: 'n1', effort },
        })) {
          // consume
        }
        expect(mockStartThread).toHaveBeenCalledWith(
          expect.objectContaining({ modelReasoningEffort: effort })
        );
      }
    );

    test('normalizes outputFormat schema (adds additionalProperties:false) before sending as outputSchema', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield { type: 'turn.completed', usage: defaultUsage };
        })(),
      });

      const schema = {
        type: 'object',
        properties: {
          summary: { type: 'string' },
          meta: { type: 'object', properties: { tag: { type: 'string' } } },
        },
        required: ['summary'],
      };

      const chunks = [];
      for await (const chunk of client.sendQuery('test prompt', '/workspace', undefined, {
        outputFormat: { type: 'json_schema', schema },
      })) {
        if (chunk.type !== 'settled') chunks.push(chunk);
      }

      // OpenAI strict-mode requires additionalProperties:false on every object,
      // including the nested `meta` object — verifies recursion through the
      // real provider path. See issue #1843.
      expect(mockRunStreamed).toHaveBeenCalledWith(
        'test prompt',
        expect.objectContaining({
          outputSchema: {
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
          },
        })
      );
    });

    test('normalizes nodeConfig.output_format schema before sending as outputSchema', async () => {
      // The DAG executor populates nodeConfig.output_format (not outputFormat),
      // so this is the actual path from issue #1843. Pin the normalized schema
      // at the SDK boundary, not just the downstream parse.
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield { type: 'turn.completed', usage: defaultUsage };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test prompt', '/workspace', undefined, {
        nodeConfig: {
          output_format: {
            type: 'object',
            properties: {
              verdict: { type: 'string' },
              meta: { type: 'object', properties: { score: { type: 'number' } } },
            },
          },
        },
      })) {
        if (chunk.type !== 'settled') chunks.push(chunk);
      }

      expect(mockRunStreamed).toHaveBeenCalledWith(
        'test prompt',
        expect.objectContaining({
          outputSchema: {
            type: 'object',
            properties: {
              verdict: { type: 'string' },
              meta: {
                type: 'object',
                properties: { score: { type: 'number' } },
                additionalProperties: false,
              },
            },
            additionalProperties: false,
          },
        })
      );
    });

    test('creates a per-call Codex instance when env is provided', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield { type: 'turn.completed', usage: defaultUsage };
        })(),
      });

      for await (const _ of client.sendQuery('test prompt', '/workspace', undefined, {
        env: { MY_SECRET: 'abc123' },
      })) {
        // consume
      }

      expect(MockCodex).toHaveBeenCalledWith(
        expect.objectContaining({
          env: expect.objectContaining({ MY_SECRET: 'abc123' }),
        })
      );
      expect(mockStartThread).toHaveBeenCalledTimes(1);
    });

    test('builds env by preserving process vars and letting request env win on collisions', async () => {
      const originalPath = process.env.PATH;
      const originalArchonEnv = process.env.ARCHON_CODEX_TEST_ENV;
      process.env.PATH = 'from-process';
      process.env.ARCHON_CODEX_TEST_ENV = 'kept-from-process';

      try {
        mockRunStreamed.mockResolvedValue({
          events: (async function* () {
            yield { type: 'turn.completed', usage: defaultUsage };
          })(),
        });

        for await (const _ of client.sendQuery('test prompt', '/workspace', undefined, {
          env: { PATH: 'from-request', MY_SECRET: 'abc123' },
        })) {
          // consume
        }

        expect(MockCodex).toHaveBeenCalledWith(
          expect.objectContaining({
            env: expect.objectContaining({
              PATH: 'from-request',
              ARCHON_CODEX_TEST_ENV: 'kept-from-process',
              MY_SECRET: 'abc123',
            }),
          })
        );
      } finally {
        if (originalPath === undefined) {
          delete process.env.PATH;
        } else {
          process.env.PATH = originalPath;
        }
        if (originalArchonEnv === undefined) {
          delete process.env.ARCHON_CODEX_TEST_ENV;
        } else {
          process.env.ARCHON_CODEX_TEST_ENV = originalArchonEnv;
        }
      }
    });

    test('passes workflow MCP config as Codex mcp_servers overrides', async () => {
      const testDir = await mkdtemp(join(tmpdir(), 'codex-provider-mcp-'));
      const originalToken = process.env.ARCHON_CODEX_MCP_TOKEN;
      process.env.ARCHON_CODEX_MCP_TOKEN = 'token-from-process';

      try {
        await writeFile(
          join(testDir, 'mcp.json'),
          JSON.stringify({
            figma: {
              type: 'http',
              url: 'http://127.0.0.1:3845/mcp',
              headers: { Authorization: 'Bearer $ARCHON_CODEX_MCP_TOKEN' },
              startup_timeout_sec: 20,
            },
            local: {
              type: 'stdio',
              command: 'npx',
              args: ['-y', 'figma-mcp'],
              env: { TOKEN: '$ARCHON_CODEX_MCP_TOKEN' },
            },
          })
        );

        mockRunStreamed.mockResolvedValue({
          events: (async function* () {
            yield { type: 'turn.completed', usage: defaultUsage };
          })(),
        });

        for await (const _ of client.sendQuery('test prompt', testDir, undefined, {
          nodeConfig: { nodeId: 'notify', mcp: 'mcp.json' },
        })) {
          // consume
        }

        expect(MockCodex).toHaveBeenCalledWith(
          expect.objectContaining({
            config: expect.objectContaining({
              skills: { include_instructions: false },
              mcp_servers: expect.objectContaining({
                figma: expect.objectContaining({
                  url: 'http://127.0.0.1:3845/mcp',
                  http_headers: { Authorization: 'Bearer token-from-process' },
                  startup_timeout_sec: 20,
                }),
                local: expect.objectContaining({
                  command: 'npx',
                  args: ['-y', 'figma-mcp'],
                  env: { TOKEN: 'token-from-process' },
                }),
              }),
            }),
          })
        );
        expect(mockLogger.info).toHaveBeenCalledWith(
          { serverNames: ['figma', 'local'], mcpPath: 'mcp.json' },
          'codex.mcp_config_loaded'
        );
      } finally {
        if (originalToken === undefined) {
          delete process.env.ARCHON_CODEX_MCP_TOKEN;
        } else {
          process.env.ARCHON_CODEX_MCP_TOKEN = originalToken;
        }
        await rm(testDir, { recursive: true, force: true });
      }
    });

    test('uses request env when expanding workflow MCP config variables', async () => {
      const testDir = await mkdtemp(join(tmpdir(), 'codex-provider-mcp-env-'));

      try {
        await writeFile(
          join(testDir, 'mcp.json'),
          JSON.stringify({
            figma: {
              command: 'figma-mcp',
              env: { TOKEN: '$FIGMA_TOKEN' },
            },
          })
        );

        mockRunStreamed.mockResolvedValue({
          events: (async function* () {
            yield { type: 'turn.completed', usage: defaultUsage };
          })(),
        });

        for await (const _ of client.sendQuery('test prompt', testDir, undefined, {
          env: { FIGMA_TOKEN: 'from-codebase-env' },
          nodeConfig: { mcp: 'mcp.json' },
        })) {
          // consume
        }

        expect(MockCodex).toHaveBeenCalledWith(
          expect.objectContaining({
            config: expect.objectContaining({
              mcp_servers: expect.objectContaining({
                figma: expect.objectContaining({
                  command: 'figma-mcp',
                  env: { TOKEN: 'from-codebase-env' },
                }),
              }),
            }),
          })
        );
      } finally {
        await rm(testDir, { recursive: true, force: true });
      }
    });

    test('warns when the MCP config references undefined env vars', async () => {
      const testDir = await mkdtemp(join(tmpdir(), 'codex-provider-mcp-warning-'));
      delete process.env.ARCHON_CODEX_MISSING_TOKEN;

      try {
        await writeFile(
          join(testDir, 'mcp.json'),
          JSON.stringify({
            figma: {
              command: 'figma-mcp',
              env: { TOKEN: '$ARCHON_CODEX_MISSING_TOKEN' },
            },
          })
        );
        mockRunStreamed.mockResolvedValue({
          events: (async function* () {
            yield { type: 'turn.completed', usage: defaultUsage };
          })(),
        });

        const chunks = [];
        for await (const chunk of client.sendQuery('test prompt', testDir, undefined, {
          nodeConfig: { mcp: 'mcp.json' },
        })) {
          if (chunk.type !== 'settled') chunks.push(chunk);
        }

        expect(chunks[0]).toEqual({
          type: 'warning',
          code: 'codex.mcp_env_vars_missing',
          message:
            'MCP config references undefined env vars: ARCHON_CODEX_MISSING_TOKEN. These will be empty strings - MCP servers may fail to authenticate.',
        });
      } finally {
        await rm(testDir, { recursive: true, force: true });
      }
    });

    test('reuses the singleton Codex instance across sequential calls without env', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield { type: 'turn.completed', usage: defaultUsage };
        })(),
      });

      for await (const _ of client.sendQuery('first prompt', '/workspace')) {
        // consume
      }
      for await (const _ of client.sendQuery('second prompt', '/workspace')) {
        // consume
      }

      expect(MockCodex).toHaveBeenCalledTimes(1);
    });

    test('a per-call Codex constructor failure is an unknown failure', async () => {
      MockCodex.mockImplementationOnce(() => {
        throw new Error('constructor failed');
      });

      const consumeGenerator = () =>
        client.sendQuery('test prompt', '/workspace', undefined, {
          env: { MY_SECRET: 'abc123' },
        });

      expect(await codexFailure(consumeGenerator())).toEqual({
        class: 'unknown',
        evidence: 'constructor failed',
      });
    });

    test('breaks on turn.completed event', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield { type: 'item.completed', item: { type: 'agent_message', text: 'Before turn' } };
          yield { type: 'turn.completed', usage: defaultUsage };
          // This should NOT be yielded due to break
          yield { type: 'item.completed', item: { type: 'agent_message', text: 'After turn' } };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        if (chunk.type !== 'settled') chunks.push(chunk);
      }

      // Only first message and result should be yielded
      expect(chunks).toHaveLength(2);
      expect(chunks[0]).toEqual({ type: 'agent_message_chunk', text: 'Before turn' });
      expect(chunks[1]).toMatchObject({ type: 'result', sessionId: 'new-thread-id' });
    });

    test('logs progress for item.started and item.completed events', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield {
            type: 'item.started',
            item: { id: 'item-1', type: 'command_execution', command: 'npm test' },
          };
          yield {
            type: 'item.completed',
            item: { id: 'item-1', type: 'command_execution', command: 'npm test' },
          };
          yield { type: 'turn.completed', usage: defaultUsage };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        if (chunk.type !== 'settled') chunks.push(chunk);
      }

      expect(mockLogger.debug).toHaveBeenCalledWith(
        { eventType: 'item.started', itemType: 'command_execution', itemId: 'item-1' },
        'item_started'
      );

      expect(mockLogger.debug).toHaveBeenCalledWith(
        {
          eventType: 'item.completed',
          itemType: 'command_execution',
          itemId: 'item-1',
          command: 'npm test',
        },
        'item_completed'
      );
    });

    test('deduplicates repeated tool lifecycle events by item id', async () => {
      const started = {
        type: 'item.started',
        item: { id: 'cmd-duplicate', type: 'command_execution', command: 'npm test' },
      };
      const completed = {
        type: 'item.completed',
        item: {
          id: 'cmd-duplicate',
          type: 'command_execution',
          command: 'npm test',
          aggregated_output: 'done',
          exit_code: 0,
        },
      };
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield started;
          yield started;
          yield completed;
          yield completed;
          yield { type: 'turn.completed', usage: defaultUsage };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        if (chunk.type !== 'settled') chunks.push(chunk);
      }

      expect(chunks.filter(chunk => chunk.type === 'tool_call')).toHaveLength(1);
      expect(chunks.filter(chunk => chunk.type === 'tool_call_update')).toHaveLength(1);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        { itemId: 'cmd-duplicate', itemType: 'command_execution' },
        'tool_item_duplicate_completion'
      );
    });

    test('a tool completion that arrives without a start opens the call before closing it', async () => {
      const chunks = await streamOf(
        {
          type: 'item.completed',
          item: {
            id: 'cmd-completed-only',
            type: 'command_execution',
            command: 'npm test',
            status: 'completed',
            aggregated_output: 'done',
            exit_code: 0,
          },
        },
        turnCompleted
      );

      expect(chunks.map(c => c.type)).toEqual(['tool_call', 'tool_call_update', 'result']);
      expect(chunks[0]).toMatchObject({ toolCallId: 'cmd-completed-only', title: 'npm test' });
    });

    test('error events followed by turn.completed yield a clean result (recoverable)', async () => {
      // SDK error events that are followed by turn.completed indicate the SDK
      // recovered internally: the error stays in the log, not in the stream.
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield { type: 'error', message: 'Transient blip' };
          yield { type: 'turn.completed', usage: defaultUsage };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        if (chunk.type !== 'settled') chunks.push(chunk);
      }

      expect(chunks).toEqual([
        {
          type: 'result',
          sessionId: 'new-thread-id',
          tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
        },
      ]);
      expect(mockLogger.error).toHaveBeenCalledWith({ message: 'Transient blip' }, 'stream_error');
    });

    test('error event followed by stream close yields fail-stop result.isError', async () => {
      // The SDK sends an error event (e.g. "model not supported") and the
      // iterator closes without turn.completed or turn.failed. The provider
      // synthesizes a fail-stop result so the dag-executor's msg.isError
      // branch catches the failure \u2014 same chunk shape as Claude.
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield { type: 'error', message: "'opus[1m]' model is not supported" };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        if (chunk.type !== 'settled') chunks.push(chunk);
      }

      expect(chunks).toEqual([
        {
          type: 'result',
          sessionId: 'new-thread-id',
          isError: true,
          errorSubtype: 'codex_stream_incomplete',
          errors: ["'opus[1m]' model is not supported"],
          failure: { class: 'unknown', evidence: "'opus[1m]' model is not supported" },
        },
      ]);
    });

    test('errors the SDK recovered from never reach the stream', async () => {
      const chunks = await streamOf(
        { type: 'error', message: 'mcp client connection timeout' },
        { type: 'error', message: 'Reconnecting... 1/5' },
        turnCompleted
      );

      expect(chunks).toEqual([okResult]);
    });

    test('every error is the evidence when the stream closes without a terminal event', async () => {
      const chunks = await streamOf(
        { type: 'error', message: 'Reconnecting... 1/5' },
        { type: 'error', message: 'MCP client transport closed' }
      );

      expect(chunks.at(-1)).toMatchObject({
        type: 'result',
        isError: true,
        errorSubtype: 'codex_stream_incomplete',
        failure: {
          class: 'unknown',
          evidence: 'Reconnecting... 1/5\nMCP client transport closed',
        },
      });
    });

    test('turn.failed yields result.isError with codex_turn_failed subtype', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield { type: 'turn.failed', error: { message: 'Rate limit exceeded' } };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        if (chunk.type !== 'settled') chunks.push(chunk);
      }

      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toEqual({
        type: 'result',
        sessionId: 'new-thread-id',
        isError: true,
        errorSubtype: 'codex_turn_failed',
        errors: ['Rate limit exceeded'],
        failure: { class: 'unknown', evidence: 'Rate limit exceeded' },
      });
      expect(mockLogger.error).toHaveBeenCalledWith(
        { errorMessage: 'Rate limit exceeded' },
        'turn_failed'
      );
    });

    test('turn.failed without error message yields fail-stop with Unknown error', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield { type: 'turn.failed', error: null };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        if (chunk.type !== 'settled') chunks.push(chunk);
      }

      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toEqual({
        type: 'result',
        sessionId: 'new-thread-id',
        isError: true,
        errorSubtype: 'codex_turn_failed',
        errors: ['Unknown error'],
        failure: { class: 'unknown', evidence: 'Unknown error' },
      });
      expect(mockLogger.error).toHaveBeenCalledWith(
        { errorMessage: 'Unknown error' },
        'turn_failed'
      );
    });

    test('iterator that closes with zero events yields codex_stream_incomplete with default message', async () => {
      // Bare-stream-close fallback: no error event, no terminal event,
      // iterator just ends. Locks in the default message used when there is
      // no captured non-MCP error to attribute the failure to.
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          // no events
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        if (chunk.type !== 'settled') chunks.push(chunk);
      }

      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toEqual({
        type: 'result',
        sessionId: 'new-thread-id',
        isError: true,
        errorSubtype: 'codex_stream_incomplete',
        errors: ['Codex stream closed without turn.completed or turn.failed'],
        failure: {
          class: 'unknown',
          evidence: 'Codex stream closed without turn.completed or turn.failed',
        },
      });
    });

    test('a runStreamed error is an unknown failure with the vendor text', async () => {
      const networkError = new Error('Network failure');
      mockRunStreamed.mockRejectedValue(networkError);

      expect(await codexFailure(client.sendQuery('test', '/workspace'))).toEqual({
        class: 'unknown',
        evidence: 'Network failure',
      });
      // One turn, one SDK call: retry belongs to the engine.
      expect(mockRunStreamed).toHaveBeenCalledTimes(1);

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: networkError }),
        'query_error'
      );
    });

    test('adds actionable model-access advice to the evidence for an unavailable model', async () => {
      mockRunStreamed.mockRejectedValue(new Error('403 Forbidden: model not available'));

      const failure = await codexFailure(
        client.sendQuery('test', '/workspace', undefined, { model: 'gpt-5.3-codex' })
      );
      expect(failure.class).toBe('unknown');
      expect(failure.evidence).toContain('Model "gpt-5.3-codex" is not available for your account');
      expect(failure.evidence).toContain('model: gpt-5.6-sol');
      // The advice never replaces the vendor's own words.
      expect(failure.evidence).toContain('403 Forbidden: model not available');
    });

    test('uses generic dashboard guidance when fallback mapping is unknown', async () => {
      mockRunStreamed.mockRejectedValue(new Error('model not available'));

      const failure = await codexFailure(
        client.sendQuery('test', '/workspace', undefined, { model: 'o5-pro' })
      );
      expect(failure.evidence).toContain('Model "o5-pro" is not available for your account');
      expect(failure.evidence).toContain('update your model in ~/.archon/config.yaml');
    });

    test('ignores items that carry nothing to stream', async () => {
      const chunks = await streamOf(
        { type: 'item.completed', item: { id: 'm-1', type: 'agent_message', text: '' } },
        { type: 'item.completed', item: { id: 'r-1', type: 'reasoning', text: '' } },
        { type: 'item.completed', item: { id: 't-1', type: 'todo_list', items: [] } },
        { type: 'item.completed', item: { id: 'e-1', type: 'error', message: 'non-fatal' } },
        turnCompleted
      );

      expect(chunks).toEqual([okResult]);
    });

    describe('systemPrompt delivery (issue #1837)', () => {
      // The Codex SDK has no instructions/system-prompt channel, so the
      // provider must fold systemPrompt into the prompt string it hands to
      // thread.runStreamed. These tests assert on that SDK boundary.
      const seedRun = (): void => {
        mockRunStreamed.mockResolvedValue({
          events: (async function* () {
            yield { type: 'turn.completed', usage: defaultUsage };
          })(),
        });
      };

      const drain = async (gen: AsyncGenerator<unknown>): Promise<void> => {
        for await (const _ of gen) {
          // consume
        }
      };

      test('prepends a string systemPrompt to the prompt with a --- delimiter', async () => {
        seedRun();

        await drain(
          client.sendQuery('test prompt', '/workspace', undefined, {
            systemPrompt: 'AAA routing rules',
          })
        );

        expect(mockRunStreamed).toHaveBeenCalledWith(
          'AAA routing rules\n\n---\n\ntest prompt',
          expect.anything()
        );
      });

      test('joins a string[] systemPrompt with blank lines before prepending', async () => {
        seedRun();

        await drain(
          client.sendQuery('test prompt', '/workspace', undefined, {
            systemPrompt: ['part one', 'part two'],
          })
        );

        expect(mockRunStreamed).toHaveBeenCalledWith(
          'part one\n\npart two\n\n---\n\ntest prompt',
          expect.anything()
        );
      });

      test('drops a Claude-specific preset object with a WARN and keeps the prompt unchanged', async () => {
        seedRun();

        await drain(
          client.sendQuery('test prompt', '/workspace', undefined, {
            systemPrompt: { type: 'preset', preset: 'claude_code', append: 'extra' },
          })
        );

        expect(mockRunStreamed).toHaveBeenCalledWith('test prompt', expect.anything());
        expect(mockLogger.warn).toHaveBeenCalledWith(
          expect.objectContaining({ systemPromptType: 'object' }),
          'codex.system_prompt_dropped_preset'
        );
      });

      test('passes the prompt unchanged when no systemPrompt is set', async () => {
        seedRun();

        await drain(client.sendQuery('test prompt', '/workspace'));

        expect(mockRunStreamed).toHaveBeenCalledWith('test prompt', expect.anything());
      });

      test('passes the prompt unchanged when systemPrompt is whitespace-only', async () => {
        seedRun();

        await drain(
          client.sendQuery('test prompt', '/workspace', undefined, {
            systemPrompt: '   ',
          })
        );

        expect(mockRunStreamed).toHaveBeenCalledWith('test prompt', expect.anything());
      });

      test('honors node-level nodeConfig.systemPrompt (workflow path)', async () => {
        seedRun();

        await drain(
          client.sendQuery('test prompt', '/workspace', undefined, {
            nodeConfig: { systemPrompt: 'node-level instructions' },
          })
        );

        expect(mockRunStreamed).toHaveBeenCalledWith(
          'node-level instructions\n\n---\n\ntest prompt',
          expect.anything()
        );
      });

      test('request-level systemPrompt wins over nodeConfig.systemPrompt', async () => {
        seedRun();

        await drain(
          client.sendQuery('test prompt', '/workspace', undefined, {
            systemPrompt: 'request-level',
            nodeConfig: { systemPrompt: 'node-level' },
          })
        );

        expect(mockRunStreamed).toHaveBeenCalledWith(
          'request-level\n\n---\n\ntest prompt',
          expect.anything()
        );
      });

      test('prepends on resumed threads too (every turn, not first turn only)', async () => {
        seedRun();

        await drain(
          client.sendQuery('follow-up prompt', '/workspace', 'existing-session-id', {
            systemPrompt: 'AAA routing rules',
          })
        );

        expect(mockResumeThread).toHaveBeenCalledWith('existing-session-id', expect.anything());
        expect(mockRunStreamed).toHaveBeenCalledWith(
          'AAA routing rules\n\n---\n\nfollow-up prompt',
          expect.anything()
        );
      });
    });

    describe('typed failures (#3524)', () => {
      // The Codex SDK reports every failure as a bare message string, so no failure
      // can be classified from a structured signal: each is `unknown`, whatever the
      // words say, and the words are kept as evidence.
      test.each([
        [
          'a turn.failed event',
          [{ type: 'turn.failed', error: { message: 'stream error: 429 Too Many Requests' } }],
          'stream error: 429 Too Many Requests',
        ],
        [
          'an error event then stream close',
          [{ type: 'error', message: 'unauthorized: 401' }],
          'unauthorized: 401',
        ],
      ])('%s reports an unknown failure with the vendor text', async (_label, events, evidence) => {
        mockRunStreamed.mockResolvedValue({
          events: (async function* () {
            yield* events;
          })(),
        });

        expect(await codexFailure(client.sendQuery('test', '/workspace'))).toEqual({
          class: 'unknown',
          evidence,
        });
        expect(mockRunStreamed).toHaveBeenCalledTimes(1);
      });

      test('a crashed subprocess is reported once, not retried', async () => {
        mockRunStreamed.mockRejectedValue(
          new Error('Codex Exec exited with code 1: Reading prompt from stdin...')
        );

        const chunks: MessageChunk[] = [];
        for await (const chunk of client.sendQuery('test', '/workspace')) {
          if (chunk.type !== 'settled') chunks.push(chunk);
        }

        expect(chunks.filter(c => c.type === 'result')).toHaveLength(1);
        expect(chunks.at(-1)).toMatchObject({
          type: 'result',
          isError: true,
          failure: {
            class: 'unknown',
            evidence: 'Codex Exec exited with code 1: Reading prompt from stdin...',
          },
        });
        expect(mockStartThread).toHaveBeenCalledTimes(1);
        expect(mockRunStreamed).toHaveBeenCalledTimes(1);
      });

      test('passes the caller abort signal to the turn', async () => {
        mockRunStreamed.mockResolvedValue({
          events: (async function* () {
            yield { type: 'turn.completed', usage: defaultUsage };
          })(),
        });
        const controller = new AbortController();

        for await (const _ of client.sendQuery('test prompt', '/workspace', undefined, {
          abortSignal: controller.signal,
        })) {
          // consume
        }

        expect(mockRunStreamed.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
      });

      test('a caller abort throws Query aborted rather than reporting a failure', async () => {
        const controller = new AbortController();
        mockRunStreamed.mockImplementation(() => {
          controller.abort();
          return Promise.reject(new Error('The operation was aborted'));
        });

        const chunks: MessageChunk[] = [];
        let error: Error | undefined;
        try {
          for await (const chunk of client.sendQuery('test', '/workspace', undefined, {
            abortSignal: controller.signal,
          })) {
            if (chunk.type !== 'settled') chunks.push(chunk);
          }
        } catch (e) {
          error = e as Error;
        }
        expect(error?.message).toBe('Query aborted');
        expect(chunks.filter(c => c.type === 'result')).toHaveLength(0);
      });

      test('conforms to the provider contract', async () => {
        function turn(run: () => void): () => AsyncIterable<unknown> {
          return () => {
            run();
            return client.sendQuery('test', '/workspace');
          };
        }
        const violations = await runProviderConformance({
          capabilities: client.getCapabilities(),
          turns: [
            {
              name: 'completed turn',
              run: turn(() =>
                mockRunStreamed.mockResolvedValue({
                  events: (async function* () {
                    yield { type: 'item.completed', item: { type: 'agent_message', text: 'hi' } };
                    yield { type: 'turn.completed', usage: defaultUsage };
                  })(),
                })
              ),
            },
          ],
          failureCases: [
            {
              name: 'turn.failed',
              expected: 'unknown',
              evidence: 'Rate limit exceeded',
              run: turn(() =>
                mockRunStreamed.mockResolvedValue({
                  events: (async function* () {
                    yield { type: 'turn.failed', error: { message: 'Rate limit exceeded' } };
                  })(),
                })
              ),
            },
            {
              name: 'crashed subprocess',
              expected: 'unknown',
              evidence: 'exited with code 1',
              run: turn(() =>
                mockRunStreamed.mockRejectedValue(new Error('Codex Exec exited with code 1'))
              ),
            },
            {
              name: 'binary pin that does not exist',
              expected: 'misconfigured',
              evidence: 'does not exist',
              run: () => {
                resetCodexSingleton(); // an earlier case already built the client
                return client.sendQuery('test', '/workspace', undefined, {
                  assistantConfig: { codexBinaryPath: '/nonexistent/codex-bin' },
                });
              },
            },
            {
              name: 'binary missing at spawn',
              expected: 'misconfigured',
              evidence: 'spawn /pkg/codex ENOENT',
              run: turn(() =>
                mockRunStreamed.mockRejectedValue(
                  Object.assign(new Error('spawn /pkg/codex ENOENT'), { code: 'ENOENT' })
                )
              ),
            },
          ],
          toolTurn: {
            name: 'tool turn',
            // The turn completes while a second command still runs: the provider closes it.
            run: turn(() =>
              mockRunStreamed.mockResolvedValue({
                events: (async function* () {
                  const done = { id: 'cmd-1', type: 'command_execution', command: 'ls' };
                  const running = { id: 'cmd-2', type: 'command_execution', command: 'sleep 60' };
                  yield { type: 'item.started', item: { ...done, status: 'in_progress' } };
                  yield { type: 'item.started', item: { ...running, status: 'in_progress' } };
                  yield {
                    type: 'item.completed',
                    item: { ...done, status: 'completed', aggregated_output: 'a.ts', exit_code: 0 },
                  };
                  yield { type: 'turn.completed', usage: defaultUsage };
                })(),
              })
            ),
          },
        });
        expect(violations).toEqual([]);
      });
    });

    describe('structured output normalization', () => {
      test('populates structuredOutput on result when outputFormat is set and text is valid JSON', async () => {
        const jsonPayload = { status: 'ok', count: 42 };
        mockRunStreamed.mockResolvedValueOnce({
          events: (async function* () {
            yield {
              type: 'item.completed',
              item: { type: 'agent_message', id: 'msg-1', text: JSON.stringify(jsonPayload) },
            };
            yield { type: 'turn.completed', usage: defaultUsage };
          })(),
        });

        const chunks = [];
        for await (const chunk of client.sendQuery('test', '/tmp', undefined, {
          outputFormat: { type: 'json_schema', schema: { type: 'object' } },
        })) {
          if (chunk.type !== 'settled') chunks.push(chunk);
        }

        const resultChunk = chunks.find(c => c.type === 'result');
        expect(resultChunk).toBeDefined();
        expect(resultChunk!.type === 'result' && resultChunk!.structuredOutput).toEqual(
          jsonPayload
        );
      });

      test('warns when outputFormat is set but text is not valid JSON', async () => {
        mockRunStreamed.mockResolvedValueOnce({
          events: (async function* () {
            yield {
              type: 'item.completed',
              item: { type: 'agent_message', id: 'msg-1', text: 'not json at all' },
            };
            yield { type: 'turn.completed', usage: defaultUsage };
          })(),
        });

        const chunks = [];
        for await (const chunk of client.sendQuery('test', '/tmp', undefined, {
          outputFormat: { type: 'json_schema', schema: { type: 'object' } },
        })) {
          if (chunk.type !== 'settled') chunks.push(chunk);
        }

        expect(chunks).toContainEqual({
          type: 'warning',
          code: 'codex.structured_output_not_json',
          message: expect.stringContaining(
            'Structured output requested but Codex returned non-JSON'
          ),
        });

        const resultChunk = chunks.find(c => c.type === 'result');
        expect(resultChunk).toBeDefined();
        expect(resultChunk!.type === 'result' && resultChunk!.structuredOutput).toBeUndefined();
      });

      test('does not populate structuredOutput when outputFormat is not set', async () => {
        mockRunStreamed.mockResolvedValueOnce({
          events: (async function* () {
            yield {
              type: 'item.completed',
              item: { type: 'agent_message', id: 'msg-1', text: '{"valid":"json"}' },
            };
            yield { type: 'turn.completed', usage: defaultUsage };
          })(),
        });

        const chunks = [];
        for await (const chunk of client.sendQuery('test', '/tmp')) {
          if (chunk.type !== 'settled') chunks.push(chunk);
        }

        const resultChunk = chunks.find(c => c.type === 'result');
        expect(resultChunk).toBeDefined();
        expect(resultChunk!.type === 'result' && resultChunk!.structuredOutput).toBeUndefined();
      });

      test('handles nodeConfig.output_format path', async () => {
        const jsonPayload = { key: 'value' };
        mockRunStreamed.mockResolvedValueOnce({
          events: (async function* () {
            yield {
              type: 'item.completed',
              item: { type: 'agent_message', id: 'msg-1', text: JSON.stringify(jsonPayload) },
            };
            yield { type: 'turn.completed', usage: defaultUsage };
          })(),
        });

        const chunks = [];
        for await (const chunk of client.sendQuery('test', '/tmp', undefined, {
          nodeConfig: { output_format: { type: 'object' } },
        })) {
          if (chunk.type !== 'settled') chunks.push(chunk);
        }

        const resultChunk = chunks.find(c => c.type === 'result');
        expect(resultChunk).toBeDefined();
        expect(resultChunk!.type === 'result' && resultChunk!.structuredOutput).toEqual(
          jsonPayload
        );
      });

      test('uses last agent_message when multiple messages are emitted with output_format', async () => {
        const preamble = { claims_accurate: 'false', reasoning: "I'll verify first" };
        const finalAnswer = {
          claims_accurate: 'true',
          reasoning: 'Checked — claims are correct',
        };
        mockRunStreamed.mockResolvedValueOnce({
          events: (async function* () {
            yield {
              type: 'item.completed',
              item: { type: 'agent_message', id: 'msg-1', text: JSON.stringify(preamble) },
            };
            yield {
              type: 'item.completed',
              item: { type: 'agent_message', id: 'msg-2', text: JSON.stringify(finalAnswer) },
            };
            yield { type: 'turn.completed', usage: defaultUsage };
          })(),
        });

        const chunks = [];
        for await (const chunk of client.sendQuery('test', '/tmp', undefined, {
          outputFormat: { type: 'json_schema', schema: { type: 'object' } },
        })) {
          if (chunk.type !== 'settled') chunks.push(chunk);
        }

        const messageChunks = chunks.filter(c => c.type === 'agent_message_chunk');
        expect(messageChunks).toHaveLength(2);

        const resultChunk = chunks.find(c => c.type === 'result');
        expect(resultChunk).toBeDefined();
        expect(resultChunk!.type === 'result' && resultChunk!.structuredOutput).toEqual(
          finalAnswer
        );

        expect(chunks.some(c => c.type === 'warning')).toBe(false);
      });

      test('uses last agent_message when multiple messages are emitted via nodeConfig.output_format', async () => {
        // Workflow path: dag-executor sets nodeConfig.output_format from YAML
        // output_format. Locks the same last-wins fix on this entry point.
        const preamble = { claims_accurate: 'false', reasoning: 'draft' };
        const finalAnswer = { claims_accurate: 'true', reasoning: 'verified' };
        mockRunStreamed.mockResolvedValueOnce({
          events: (async function* () {
            yield {
              type: 'item.completed',
              item: { type: 'agent_message', id: 'msg-1', text: JSON.stringify(preamble) },
            };
            yield {
              type: 'item.completed',
              item: { type: 'agent_message', id: 'msg-2', text: JSON.stringify(finalAnswer) },
            };
            yield { type: 'turn.completed', usage: defaultUsage };
          })(),
        });

        const chunks = [];
        for await (const chunk of client.sendQuery('test', '/tmp', undefined, {
          nodeConfig: { output_format: { type: 'object' } },
        })) {
          if (chunk.type !== 'settled') chunks.push(chunk);
        }

        const resultChunk = chunks.find(c => c.type === 'result');
        expect(resultChunk).toBeDefined();
        expect(resultChunk!.type === 'result' && resultChunk!.structuredOutput).toEqual(
          finalAnswer
        );
      });
    });
  });
});

// ─── Behavioral regression tests (black-box via sendQuery) ───────────────

describe('sendQuery decomposition behaviors', () => {
  let client: CodexProvider;

  beforeEach(() => {
    client = new CodexProvider();
    mockStartThread.mockClear();
    mockResumeThread.mockClear();
    mockRunStreamed.mockClear();
    mockLogger.info.mockClear();
    mockLogger.warn.mockClear();
    mockLogger.error.mockClear();
    mockLogger.debug.mockClear();

    mockStartThread.mockReturnValue(createMockThread('new-thread-id'));
    mockResumeThread.mockReturnValue(createMockThread('resumed-thread-id'));
  });

  test('abort signal throws instead of silently truncating stream', async () => {
    const abortController = new AbortController();

    mockRunStreamed.mockResolvedValue({
      events: (async function* () {
        yield {
          type: 'item.completed',
          item: { type: 'agent_message', text: 'partial', id: '1' },
        };
        // Abort mid-stream
        abortController.abort();
        yield {
          type: 'item.completed',
          item: { type: 'agent_message', text: 'should not appear', id: '2' },
        };
        yield { type: 'turn.completed', usage: defaultUsage };
      })(),
    });

    const consumeGenerator = async (): Promise<void> => {
      for await (const _ of client.sendQuery('test', '/workspace', undefined, {
        abortSignal: abortController.signal,
      })) {
        // consume
      }
    };

    await expect(consumeGenerator()).rejects.toThrow('Query aborted');
  });

  test('an aborted stream closes its open tool call before the abort propagates', async () => {
    const abortController = new AbortController();
    mockRunStreamed.mockResolvedValue({
      events: (async function* () {
        yield {
          type: 'item.started',
          item: {
            id: 'cmd-1',
            type: 'command_execution',
            command: 'sleep 60',
            status: 'in_progress',
          },
        };
        abortController.abort();
        yield { type: 'turn.completed', usage: defaultUsage };
      })(),
    });

    const chunks: MessageChunk[] = [];
    let thrown: unknown;
    try {
      for await (const chunk of client.sendQuery('test', '/workspace', undefined, {
        abortSignal: abortController.signal,
      })) {
        chunks.push(chunk);
      }
    } catch (error) {
      thrown = error;
    }

    expect((thrown as Error).message).toContain('Query aborted');
    expect(chunks).toEqual([
      expect.objectContaining({ type: 'tool_call', toolCallId: 'cmd-1' }),
      { type: 'tool_call_update', toolCallId: 'cmd-1', status: 'cancelled' },
    ]);
  });

  // Regression for issue #1735.
  // After the codex-sdk's finally calls child.removeAllListeners() + child.kill(),
  // calling attemptController.abort() would fire Node's internal spawn-signal
  // abort listener on the now-listenerless child, surfacing an uncaught AbortError.
  // The fix removes the explicit abort() — the per-attempt controller is short-lived
  // and goes out of scope naturally.
  test('successful attempt does not throw from stale abort cleanup (#1735)', async () => {
    mockRunStreamed.mockImplementation((_prompt, _opts) => {
      return Promise.resolve({
        events: (async function* () {
          yield {
            type: 'item.completed',
            item: { type: 'agent_message', text: 'done', id: '1' },
          };
          yield { type: 'turn.completed', usage: defaultUsage };
        })(),
      });
    });

    // Listen for uncaught errors that would surface from the stale abort.
    const uncaughtErrors: Error[] = [];
    const handler = (err: Error): void => {
      uncaughtErrors.push(err);
    };
    process.on('uncaughtException', handler);

    try {
      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        if (chunk.type !== 'settled') chunks.push(chunk);
      }

      // Give the event loop a tick for any deferred error events.
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(chunks.length).toBeGreaterThan(0);
      expect(uncaughtErrors).toHaveLength(0);
    } finally {
      process.removeListener('uncaughtException', handler);
    }
  });
});
