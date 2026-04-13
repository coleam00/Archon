import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { createMockLogger } from '../test/mocks/logger';

const mockLogger = createMockLogger();
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
}));

/** Default usage matching Codex SDK's Usage type (required on TurnCompletedEvent) */
const defaultUsage = { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 };

// Create mock runStreamed first (before it's referenced)
const mockRunStreamed = mock(() =>
  Promise.resolve({
    events: (async function* () {
      yield { type: 'turn.completed', usage: defaultUsage };
    })(),
  })
);

// Create a mock thread object factory
const createMockThread = (id: string) => ({
  id,
  runStreamed: mockRunStreamed,
});

// Create mock functions for Codex SDK that use createMockThread
const mockStartThread = mock(() => createMockThread('new-thread-id'));
const mockResumeThread = mock(() => createMockThread('resumed-thread-id'));

// Mock Codex class
const MockCodex = mock(() => ({
  startThread: mockStartThread,
  resumeThread: mockResumeThread,
}));

// Mock the Codex SDK
mock.module('@openai/codex-sdk', () => ({
  Codex: MockCodex,
}));

import { CodexProvider, resetCodexSingleton } from './provider';

describe('CodexProvider', () => {
  let client: CodexProvider;

  beforeEach(() => {
    resetCodexSingleton();
    client = new CodexProvider({ retryBaseDelayMs: 1 });
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
        mcp: false,
        hooks: false,
        skills: false,
        toolRestrictions: false,
        structuredOutput: true,
        envInjection: true,
        costControl: false,
        effortControl: false,
        thinkingControl: false,
        fallbackModel: false,
        sandbox: false,
      });
    });
  });

  describe('sendQuery', () => {
    test('yields text events from agent_message items', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield {
            type: 'item.completed',
            item: { type: 'agent_message', text: 'Hello from Codex!' },
          };
          yield { type: 'turn.completed', usage: defaultUsage };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test prompt', '/workspace')) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(2);
      expect(chunks[0]).toEqual({ type: 'assistant', content: 'Hello from Codex!' });
      expect(chunks[1]).toEqual({
        type: 'result',
        sessionId: 'new-thread-id',
        tokens: { input: 10, output: 5 },
      });
    });

    test('yields tool events from command_execution items', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield {
            type: 'item.completed',
            item: {
              type: 'command_execution',
              command: 'npm test',
              aggregated_output: 'tests passed\n',
              exit_code: 0,
            },
          };
          yield { type: 'turn.completed', usage: defaultUsage };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test prompt', '/workspace')) {
        chunks.push(chunk);
      }

      expect(chunks[0]).toEqual({ type: 'tool', toolName: 'npm test' });
      expect(chunks[1]).toEqual({
        type: 'tool_result',
        toolName: 'npm test',
        toolOutput: 'tests passed\n',
      });
    });

    test('appends non-zero exit code to command_execution tool_result', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield {
            type: 'item.completed',
            item: {
              type: 'command_execution',
              command: 'npm test',
              aggregated_output: 'failure\n',
              exit_code: 1,
            },
          };
          yield { type: 'turn.completed', usage: defaultUsage };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test prompt', '/workspace')) {
        chunks.push(chunk);
      }

      expect(chunks[1]).toEqual({
        type: 'tool_result',
        toolName: 'npm test',
        toolOutput: 'failure\n\n[exit code: 1]',
      });
    });

    test('yields thinking events from reasoning items', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield {
            type: 'item.completed',
            item: { type: 'reasoning', text: 'Let me think about this...' },
          };
          yield { type: 'turn.completed', usage: defaultUsage };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test prompt', '/workspace')) {
        chunks.push(chunk);
      }

      expect(chunks[0]).toEqual({ type: 'thinking', content: 'Let me think about this...' });
    });

    test('yields tool events from web_search items', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield { type: 'item.completed', item: { type: 'web_search', query: 'codex sdk' } };
          yield { type: 'turn.completed', usage: defaultUsage };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        chunks.push(chunk);
      }

      expect(chunks[0]).toEqual({ type: 'tool', toolName: '\u{1F50D} Searching: codex sdk' });
      expect(chunks[1]).toEqual({
        type: 'tool_result',
        toolName: '\u{1F50D} Searching: codex sdk',
        toolOutput: '',
      });
    });

    test('yields system task list for todo_list items and deduplicates', async () => {
      const todoItem = {
        type: 'todo_list',
        items: [
          { text: 'Scan repo', completed: true },
          { text: 'Add tests', completed: false },
        ],
      };

      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield { type: 'item.completed', item: todoItem };
          yield { type: 'item.completed', item: todoItem };
          yield { type: 'turn.completed', usage: defaultUsage };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        chunks.push(chunk);
      }

      expect(chunks[0]).toEqual({
        type: 'system',
        content: '\u{1F4CB} Tasks:\n\u2705 Scan repo\n\u2B1C Add tests',
      });
      expect(chunks).toHaveLength(2);
    });

    test('yields updated todo_list when items change', async () => {
      const todoV1 = {
        type: 'todo_list',
        items: [
          { text: 'Scan repo', completed: false },
          { text: 'Add tests', completed: false },
        ],
      };
      const todoV2 = {
        type: 'todo_list',
        items: [
          { text: 'Scan repo', completed: true },
          { text: 'Add tests', completed: false },
        ],
      };

      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield { type: 'item.completed', item: todoV1 };
          yield { type: 'item.completed', item: todoV2 };
          yield { type: 'turn.completed', usage: defaultUsage };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(3); // todoV1 + todoV2 + result
      expect(chunks[0]).toEqual({
        type: 'system',
        content: '\u{1F4CB} Tasks:\n\u2B1C Scan repo\n\u2B1C Add tests',
      });
      expect(chunks[1]).toEqual({
        type: 'system',
        content: '\u{1F4CB} Tasks:\n\u2705 Scan repo\n\u2B1C Add tests',
      });
    });

    test('yields file change summary for file_change items', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield {
            type: 'item.completed',
            item: {
              type: 'file_change',
              status: 'completed',
              changes: [
                { kind: 'add', path: 'src/new.ts' },
                { kind: 'update', path: 'src/app.ts' },
                { kind: 'delete', path: 'src/old.ts' },
              ],
            },
          };
          yield { type: 'turn.completed', usage: defaultUsage };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        chunks.push(chunk);
      }

      expect(chunks[0]).toEqual({
        type: 'system',
        content: '\u2705 File changes:\n\u2795 src/new.ts\n\u{1F4DD} src/app.ts\n\u2796 src/old.ts',
      });
    });

    test('yields failed file change with error message', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield {
            type: 'item.completed',
            item: {
              type: 'file_change',
              status: 'failed',
              error: { message: 'Permission denied' },
              changes: [{ kind: 'update', path: 'src/locked.ts' }],
            },
          };
          yield { type: 'turn.completed', usage: defaultUsage };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        chunks.push(chunk);
      }

      expect(chunks[0]).toEqual({
        type: 'system',
        content: '\u274C File changes:\n\u{1F4DD} src/locked.ts\nPermission denied',
      });
    });

    test('yields failed file change without changes array', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield {
            type: 'item.completed',
            item: {
              type: 'file_change',
              status: 'failed',
              error: { message: 'Disk full' },
            },
          };
          yield { type: 'turn.completed', usage: defaultUsage };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        chunks.push(chunk);
      }

      expect(chunks[0]).toEqual({
        type: 'system',
        content: '\u274C File change failed: Disk full',
      });
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'failed' }),
        'file_change_failed_no_changes'
      );
    });

    test('yields failed file change without error message', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield {
            type: 'item.completed',
            item: { type: 'file_change', status: 'failed' },
          };
          yield { type: 'turn.completed', usage: defaultUsage };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        chunks.push(chunk);
      }

      expect(chunks[0]).toEqual({
        type: 'system',
        content: '\u274C File change failed',
      });
    });

    test('yields MCP tool call events and failures', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield {
            type: 'item.completed',
            item: { type: 'mcp_tool_call', server: 'fs', tool: 'readFile', status: 'in_progress' },
          };
          yield {
            type: 'item.completed',
            item: {
              type: 'mcp_tool_call',
              server: 'fs',
              tool: 'readFile',
              status: 'failed',
              error: { message: 'Permission denied' },
            },
          };
          yield { type: 'turn.completed', usage: defaultUsage };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        chunks.push(chunk);
      }

      // First mcp call (in_progress on item.completed): start + empty result
      expect(chunks[0]).toEqual({ type: 'tool', toolName: '\u{1F50C} MCP: fs/readFile' });
      expect(chunks[1]).toEqual({
        type: 'tool_result',
        toolName: '\u{1F50C} MCP: fs/readFile',
        toolOutput: '',
      });
      // Second mcp call (failed): start + error result so the UI card closes
      expect(chunks[2]).toEqual({ type: 'tool', toolName: '\u{1F50C} MCP: fs/readFile' });
      expect(chunks[3]).toEqual({
        type: 'tool_result',
        toolName: '\u{1F50C} MCP: fs/readFile',
        toolOutput: '\u274C Error: Permission denied',
      });
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ server: 'fs', tool: 'readFile' }),
        'mcp_tool_call_failed'
      );
    });

    test('yields MCP tool call with partial identification', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield {
            type: 'item.completed',
            item: { type: 'mcp_tool_call', tool: 'readFile', status: 'in_progress' },
          };
          yield {
            type: 'item.completed',
            item: { type: 'mcp_tool_call', server: 'fs', status: 'in_progress' },
          };
          yield {
            type: 'item.completed',
            item: { type: 'mcp_tool_call', status: 'in_progress' },
          };
          yield { type: 'turn.completed', usage: defaultUsage };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        chunks.push(chunk);
      }

      expect(chunks[0]).toEqual({ type: 'tool', toolName: '\u{1F50C} MCP: readFile' });
      expect(chunks[1]).toEqual({
        type: 'tool_result',
        toolName: '\u{1F50C} MCP: readFile',
        toolOutput: '',
      });
      expect(chunks[2]).toEqual({ type: 'tool', toolName: '\u{1F50C} MCP: fs' });
      expect(chunks[3]).toEqual({
        type: 'tool_result',
        toolName: '\u{1F50C} MCP: fs',
        toolOutput: '',
      });
      expect(chunks[4]).toEqual({ type: 'tool', toolName: '\u{1F50C} MCP: MCP tool' });
      expect(chunks[5]).toEqual({
        type: 'tool_result',
        toolName: '\u{1F50C} MCP: MCP tool',
        toolOutput: '',
      });
    });

    test('yields MCP failure without error message', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield {
            type: 'item.completed',
            item: { type: 'mcp_tool_call', server: 'db', tool: 'query', status: 'failed' },
          };
          yield { type: 'turn.completed', usage: defaultUsage };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        chunks.push(chunk);
      }

      expect(chunks[0]).toEqual({ type: 'tool', toolName: '\u{1F50C} MCP: db/query' });
      expect(chunks[1]).toEqual({
        type: 'tool_result',
        toolName: '\u{1F50C} MCP: db/query',
        toolOutput: '\u274C Error: MCP tool failed',
      });
    });

    test('emits paired tool + tool_result for completed MCP tool call', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield {
            type: 'item.completed',
            item: {
              type: 'mcp_tool_call',
              server: 'fs',
              tool: 'readFile',
              status: 'completed',
              result: { content: [{ type: 'text', text: 'file contents' }] },
            },
          };
          yield { type: 'turn.completed', usage: defaultUsage };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(3);
      expect(chunks[0]).toEqual({ type: 'tool', toolName: '\u{1F50C} MCP: fs/readFile' });
      expect(chunks[1]).toEqual({
        type: 'tool_result',
        toolName: '\u{1F50C} MCP: fs/readFile',
        toolOutput: JSON.stringify([{ type: 'text', text: 'file contents' }]),
      });
      expect(chunks[2]).toEqual({
        type: 'result',
        sessionId: 'new-thread-id',
        tokens: { input: 10, output: 5 },
      });
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

      for await (const _ of client.sendQuery('test prompt', '/workspace', 'existing-thread')) {
        // consume
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
        chunks.push(chunk);
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
        { err: resumeError, sessionId: 'bad-thread-id' },
        'resume_thread_failed'
      );
      // Verify user is notified about session loss
      expect(chunks[0]).toEqual({
        type: 'system',
        content: expect.stringContaining('Could not resume previous session'),
      });
      expect(chunks[1]).toEqual({
        type: 'result',
        sessionId: 'fallback-thread',
        tokens: { input: 10, output: 5 },
      });
    });

    test('passes model and codex options via assistantConfig to thread options', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield { type: 'turn.completed', usage: defaultUsage };
        })(),
      });

      for await (const _ of client.sendQuery('test prompt', '/workspace', undefined, {
        model: 'gpt-5.2-codex',
        assistantConfig: {
          modelReasoningEffort: 'medium',
          webSearchMode: 'live',
          additionalDirectories: ['/other/repo'],
        },
      })) {
        // consume
      }

      expect(mockStartThread).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'gpt-5.2-codex',
          modelReasoningEffort: 'medium',
          webSearchMode: 'live',
          additionalDirectories: ['/other/repo'],
        })
      );
    });

    test('passes outputFormat schema as outputSchema in TurnOptions', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield { type: 'turn.completed', usage: defaultUsage };
        })(),
      });

      const schema = {
        type: 'object',
        properties: { summary: { type: 'string' } },
        required: ['summary'],
      };

      const chunks = [];
      for await (const chunk of client.sendQuery('test prompt', '/workspace', undefined, {
        outputFormat: { type: 'json_schema', schema },
      })) {
        chunks.push(chunk);
      }

      expect(mockRunStreamed).toHaveBeenCalledWith(
        'test prompt',
        expect.objectContaining({ outputSchema: schema })
      );
    });

    test('passes abortSignal as signal in TurnOptions', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield { type: 'turn.completed', usage: defaultUsage };
        })(),
      });

      const controller = new AbortController();

      const chunks = [];
      for await (const chunk of client.sendQuery('test prompt', '/workspace', undefined, {
        abortSignal: controller.signal,
      })) {
        chunks.push(chunk);
      }

      expect(mockRunStreamed).toHaveBeenCalledWith(
        'test prompt',
        expect.objectContaining({ signal: controller.signal })
      );
    });

    test('passes empty TurnOptions when no outputFormat or abortSignal', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield { type: 'turn.completed', usage: defaultUsage };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test prompt', '/workspace')) {
        chunks.push(chunk);
      }

      expect(mockRunStreamed).toHaveBeenCalledWith('test prompt', {});
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

    test('wraps per-call Codex constructor failures with provider error context', async () => {
      MockCodex.mockImplementationOnce(() => {
        throw new Error('constructor failed');
      });

      const consumeGenerator = async (): Promise<void> => {
        for await (const _ of client.sendQuery('test prompt', '/workspace', undefined, {
          env: { MY_SECRET: 'abc123' },
        })) {
          // consume
        }
      };

      await expect(consumeGenerator()).rejects.toThrow('Codex query failed: constructor failed');
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
        chunks.push(chunk);
      }

      // Only first message and result should be yielded
      expect(chunks).toHaveLength(2);
      expect(chunks[0]).toEqual({ type: 'assistant', content: 'Before turn' });
      expect(chunks[1]).toMatchObject({ type: 'result', sessionId: 'new-thread-id' });
    });

    test('logs progress for item.started and item.completed events', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield { type: 'item.started', item: { id: 'item-1', type: 'command_execution' } };
          yield {
            type: 'item.completed',
            item: { id: 'item-1', type: 'command_execution', command: 'npm test' },
          };
          yield { type: 'turn.completed', usage: defaultUsage };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        chunks.push(chunk);
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

    test('handles error events', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield { type: 'error', message: 'Something went wrong' };
          yield { type: 'turn.completed', usage: defaultUsage };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        chunks.push(chunk);
      }

      expect(chunks[0]).toEqual({ type: 'system', content: '\u26A0\uFE0F Something went wrong' });
      expect(mockLogger.error).toHaveBeenCalledWith(
        { message: 'Something went wrong' },
        'stream_error'
      );
    });

    test('suppresses MCP timeout errors', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield { type: 'error', message: 'MCP client connection timeout' };
          yield { type: 'turn.completed', usage: defaultUsage };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        chunks.push(chunk);
      }

      // Should only have the result, not the MCP error
      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toEqual({
        type: 'result',
        sessionId: 'new-thread-id',
        tokens: { input: 10, output: 5 },
      });

      // Error is still logged even though not sent to user
      expect(mockLogger.error).toHaveBeenCalledWith(
        { message: 'MCP client connection timeout' },
        'stream_error'
      );
    });

    test('handles turn.failed events', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield { type: 'turn.failed', error: { message: 'Rate limit exceeded' } };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        chunks.push(chunk);
      }

      expect(chunks[0]).toEqual({
        type: 'system',
        content: '\u274C Turn failed: Rate limit exceeded',
      });
      expect(mockLogger.error).toHaveBeenCalledWith(
        { errorMessage: 'Rate limit exceeded' },
        'turn_failed'
      );
    });

    test('handles turn.failed without error message', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield { type: 'turn.failed', error: null };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        chunks.push(chunk);
      }

      expect(chunks[0]).toEqual({
        type: 'system',
        content: '\u274C Turn failed: Unknown error',
      });
      expect(mockLogger.error).toHaveBeenCalledWith(
        { errorMessage: 'Unknown error' },
        'turn_failed'
      );
    });

    test('throws on runStreamed error', async () => {
      const networkError = new Error('Network failure');
      mockRunStreamed.mockRejectedValue(networkError);

      const consumeGenerator = async () => {
        for await (const _ of client.sendQuery('test', '/workspace')) {
          // consume
        }
      };

      await expect(consumeGenerator()).rejects.toThrow('Codex unknown: Network failure');

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: networkError }),
        'query_error'
      );
    });

    test('throws actionable model-access message for unavailable configured model', async () => {
      mockRunStreamed.mockRejectedValue(new Error('403 Forbidden: model not available'));

      const consumeGenerator = async () => {
        for await (const _ of client.sendQuery('test', '/workspace', undefined, {
          model: 'gpt-5.3-codex',
        })) {
          // consume
        }
      };

      await expect(consumeGenerator()).rejects.toThrow(
        'Model "gpt-5.3-codex" is not available for your account'
      );
      await expect(consumeGenerator()).rejects.toThrow('model: gpt-5.2-codex');
    });

    test('uses generic dashboard guidance when fallback mapping is unknown', async () => {
      mockRunStreamed.mockRejectedValue(new Error('model not available'));

      const consumeGenerator = async () => {
        for await (const _ of client.sendQuery('test', '/workspace', undefined, {
          model: 'o5-pro',
        })) {
          // consume
        }
      };

      await expect(consumeGenerator()).rejects.toThrow(
        'Model "o5-pro" is not available for your account'
      );
      await expect(consumeGenerator()).rejects.toThrow(
        'update your model in ~/.archon/config.yaml'
      );
    });

    test('ignores items without text or command', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield { type: 'item.completed', item: { type: 'agent_message', text: '' } };
          yield { type: 'item.completed', item: { type: 'agent_message' } }; // no text
          yield { type: 'item.completed', item: { type: 'command_execution' } }; // no command
          yield { type: 'item.completed', item: { type: 'reasoning' } }; // no text
          yield { type: 'item.completed', item: { type: 'file_edit' } }; // ignored type
          yield { type: 'item.completed', item: { type: 'web_search' } }; // no query
          yield { type: 'item.completed', item: { type: 'todo_list', items: [] } }; // empty items
          yield { type: 'item.completed', item: { type: 'todo_list' } }; // no items
          yield {
            type: 'item.completed',
            item: { type: 'file_change', status: 'completed', changes: [] },
          }; // empty changes
          yield { type: 'turn.completed', usage: defaultUsage };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        chunks.push(chunk);
      }

      // Only the result should be yielded
      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toEqual({
        type: 'result',
        sessionId: 'new-thread-id',
        tokens: { input: 10, output: 5 },
      });
    });

    describe('retry behavior', () => {
      test('classifies exit code errors as crash and retries up to 3 times', async () => {
        mockRunStreamed.mockRejectedValue(
          new Error('Codex Exec exited with code 1: stderr output')
        );

        const consumeGenerator = async (): Promise<void> => {
          for await (const _ of client.sendQuery('test', '/workspace')) {
            // consume
          }
        };

        await expect(consumeGenerator()).rejects.toThrow(/Codex crash/);
        // Initial attempt + 3 retries = 4 runStreamed calls
        expect(mockRunStreamed).toHaveBeenCalledTimes(4);
      }, 5_000);

      test('recovers from transient crash on retry', async () => {
        let callCount = 0;
        mockRunStreamed.mockImplementation(() => {
          callCount++;
          if (callCount <= 2) {
            return Promise.reject(new Error('Codex Exec exited with code 1'));
          }
          return Promise.resolve({
            events: (async function* () {
              yield {
                type: 'item.completed',
                item: { type: 'agent_message', text: 'Recovered!' },
              };
              yield { type: 'turn.completed', usage: defaultUsage };
            })(),
          });
        });

        const chunks = [];
        for await (const chunk of client.sendQuery('test', '/workspace')) {
          chunks.push(chunk);
        }

        expect(callCount).toBe(3);
        expect(chunks.some(c => c.type === 'assistant' && c.content === 'Recovered!')).toBe(true);
      }, 5_000);

      test('classifies auth errors as fatal (no retry)', async () => {
        mockRunStreamed.mockRejectedValue(new Error('unauthorized'));

        const consumeGenerator = async (): Promise<void> => {
          for await (const _ of client.sendQuery('test', '/workspace')) {
            // consume
          }
        };

        await expect(consumeGenerator()).rejects.toThrow(/Codex auth error/);
        expect(mockRunStreamed).toHaveBeenCalledTimes(1);
      });

      test('does not retry unknown errors', async () => {
        mockRunStreamed.mockRejectedValue(new Error('something unexpected and unclassified'));

        const consumeGenerator = async (): Promise<void> => {
          for await (const _ of client.sendQuery('test', '/workspace')) {
            // consume
          }
        };

        await expect(consumeGenerator()).rejects.toThrow(/Codex unknown/);
        expect(mockRunStreamed).toHaveBeenCalledTimes(1);
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
          chunks.push(chunk);
        }

        const resultChunk = chunks.find(c => c.type === 'result');
        expect(resultChunk).toBeDefined();
        expect(resultChunk!.type === 'result' && resultChunk!.structuredOutput).toEqual(
          jsonPayload
        );
      });

      test('yields system warning when outputFormat is set but text is not valid JSON', async () => {
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
          chunks.push(chunk);
        }

        const systemChunk = chunks.find(c => c.type === 'system');
        expect(systemChunk).toBeDefined();
        expect(systemChunk!.type === 'system' && systemChunk!.content).toContain(
          'Structured output requested but Codex returned non-JSON'
        );

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
          chunks.push(chunk);
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
          chunks.push(chunk);
        }

        const resultChunk = chunks.find(c => c.type === 'result');
        expect(resultChunk).toBeDefined();
        expect(resultChunk!.type === 'result' && resultChunk!.structuredOutput).toEqual(
          jsonPayload
        );
      });
    });
  });
});

// ─── Behavioral regression tests (black-box via sendQuery) ───────────────

describe('sendQuery decomposition behaviors', () => {
  let client: CodexProvider;

  beforeEach(() => {
    client = new CodexProvider({ retryBaseDelayMs: 1 });
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

  test('enriched error thrown at retry exhaustion, not raw error', async () => {
    mockRunStreamed.mockRejectedValue(new Error('codex exec crashed'));

    const consumeGenerator = async (): Promise<void> => {
      for await (const _ of client.sendQuery('test', '/workspace')) {
        // consume
      }
    };

    const err = await consumeGenerator().catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    // Must contain the enriched classification prefix
    expect(err.message).toContain('Codex crash');
  }, 5_000);

  test('todo_list dedup state resets between retry attempts', async () => {
    const todoItem = {
      type: 'todo_list',
      items: [{ text: 'Task 1', completed: false }],
      id: 'todo-1',
    };

    let callCount = 0;
    mockRunStreamed.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          events: (async function* () {
            yield { type: 'item.completed', item: todoItem };
            throw new Error('codex exec crashed');
          })(),
        });
      }
      // On retry, same todo should appear again (fresh state)
      return Promise.resolve({
        events: (async function* () {
          yield { type: 'item.completed', item: todoItem };
          yield { type: 'turn.completed', usage: defaultUsage };
        })(),
      });
    });

    const chunks = [];
    for await (const chunk of client.sendQuery('test', '/workspace')) {
      chunks.push(chunk);
    }

    // The todo should appear on the retry attempt (not suppressed by dedup from attempt 1)
    const systemChunks = chunks.filter(c => c.type === 'system');
    expect(systemChunks.length).toBeGreaterThanOrEqual(1);
    expect(systemChunks.some(c => c.type === 'system' && c.content.includes('Task 1'))).toBe(true);
  }, 5_000);
});
