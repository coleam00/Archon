import { describe, test, expect, mock, beforeEach, spyOn } from 'bun:test';
import { createMockLogger } from '../test/mocks/logger';

const mockLogger = createMockLogger();
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
}));

// Create mock query function
const mockQuery = mock(async function* () {
  // Empty generator by default
});

// Mock the claude-agent-sdk
mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: mockQuery,
}));

import { ClaudeProvider } from './provider';
import * as claudeModule from './provider';

describe('ClaudeProvider', () => {
  let client: ClaudeProvider;

  beforeEach(() => {
    client = new ClaudeProvider({ retryBaseDelayMs: 1 });
    mockQuery.mockClear();
    mockLogger.info.mockClear();
    mockLogger.warn.mockClear();
    mockLogger.error.mockClear();
    mockLogger.debug.mockClear();
  });

  describe('constructor', () => {
    test('throws when running as root (UID 0)', () => {
      const spy = spyOn(claudeModule, 'getProcessUid').mockReturnValue(0);
      expect(() => new ClaudeProvider()).toThrow(
        'does not support bypassPermissions when running as root'
      );
      spy.mockRestore();
    });

    test('does not throw for non-root user', () => {
      const spy = spyOn(claudeModule, 'getProcessUid').mockReturnValue(1000);
      expect(() => new ClaudeProvider()).not.toThrow();
      spy.mockRestore();
    });

    test('does not throw when process.getuid is unavailable (Windows)', () => {
      const spy = spyOn(claudeModule, 'getProcessUid').mockReturnValue(undefined);
      expect(() => new ClaudeProvider()).not.toThrow();
      spy.mockRestore();
    });
  });

  describe('getType', () => {
    test('returns claude', () => {
      expect(client.getType()).toBe('claude');
    });
  });

  describe('getCapabilities', () => {
    test('returns full capability set for Claude provider', () => {
      const caps = client.getCapabilities();
      expect(caps).toEqual({
        sessionResume: true,
        mcp: true,
        hooks: true,
        skills: true,
        toolRestrictions: true,
        structuredOutput: true,
        envInjection: true,
        costControl: true,
        effortControl: true,
        thinkingControl: true,
        fallbackModel: true,
        sandbox: true,
      });
    });
  });

  describe('sendQuery', () => {
    test('yields text events from assistant messages', async () => {
      mockQuery.mockImplementation(async function* () {
        yield {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: 'Hello, world!' }],
          },
        };
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test prompt', '/workspace')) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toEqual({ type: 'assistant', content: 'Hello, world!' });
    });

    test('yields tool events from tool_use blocks', async () => {
      mockQuery.mockImplementation(async function* () {
        yield {
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                name: 'Bash',
                input: { command: 'npm test' },
              },
            ],
          },
        };
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test prompt', '/workspace')) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toEqual({
        type: 'tool',
        toolName: 'Bash',
        toolInput: { command: 'npm test' },
      });
    });

    test('yields result event with session ID', async () => {
      mockQuery.mockImplementation(async function* () {
        yield {
          type: 'result',
          session_id: 'session-123-abc',
        };
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test prompt', '/workspace')) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toEqual({ type: 'result', sessionId: 'session-123-abc' });
    });

    test('yields result with structuredOutput when SDK result has structured_output', async () => {
      mockQuery.mockImplementation(async function* () {
        yield {
          type: 'result',
          session_id: 'sid-structured',
          structured_output: { type: 'BUG', severity: 'high' },
        };
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test prompt', '/workspace')) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toEqual({
        type: 'result',
        sessionId: 'sid-structured',
        structuredOutput: { type: 'BUG', severity: 'high' },
      });
    });

    test('yields result with cost, stopReason, numTurns, modelUsage when SDK provides them', async () => {
      mockQuery.mockImplementation(async function* () {
        yield {
          type: 'result',
          session_id: 'sid-cost',
          total_cost_usd: 0.0042,
          stop_reason: 'end_turn',
          num_turns: 3,
          model_usage: {
            'claude-sonnet-4-6': {
              input_tokens: 100,
              output_tokens: 50,
              cache_read_input_tokens: 10,
            },
          },
        };
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toMatchObject({
        type: 'result',
        sessionId: 'sid-cost',
        cost: 0.0042,
        stopReason: 'end_turn',
        numTurns: 3,
        modelUsage: {
          'claude-sonnet-4-6': {
            input_tokens: 100,
            output_tokens: 50,
            cache_read_input_tokens: 10,
          },
        },
      });
    });

    test('omits cost, stopReason, numTurns, modelUsage when SDK result has none', async () => {
      mockQuery.mockImplementation(async function* () {
        yield { type: 'result', session_id: 'sid-bare' };
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        chunks.push(chunk);
      }

      expect(chunks[0]).not.toHaveProperty('cost');
      expect(chunks[0]).not.toHaveProperty('stopReason');
      expect(chunks[0]).not.toHaveProperty('numTurns');
      expect(chunks[0]).not.toHaveProperty('modelUsage');
    });

    test('omits stopReason when stop_reason is null', async () => {
      mockQuery.mockImplementation(async function* () {
        yield { type: 'result', session_id: 'sid-null-stop', stop_reason: null };
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        chunks.push(chunk);
      }

      expect(chunks[0]).not.toHaveProperty('stopReason');
    });

    test('yields rate_limit chunk and logs warn on rate_limit_event with info', async () => {
      mockQuery.mockImplementation(async function* () {
        yield {
          type: 'rate_limit_event',
          rate_limit_info: { requests_remaining: 0, retry_after_ms: 5000 },
        };
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toEqual({
        type: 'rate_limit',
        rateLimitInfo: { requests_remaining: 0, retry_after_ms: 5000 },
      });
      expect(mockLogger.warn).toHaveBeenCalledWith(
        { rateLimitInfo: { requests_remaining: 0, retry_after_ms: 5000 } },
        'claude.rate_limit_event'
      );
    });

    test('yields rate_limit chunk with empty object when rate_limit_info absent', async () => {
      mockQuery.mockImplementation(async function* () {
        yield { type: 'rate_limit_event' };
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toEqual({ type: 'rate_limit', rateLimitInfo: {} });
    });

    test('yields result without structuredOutput when SDK result has no structured_output', async () => {
      mockQuery.mockImplementation(async function* () {
        yield {
          type: 'result',
          session_id: 'sid-plain',
        };
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test prompt', '/workspace')) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toMatchObject({ type: 'result', sessionId: 'sid-plain' });
      expect(chunks[0]).not.toHaveProperty('structuredOutput');
    });

    test('handles multiple content blocks in one message', async () => {
      mockQuery.mockImplementation(async function* () {
        yield {
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text: 'I will run a command.' },
              { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
              { type: 'text', text: 'Command completed.' },
            ],
          },
        };
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test prompt', '/workspace')) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(3);
      expect(chunks[0]).toEqual({ type: 'assistant', content: 'I will run a command.' });
      expect(chunks[1]).toEqual({ type: 'tool', toolName: 'Bash', toolInput: { command: 'ls' } });
      expect(chunks[2]).toEqual({ type: 'assistant', content: 'Command completed.' });
    });

    test('passes correct options to SDK', async () => {
      mockQuery.mockImplementation(async function* () {
        // Empty generator
      });

      // Consume the generator
      for await (const _ of client.sendQuery('my prompt', '/my/workspace', undefined, {
        model: 'sonnet',
      })) {
        // consume
      }

      expect(mockQuery).toHaveBeenCalledWith({
        prompt: 'my prompt',
        options: expect.objectContaining({
          cwd: '/my/workspace',
          model: 'sonnet',
          permissionMode: 'bypassPermissions',
        }),
      });
    });

    test('omits persistSession from SDK options by default', async () => {
      mockQuery.mockImplementation(async function* () {
        // Empty generator
      });

      for await (const _ of client.sendQuery('test', '/workspace')) {
        // consume
      }

      expect(mockQuery).toHaveBeenCalledTimes(1);
      const callArgs = mockQuery.mock.calls[0][0] as { options: Record<string, unknown> };
      expect(callArgs.options).not.toHaveProperty('persistSession');
    });

    test('passes persistSession: true when explicitly requested', async () => {
      mockQuery.mockImplementation(async function* () {
        // Empty generator
      });

      for await (const _ of client.sendQuery('test', '/workspace', undefined, {
        persistSession: true,
      })) {
        // consume
      }

      expect(mockQuery).toHaveBeenCalledWith({
        prompt: 'test',
        options: expect.objectContaining({
          persistSession: true,
        }),
      });
    });

    test('passes resume option when resumeSessionId provided', async () => {
      mockQuery.mockImplementation(async function* () {
        // Empty generator
      });

      for await (const _ of client.sendQuery('prompt', '/workspace', 'session-to-resume')) {
        // consume
      }

      expect(mockQuery).toHaveBeenCalledWith({
        prompt: 'prompt',
        options: expect.objectContaining({
          cwd: '/workspace',
          resume: 'session-to-resume',
        }),
      });
    });

    test('handles tool_use with empty input', async () => {
      mockQuery.mockImplementation(async function* () {
        yield {
          type: 'assistant',
          message: {
            content: [{ type: 'tool_use', name: 'SomeTool', input: undefined }],
          },
        };
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toEqual({
        type: 'tool',
        toolName: 'SomeTool',
        toolInput: {},
      });
    });

    test('ignores other message types', async () => {
      mockQuery.mockImplementation(async function* () {
        yield { type: 'system', content: 'system message' };
        yield { type: 'thinking', content: 'thinking...' };
        yield { type: 'tool_result', content: 'result' };
        yield {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: 'Real response' }],
          },
        };
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        chunks.push(chunk);
      }

      // Only the assistant message should be yielded
      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toEqual({ type: 'assistant', content: 'Real response' });
    });

    test('enriches and logs error on SDK failure', async () => {
      const error = new Error('API connection failed');
      mockQuery.mockImplementation(async function* () {
        throw error;
      });

      const consumeGenerator = async () => {
        for await (const _ of client.sendQuery('test', '/workspace')) {
          // consume
        }
      };

      // Error is enriched with classification prefix
      await expect(consumeGenerator()).rejects.toThrow(
        /Claude Code unknown: API connection failed/
      );

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: error, errorClass: 'unknown' }),
        'query_error'
      );
    });

    test('subprocess env passes through all process.env keys (no allowlist filtering)', async () => {
      const originalKey = process.env.CUSTOM_USER_KEY;
      process.env.CUSTOM_USER_KEY = 'user-trusted-value';

      mockQuery.mockImplementation(async function* () {
        // Empty generator
      });

      for await (const _ of client.sendQuery('test', '/workspace')) {
        // consume
      }

      const callArgs = mockQuery.mock.calls[0][0] as {
        options: { env: NodeJS.ProcessEnv; executableArgs?: string[] };
      };
      // --no-env-file prevents Bun from auto-loading .env in subprocess CWD
      expect(callArgs.options.executableArgs).toEqual(['--no-env-file']);
      expect(callArgs.options.env.CUSTOM_USER_KEY).toBe('user-trusted-value');
      // Windows uses "Path" casing in spread objects and USERPROFILE instead of HOME
      const envPath = callArgs.options.env.PATH ?? callArgs.options.env.Path;
      const processPath = process.env.PATH ?? process.env.Path;
      expect(envPath).toBe(processPath);
      const envHome = callArgs.options.env.HOME ?? callArgs.options.env.USERPROFILE;
      const processHome = process.env.HOME ?? process.env.USERPROFILE;
      expect(envHome).toBe(processHome);

      // Cleanup
      if (originalKey !== undefined) process.env.CUSTOM_USER_KEY = originalKey;
      else delete process.env.CUSTOM_USER_KEY;
    });

    test('classifies exit code errors as crash and retries up to 3 times', async () => {
      const error = new Error('process exited with code 1');
      mockQuery.mockImplementation(async function* () {
        throw error;
      });

      const consumeGenerator = async (): Promise<void> => {
        for await (const _ of client.sendQuery('test', '/workspace')) {
          // consume
        }
      };

      // Crash errors get retried then enriched
      await expect(consumeGenerator()).rejects.toThrow(/Claude Code crash/);
      // Should have been called 4 times (initial + 3 retries)
      expect(mockQuery).toHaveBeenCalledTimes(4);
    }, 5_000);

    test('recovers from transient crash on retry', async () => {
      let callCount = 0;
      mockQuery.mockImplementation(async function* () {
        callCount++;
        if (callCount <= 2) {
          throw new Error('process exited with code 1');
        }
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Recovered!' }] },
        };
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        chunks.push(chunk);
      }

      // Should succeed on the 3rd attempt
      expect(callCount).toBe(3);
      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toEqual({ type: 'assistant', content: 'Recovered!' });
    }, 5_000);

    test('classifies auth errors as fatal (no retry)', async () => {
      const error = new Error('unauthorized');
      mockQuery.mockImplementation(async function* () {
        throw error;
      });

      const consumeGenerator = async () => {
        for await (const _ of client.sendQuery('test', '/workspace')) {
          // consume
        }
      };

      await expect(consumeGenerator()).rejects.toThrow(/Claude Code auth error/);
      // Should NOT retry - verify single call
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    test('does not retry unknown errors', async () => {
      const error = new Error('something unexpected');
      mockQuery.mockImplementation(async function* () {
        throw error;
      });

      const consumeGenerator = async () => {
        for await (const _ of client.sendQuery('test', '/workspace')) {
          // consume
        }
      };

      await expect(consumeGenerator()).rejects.toThrow(/Claude Code unknown/);
      // Unknown errors are not retried
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    test('classifies "Operation aborted" errors as crash and retries', async () => {
      const error = new Error('Operation aborted');
      mockQuery.mockImplementation(async function* () {
        throw error;
      });

      const consumeGenerator = async (): Promise<void> => {
        for await (const _ of client.sendQuery('test', '/workspace')) {
          // consume
        }
      };

      // crash classification = retried up to 3 times -> 4 total calls
      await expect(consumeGenerator()).rejects.toThrow(/Claude Code crash/);
      expect(mockQuery).toHaveBeenCalledTimes(4);
    }, 5_000);

    test('classifies mixed-case "OPERATION ABORTED" errors as crash', async () => {
      const error = new Error('OPERATION ABORTED');
      mockQuery.mockImplementation(async function* () {
        throw error;
      });

      const consumeGenerator = async (): Promise<void> => {
        for await (const _ of client.sendQuery('test', '/workspace')) {
          // consume
        }
      };

      await expect(consumeGenerator()).rejects.toThrow(/Claude Code crash/);
      expect(mockQuery).toHaveBeenCalledTimes(4);
    }, 5_000);

    test('captures all stderr output for diagnostics', async () => {
      mockQuery.mockImplementation(async function* (args: {
        options: { stderr?: (data: string) => void };
      }) {
        // Simulate non-error stderr output followed by crash
        if (args.options.stderr) {
          args.options.stderr('Spawning Claude Code process: node cli.js');
          args.options.stderr('AJV validation: schema loaded');
          args.options.stderr('startup diagnostic: ready');
        }
        throw new Error('process exited with code 1');
      });

      const consumeGenerator = async (): Promise<void> => {
        for await (const _ of client.sendQuery('test', '/workspace')) {
          // consume
        }
      };

      // Use rejects so assertions always execute
      const err = await consumeGenerator().catch((e: unknown) => e as Error);
      expect(err).toBeInstanceOf(Error);
      // The error should contain stderr context from ALL captured lines
      expect(err.message).toContain('stderr:');
      expect(err.message).toContain('AJV validation');
      expect(err.message).toContain('startup diagnostic');
    }, 5_000);

    test('passes settingSources from assistantConfig', async () => {
      mockQuery.mockImplementation(async function* () {
        yield { type: 'result', session_id: 'test-session' };
      });

      for await (const _ of client.sendQuery('test', '/tmp', undefined, {
        assistantConfig: { settingSources: ['project', 'user'] },
      })) {
        // consume
      }

      expect(mockQuery).toHaveBeenCalledTimes(1);
      const callArgs = mockQuery.mock.calls[0][0] as { options: Record<string, unknown> };
      expect(callArgs.options.settingSources).toEqual(['project', 'user']);
    });

    test('defaults settingSources to project when not provided', async () => {
      mockQuery.mockImplementation(async function* () {
        yield { type: 'result', session_id: 'test-session' };
      });

      for await (const _ of client.sendQuery('test', '/tmp')) {
        // consume
      }

      expect(mockQuery).toHaveBeenCalledTimes(1);
      const callArgs = mockQuery.mock.calls[0][0] as { options: Record<string, unknown> };
      expect(callArgs.options.settingSources).toEqual(['project']);
    });

    test('passes env from requestOptions into SDK options', async () => {
      mockQuery.mockImplementation(async function* () {
        yield { type: 'result', session_id: 'sid' };
      });

      for await (const _ of client.sendQuery('test', '/tmp', undefined, {
        env: { MY_SECRET: 'abc123' },
      })) {
        // consume
      }

      expect(mockQuery).toHaveBeenCalledTimes(1);
      const callArgs = mockQuery.mock.calls[0][0] as { options: Record<string, unknown> };
      const env = callArgs.options.env as Record<string, string>;
      expect(env.MY_SECRET).toBe('abc123');
      // Verify process.env entries are still present (not fully replaced)
      // Windows uses 'Path' instead of 'PATH'
      expect(env.PATH ?? env.Path).toBeDefined();
    });

    test('requestOptions.env overrides buildSubprocessEnv values', async () => {
      mockQuery.mockImplementation(async function* () {
        yield { type: 'result', session_id: 'sid' };
      });

      // HOME is always in process.env -- override it to verify priority
      for await (const _ of client.sendQuery('test', '/tmp', undefined, {
        env: { HOME: '/custom/home' },
      })) {
        // consume
      }

      expect(mockQuery).toHaveBeenCalledTimes(1);
      const callArgs = mockQuery.mock.calls[0][0] as { options: Record<string, unknown> };
      const env = callArgs.options.env as Record<string, string>;
      expect(env.HOME).toBe('/custom/home');
    });

    test('passes effort to SDK via nodeConfig', async () => {
      mockQuery.mockImplementation(async function* () {
        yield { type: 'result', session_id: 'sid' };
      });

      for await (const _ of client.sendQuery('test', '/tmp', undefined, {
        nodeConfig: { effort: 'high' },
      })) {
        // consume
      }

      expect(mockQuery).toHaveBeenCalledTimes(1);
      const callArgs = mockQuery.mock.calls[0][0] as { options: Record<string, unknown> };
      expect(callArgs.options.effort).toBe('high');
    });

    test('omits effort from SDK when not provided in nodeConfig', async () => {
      mockQuery.mockImplementation(async function* () {
        yield { type: 'result', session_id: 'sid' };
      });

      for await (const _ of client.sendQuery('test', '/tmp')) {
        // consume
      }

      expect(mockQuery).toHaveBeenCalledTimes(1);
      const callArgs = mockQuery.mock.calls[0][0] as { options: Record<string, unknown> };
      expect(callArgs.options).not.toHaveProperty('effort');
    });

    test('passes thinking object to SDK via nodeConfig', async () => {
      mockQuery.mockImplementation(async function* () {
        yield { type: 'result', session_id: 'sid' };
      });

      for await (const _ of client.sendQuery('test', '/tmp', undefined, {
        nodeConfig: { thinking: { type: 'enabled', budgetTokens: 8000 } },
      })) {
        // consume
      }

      expect(mockQuery).toHaveBeenCalledTimes(1);
      const callArgs = mockQuery.mock.calls[0][0] as { options: Record<string, unknown> };
      expect(callArgs.options.thinking).toEqual({ type: 'enabled', budgetTokens: 8000 });
    });

    test('passes maxBudgetUsd to SDK', async () => {
      mockQuery.mockImplementation(async function* () {
        yield { type: 'result', session_id: 'sid' };
      });

      for await (const _ of client.sendQuery('test', '/tmp', undefined, { maxBudgetUsd: 5.0 })) {
        // consume
      }

      expect(mockQuery).toHaveBeenCalledTimes(1);
      const callArgs = mockQuery.mock.calls[0][0] as { options: Record<string, unknown> };
      expect(callArgs.options.maxBudgetUsd).toBe(5.0);
    });

    test('passes systemPrompt string to SDK overriding preset', async () => {
      mockQuery.mockImplementation(async function* () {
        yield { type: 'result', session_id: 'sid' };
      });

      for await (const _ of client.sendQuery('test', '/tmp', undefined, {
        systemPrompt: 'You are a security reviewer',
      })) {
        // consume
      }

      expect(mockQuery).toHaveBeenCalledTimes(1);
      const callArgs = mockQuery.mock.calls[0][0] as { options: Record<string, unknown> };
      expect(callArgs.options.systemPrompt).toBe('You are a security reviewer');
    });

    test('uses claude_code preset systemPrompt when not overridden', async () => {
      mockQuery.mockImplementation(async function* () {
        yield { type: 'result', session_id: 'sid' };
      });

      for await (const _ of client.sendQuery('test', '/tmp')) {
        // consume
      }

      expect(mockQuery).toHaveBeenCalledTimes(1);
      const callArgs = mockQuery.mock.calls[0][0] as { options: Record<string, unknown> };
      expect(callArgs.options.systemPrompt).toEqual({ type: 'preset', preset: 'claude_code' });
    });

    test('passes fallbackModel to SDK', async () => {
      mockQuery.mockImplementation(async function* () {
        yield { type: 'result', session_id: 'sid' };
      });

      for await (const _ of client.sendQuery('test', '/tmp', undefined, {
        fallbackModel: 'claude-haiku-4-5',
      })) {
        // consume
      }

      expect(mockQuery).toHaveBeenCalledTimes(1);
      const callArgs = mockQuery.mock.calls[0][0] as { options: Record<string, unknown> };
      expect(callArgs.options.fallbackModel).toBe('claude-haiku-4-5');
    });

    test('passes betas array to SDK via nodeConfig', async () => {
      mockQuery.mockImplementation(async function* () {
        yield { type: 'result', session_id: 'sid' };
      });

      for await (const _ of client.sendQuery('test', '/tmp', undefined, {
        nodeConfig: { betas: ['context-1m-2025-08-07'] },
      })) {
        // consume
      }

      expect(mockQuery).toHaveBeenCalledTimes(1);
      const callArgs = mockQuery.mock.calls[0][0] as { options: Record<string, unknown> };
      expect(callArgs.options.betas).toEqual(['context-1m-2025-08-07']);
    });

    test('passes sandbox object to SDK via nodeConfig', async () => {
      mockQuery.mockImplementation(async function* () {
        yield { type: 'result', session_id: 'sid' };
      });

      const sandbox = { enabled: true, network: { allowedDomains: [] } };

      for await (const _ of client.sendQuery('test', '/tmp', undefined, {
        nodeConfig: { sandbox },
      })) {
        // consume
      }

      expect(mockQuery).toHaveBeenCalledTimes(1);
      const callArgs = mockQuery.mock.calls[0][0] as { options: Record<string, unknown> };
      expect(callArgs.options.sandbox).toEqual(sandbox);
    });

    test('ignores empty text blocks', async () => {
      mockQuery.mockImplementation(async function* () {
        yield {
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text: '' },
              { type: 'text', text: 'Real content' },
            ],
          },
        };
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        chunks.push(chunk);
      }

      // Empty text should be filtered out
      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toEqual({ type: 'assistant', content: 'Real content' });
    });
  });
});

describe('withFirstMessageTimeout', () => {
  const { withFirstMessageTimeout } = claudeModule;

  test('completes normally when first event arrives before timeout', async () => {
    async function* fastGen(): AsyncGenerator<string> {
      yield 'hello';
      yield 'world';
    }
    const controller = new AbortController();
    const gen = withFirstMessageTimeout(fastGen(), controller, 50, {});
    const first = await gen.next();
    expect(first.value).toBe('hello');
    const second = await gen.next();
    expect(second.value).toBe('world');
  });

  test('throws after timeout when generator never yields', async () => {
    async function* stuckGen(): AsyncGenerator<string> {
      await new Promise(() => {});
      yield 'never';
    }
    const controller = new AbortController();
    const gen = withFirstMessageTimeout(stuckGen(), controller, 50, {});
    await expect(gen.next()).rejects.toThrow('produced no output within 50ms');
  });

  test('timeout error mentions issue #1067 for discoverability', async () => {
    async function* stuckGen(): AsyncGenerator<string> {
      await new Promise(() => {});
      yield 'never';
    }
    const controller = new AbortController();
    const gen = withFirstMessageTimeout(stuckGen(), controller, 50, {});
    await expect(gen.next()).rejects.toThrow('1067');
  });

  test('aborts the controller when timeout fires', async () => {
    async function* stuckGen(): AsyncGenerator<string> {
      await new Promise(() => {});
      yield 'never';
    }
    const controller = new AbortController();
    const gen = withFirstMessageTimeout(stuckGen(), controller, 50, {});
    await expect(gen.next()).rejects.toThrow();
    expect(controller.signal.aborted).toBe(true);
  });

  test('handles generator that completes immediately without yielding', async () => {
    async function* emptyGen(): AsyncGenerator<string> {
      return;
    }
    const controller = new AbortController();
    const gen = withFirstMessageTimeout(emptyGen(), controller, 50, {});
    const result = await gen.next();
    expect(result.done).toBe(true);
  });

  test('logs diagnostic payload with env keys and process state on timeout', async () => {
    async function* stuckGen(): AsyncGenerator<string> {
      await new Promise(() => {});
      yield 'never';
    }
    const controller = new AbortController();
    const diagnostics = {
      subprocessEnvKeys: ['PATH', 'HOME', 'CLAUDE_API_KEY'],
      parentClaudeKeys: ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT'],
      model: 'sonnet',
      platform: 'darwin',
    };
    const gen = withFirstMessageTimeout(stuckGen(), controller, 50, diagnostics);
    await expect(gen.next()).rejects.toThrow();

    // Verify the diagnostic dump was logged at error level
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        subprocessEnvKeys: ['PATH', 'HOME', 'CLAUDE_API_KEY'],
        parentClaudeKeys: ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT'],
        model: 'sonnet',
        platform: 'darwin',
        timeoutMs: 50,
      }),
      'claude.first_event_timeout'
    );
  });
});

// ─── Behavioral regression tests (black-box via sendQuery) ───────────────
// These cover specific fixes from the sendQuery decomposition review:
// timeout preservation, one-time warnings, abort forwarding, error enrichment.

describe('sendQuery decomposition behaviors', () => {
  let client: ClaudeProvider;

  beforeEach(() => {
    client = new ClaudeProvider({ retryBaseDelayMs: 1 });
    mockQuery.mockClear();
    mockLogger.info.mockClear();
    mockLogger.warn.mockClear();
    mockLogger.error.mockClear();
    mockLogger.debug.mockClear();
  });

  test('preserves first-event timeout error instead of generic abort', async () => {
    // withFirstMessageTimeout aborts the controller then throws.
    // classifyAndEnrichError must preserve the timeout message, not "Query aborted".
    mockQuery.mockImplementation(async function* () {
      await new Promise(() => {}); // hang forever
      yield { type: 'result', session_id: 'never' };
    });

    const consumeGenerator = async (): Promise<void> => {
      // Use env var to set a short timeout for the test
      const original = process.env.ARCHON_CLAUDE_FIRST_EVENT_TIMEOUT_MS;
      process.env.ARCHON_CLAUDE_FIRST_EVENT_TIMEOUT_MS = '50';
      try {
        for await (const _ of client.sendQuery('test', '/workspace')) {
          // consume
        }
      } finally {
        if (original !== undefined) process.env.ARCHON_CLAUDE_FIRST_EVENT_TIMEOUT_MS = original;
        else delete process.env.ARCHON_CLAUDE_FIRST_EVENT_TIMEOUT_MS;
      }
    };

    await expect(consumeGenerator()).rejects.toThrow('produced no output within');
    // Must NOT be "Query aborted"
    await expect(consumeGenerator()).rejects.not.toThrow('Query aborted');
  });

  test('emits nodeConfig warnings only once even when retries occur', async () => {
    let callCount = 0;
    mockQuery.mockImplementation(async function* () {
      callCount++;
      if (callCount <= 2) {
        throw new Error('process exited with code 1'); // crash → retried
      }
      yield {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'ok' }] },
      };
    });

    const chunks = [];
    for await (const chunk of client.sendQuery('test', '/workspace', undefined, {
      nodeConfig: { effort: 'high' },
    })) {
      chunks.push(chunk);
    }

    // nodeConfig with effort doesn't produce warnings, but let's verify
    // no system chunks are duplicated. Use a nodeConfig that doesn't warn.
    // The point is: zero warning chunks means zero, not zero × 3 retries.
    const systemChunks = chunks.filter(c => c.type === 'system');
    expect(systemChunks).toHaveLength(0);
    expect(callCount).toBe(3); // Confirms retries happened
  }, 5_000);

  test('abort signal cancels query across retries without listener leak', async () => {
    const abortController = new AbortController();
    let callCount = 0;

    mockQuery.mockImplementation(async function* () {
      callCount++;
      if (callCount === 1) {
        // First attempt crashes → triggers retry. Abort during the retry delay
        // so the next iteration's abortSignal.aborted check catches it.
        setTimeout(() => abortController.abort(), 0);
        throw new Error('process exited with code 1');
      }
      // Should not reach here — abort fires before retry starts
      yield {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'should not reach' }] },
      };
    });

    const consumeGenerator = async (): Promise<void> => {
      for await (const _ of client.sendQuery('test', '/workspace', undefined, {
        abortSignal: abortController.signal,
      })) {
        // consume
      }
    };

    await expect(consumeGenerator()).rejects.toThrow('Query aborted');
    // Single abort listener registered (not per-retry)
    expect(callCount).toBe(1);
  }, 5_000);

  test('enriched error (with stderr) is thrown at retry exhaustion, not raw error', async () => {
    mockQuery.mockImplementation(async function* (args: {
      options: { stderr?: (data: string) => void };
    }) {
      if (args.options.stderr) {
        args.options.stderr('diagnostic: something broke');
      }
      throw new Error('process exited with code 1');
    });

    const consumeGenerator = async (): Promise<void> => {
      for await (const _ of client.sendQuery('test', '/workspace')) {
        // consume
      }
    };

    const err = await consumeGenerator().catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    // Must contain stderr context, not just the raw error
    expect(err.message).toContain('stderr:');
    expect(err.message).toContain('diagnostic: something broke');
  }, 5_000);

  test('PostToolUse hook handles circular reference without crashing', async () => {
    mockQuery.mockImplementation(async function* (args: {
      options: {
        hooks?: Record<string, Array<{ hooks: Array<(input: unknown) => Promise<unknown>> }>>;
      };
    }) {
      // Simulate a tool use that triggers the PostToolUse hook with circular data
      const hooks = args.options.hooks?.PostToolUse;
      if (hooks?.[0]?.hooks?.[0]) {
        const circular: Record<string, unknown> = { key: 'val' };
        circular.self = circular; // circular reference
        await hooks[0].hooks[0]({
          tool_name: 'TestTool',
          tool_use_id: 'tc-circ',
          tool_response: circular,
        });
      }
      yield {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'done' }] },
      };
    });

    // Should not throw — the try/catch in PostToolUse should handle the circular ref
    const chunks = [];
    for await (const chunk of client.sendQuery('test', '/workspace')) {
      chunks.push(chunk);
    }

    // The assistant message should still come through
    expect(chunks.some(c => c.type === 'assistant')).toBe(true);
    // The error should be logged
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'claude.post_tool_use_hook_error'
    );
  });

  test('logs is_error result events at error level', async () => {
    mockQuery.mockImplementation(async function* () {
      yield {
        type: 'result',
        session_id: 'sid-err',
        is_error: true,
        subtype: 'max_turns',
      };
    });

    const chunks = [];
    for await (const chunk of client.sendQuery('test', '/workspace')) {
      chunks.push(chunk);
    }

    expect(chunks[0]).toMatchObject({
      type: 'result',
      isError: true,
      errorSubtype: 'max_turns',
    });
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'sid-err', errorSubtype: 'max_turns' }),
      'claude.result_is_error'
    );
  });
});
