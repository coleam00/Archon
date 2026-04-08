import { describe, test, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
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

import { ClaudeClient } from './claude';
import * as claudeModule from './claude';
import * as codebaseDb from '../db/codebases';
import * as envLeakScanner from '../utils/env-leak-scanner';

describe('ClaudeClient', () => {
  let client: ClaudeClient;

  beforeEach(() => {
    client = new ClaudeClient({ retryBaseDelayMs: 1 });
    mockQuery.mockClear();
    mockLogger.info.mockClear();
    mockLogger.warn.mockClear();
    mockLogger.error.mockClear();
    mockLogger.debug.mockClear();
  });

  describe('constructor', () => {
    test('throws when running as root (UID 0)', () => {
      const spy = spyOn(claudeModule, 'getProcessUid').mockReturnValue(0);
      expect(() => new ClaudeClient()).toThrow(
        'does not support bypassPermissions when running as root'
      );
      spy.mockRestore();
    });

    test('does not throw for non-root user', () => {
      const spy = spyOn(claudeModule, 'getProcessUid').mockReturnValue(1000);
      expect(() => new ClaudeClient()).not.toThrow();
      spy.mockRestore();
    });

    test('does not throw when process.getuid is unavailable (Windows)', () => {
      const spy = spyOn(claudeModule, 'getProcessUid').mockReturnValue(undefined);
      expect(() => new ClaudeClient()).not.toThrow();
      spy.mockRestore();
    });
  });

  describe('getType', () => {
    test('returns claude', () => {
      expect(client.getType()).toBe('claude');
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
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
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

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
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

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
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

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
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

    test('strips NODE_OPTIONS from subprocess env', async () => {
      const original = process.env.NODE_OPTIONS;
      process.env.NODE_OPTIONS = '--inspect';

      mockQuery.mockImplementation(async function* () {
        // Empty generator
      });

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of client.sendQuery('test', '/workspace')) {
        // consume
      }

      const callArgs = mockQuery.mock.calls[0][0] as { options: { env: NodeJS.ProcessEnv } };
      expect(callArgs.options.env.NODE_OPTIONS).toBeUndefined();

      // Cleanup
      if (original !== undefined) {
        process.env.NODE_OPTIONS = original;
      } else {
        delete process.env.NODE_OPTIONS;
      }
    });

    test('ANTHROPIC_API_KEY alone does not set hasExplicitTokens (falls through to global auth)', async () => {
      const originalOauth = process.env.CLAUDE_CODE_OAUTH_TOKEN;
      const originalApiKey = process.env.CLAUDE_API_KEY;
      const originalAnthropicKey = process.env.ANTHROPIC_API_KEY;

      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      delete process.env.CLAUDE_API_KEY;
      process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key';

      mockQuery.mockImplementation(async function* () {
        // Empty generator
      });

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of client.sendQuery('test', '/workspace')) {
        // consume
      }

      // ANTHROPIC_API_KEY must NOT reach the subprocess: it is not in the
      // SUBPROCESS_ENV_ALLOWLIST, so a leaked target-repo key cannot bill
      // the wrong account. See issue #1029.
      const callArgs = mockQuery.mock.calls[0][0] as { options: { env: NodeJS.ProcessEnv } };
      expect(callArgs.options.env.ANTHROPIC_API_KEY).toBeUndefined();
      // Explicit SDK vars are absent (useGlobalAuth=true path)
      expect(callArgs.options.env.CLAUDE_API_KEY).toBeUndefined();
      expect(callArgs.options.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();

      // Cleanup
      if (originalOauth !== undefined) process.env.CLAUDE_CODE_OAUTH_TOKEN = originalOauth;
      else delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      if (originalApiKey !== undefined) process.env.CLAUDE_API_KEY = originalApiKey;
      else delete process.env.CLAUDE_API_KEY;
      if (originalAnthropicKey !== undefined) process.env.ANTHROPIC_API_KEY = originalAnthropicKey;
      else delete process.env.ANTHROPIC_API_KEY;
    });

    test('ANTHROPIC_API_KEY excluded from subprocess env when using explicit auth (useGlobalAuth=false)', async () => {
      const originalOauth = process.env.CLAUDE_CODE_OAUTH_TOKEN;
      const originalApiKey = process.env.CLAUDE_API_KEY;
      const originalAnthropicKey = process.env.ANTHROPIC_API_KEY;
      const originalGlobalAuth = process.env.CLAUDE_USE_GLOBAL_AUTH;

      // Force explicit auth path regardless of env
      process.env.CLAUDE_USE_GLOBAL_AUTH = 'false';
      process.env.CLAUDE_API_KEY = 'sk-ant-explicit-key';
      process.env.ANTHROPIC_API_KEY = 'sk-ant-target-repo-key';
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;

      mockQuery.mockImplementation(async function* () {
        // Empty generator
      });

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of client.sendQuery('test', '/workspace')) {
        // consume
      }

      // ANTHROPIC_API_KEY must NOT reach the subprocess regardless of which auth
      // path is taken — the allowlist excludes it in both cases. See issue #1029.
      const callArgs = mockQuery.mock.calls[0][0] as { options: { env: NodeJS.ProcessEnv } };
      expect(callArgs.options.env.ANTHROPIC_API_KEY).toBeUndefined();
      // Explicit auth vars are present on the useGlobalAuth=false path
      expect(callArgs.options.env.CLAUDE_API_KEY).toBeDefined();

      // Cleanup
      if (originalOauth !== undefined) process.env.CLAUDE_CODE_OAUTH_TOKEN = originalOauth;
      else delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      if (originalApiKey !== undefined) process.env.CLAUDE_API_KEY = originalApiKey;
      else delete process.env.CLAUDE_API_KEY;
      if (originalAnthropicKey !== undefined) process.env.ANTHROPIC_API_KEY = originalAnthropicKey;
      else delete process.env.ANTHROPIC_API_KEY;
      if (originalGlobalAuth !== undefined) process.env.CLAUDE_USE_GLOBAL_AUTH = originalGlobalAuth;
      else delete process.env.CLAUDE_USE_GLOBAL_AUTH;
    });

    test('strips VSCODE_INSPECTOR_OPTIONS from subprocess env', async () => {
      const original = process.env.VSCODE_INSPECTOR_OPTIONS;
      process.env.VSCODE_INSPECTOR_OPTIONS = 'some-value';

      mockQuery.mockImplementation(async function* () {
        // Empty generator
      });

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of client.sendQuery('test', '/workspace')) {
        // consume
      }

      const callArgs = mockQuery.mock.calls[0][0] as { options: { env: NodeJS.ProcessEnv } };
      expect(callArgs.options.env.VSCODE_INSPECTOR_OPTIONS).toBeUndefined();

      // Cleanup
      if (original !== undefined) {
        process.env.VSCODE_INSPECTOR_OPTIONS = original;
      } else {
        delete process.env.VSCODE_INSPECTOR_OPTIONS;
      }
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
      // Simulates the SDK cleanup race: PostToolUse hook writes to a closed pipe
      // after a DAG node abort. Should be classified as 'crash' (not 'unknown')
      // so the retry path is taken.
      const error = new Error('Operation aborted');
      mockQuery.mockImplementation(async function* () {
        throw error;
      });

      const consumeGenerator = async (): Promise<void> => {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for await (const _ of client.sendQuery('test', '/workspace')) {
          // consume
        }
      };

      // crash classification = retried up to 3 times → 4 total calls
      await expect(consumeGenerator()).rejects.toThrow(/Claude Code crash/);
      expect(mockQuery).toHaveBeenCalledTimes(4);
    }, 5_000);

    test('classifies mixed-case "OPERATION ABORTED" errors as crash', async () => {
      // Pattern matching uses .toLowerCase() — case must not matter
      const error = new Error('OPERATION ABORTED');
      mockQuery.mockImplementation(async function* () {
        throw error;
      });

      const consumeGenerator = async (): Promise<void> => {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for await (const _ of client.sendQuery('test', '/workspace')) {
          // consume
        }
      };

      await expect(consumeGenerator()).rejects.toThrow(/Claude Code crash/);
      expect(mockQuery).toHaveBeenCalledTimes(4);
    }, 5_000);

    test('captures all stderr output for diagnostics', async () => {
      // When the subprocess crashes, the enriched error should include all stderr,
      // not just lines matching error keywords
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

      // Use rejects so assertions always execute — prevents vacuous pass when mock doesn't throw
      const err = await consumeGenerator().catch((e: unknown) => e as Error);
      expect(err).toBeInstanceOf(Error);
      // The error should contain stderr context from ALL captured lines
      expect(err.message).toContain('stderr:');
      expect(err.message).toContain('AJV validation');
      expect(err.message).toContain('startup diagnostic');
    }, 5_000);

    test('passes settingSources from request options', async () => {
      mockQuery.mockImplementation(async function* () {
        yield { type: 'result', session_id: 'test-session' };
      });

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of client.sendQuery('test', '/tmp', undefined, {
        settingSources: ['project', 'user'],
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

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
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

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
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

      // HOME is always in process.env — override it to verify priority
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
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

    test('passes effort to SDK when provided', async () => {
      mockQuery.mockImplementation(async function* () {
        yield { type: 'result', session_id: 'sid' };
      });

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of client.sendQuery('test', '/tmp', undefined, { effort: 'high' })) {
        // consume
      }

      expect(mockQuery).toHaveBeenCalledTimes(1);
      const callArgs = mockQuery.mock.calls[0][0] as { options: Record<string, unknown> };
      expect(callArgs.options.effort).toBe('high');
    });

    test('omits effort from SDK when not provided', async () => {
      mockQuery.mockImplementation(async function* () {
        yield { type: 'result', session_id: 'sid' };
      });

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of client.sendQuery('test', '/tmp')) {
        // consume
      }

      expect(mockQuery).toHaveBeenCalledTimes(1);
      const callArgs = mockQuery.mock.calls[0][0] as { options: Record<string, unknown> };
      expect(callArgs.options).not.toHaveProperty('effort');
    });

    test('passes thinking object to SDK', async () => {
      mockQuery.mockImplementation(async function* () {
        yield { type: 'result', session_id: 'sid' };
      });

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of client.sendQuery('test', '/tmp', undefined, {
        thinking: { type: 'enabled', budgetTokens: 8000 },
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

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
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

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
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

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
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

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of client.sendQuery('test', '/tmp', undefined, {
        fallbackModel: 'claude-haiku-4-5',
      })) {
        // consume
      }

      expect(mockQuery).toHaveBeenCalledTimes(1);
      const callArgs = mockQuery.mock.calls[0][0] as { options: Record<string, unknown> };
      expect(callArgs.options.fallbackModel).toBe('claude-haiku-4-5');
    });

    test('passes betas array to SDK', async () => {
      mockQuery.mockImplementation(async function* () {
        yield { type: 'result', session_id: 'sid' };
      });

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of client.sendQuery('test', '/tmp', undefined, {
        betas: ['context-1m-2025-08-07'],
      })) {
        // consume
      }

      expect(mockQuery).toHaveBeenCalledTimes(1);
      const callArgs = mockQuery.mock.calls[0][0] as { options: Record<string, unknown> };
      expect(callArgs.options.betas).toEqual(['context-1m-2025-08-07']);
    });

    test('passes sandbox object to SDK', async () => {
      mockQuery.mockImplementation(async function* () {
        yield { type: 'result', session_id: 'sid' };
      });

      const sandbox = { enabled: true, network: { allowedDomains: [] } };

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of client.sendQuery('test', '/tmp', undefined, { sandbox })) {
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

  describe('pre-spawn env leak gate', () => {
    let spyFindByDefaultCwd: ReturnType<typeof spyOn>;
    let spyFindByPathPrefix: ReturnType<typeof spyOn>;
    let spyScan: ReturnType<typeof spyOn>;

    beforeEach(() => {
      spyFindByDefaultCwd = spyOn(codebaseDb, 'findCodebaseByDefaultCwd').mockResolvedValue(null);
      spyFindByPathPrefix = spyOn(codebaseDb, 'findCodebaseByPathPrefix').mockResolvedValue(null);
      spyScan = spyOn(envLeakScanner, 'scanPathForSensitiveKeys').mockReturnValue({
        path: '/workspace',
        findings: [],
      });
      mockQuery.mockImplementation(async function* () {
        yield { type: 'result', session_id: 'sid-gate' };
      });
    });

    afterEach(() => {
      spyFindByDefaultCwd.mockRestore();
      spyFindByPathPrefix.mockRestore();
      spyScan.mockRestore();
    });

    test('throws EnvLeakError when .env contains sensitive keys and codebase has no consent', async () => {
      spyScan.mockReturnValueOnce({
        path: '/workspace',
        findings: [{ file: '.env', keys: ['ANTHROPIC_API_KEY'] }],
      });

      await expect(async () => {
        for await (const _ of client.sendQuery('test', '/workspace')) {
          // consume
        }
      }).toThrow('Cannot run workflow');
    });

    test('skips scan when codebase has allow_env_keys: true', async () => {
      spyFindByDefaultCwd.mockResolvedValueOnce({
        id: 'codebase-1',
        allow_env_keys: true,
        default_cwd: '/workspace',
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        chunks.push(chunk);
      }

      expect(spyScan).not.toHaveBeenCalled();
      expect(chunks).toHaveLength(1);
    });

    test('proceeds when cwd has no registered codebase and no sensitive keys', async () => {
      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        chunks.push(chunk);
      }

      expect(spyScan).toHaveBeenCalledTimes(1);
      expect(chunks).toHaveLength(1);
    });

    test('uses prefix lookup for worktree paths when exact match returns null', async () => {
      spyFindByPathPrefix.mockResolvedValueOnce({
        id: 'codebase-1',
        allow_env_keys: true,
        default_cwd: '/workspace/source',
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace/worktrees/feature')) {
        chunks.push(chunk);
      }

      expect(spyFindByPathPrefix).toHaveBeenCalledWith('/workspace/worktrees/feature');
      expect(spyScan).not.toHaveBeenCalled();
    });
  });
});
