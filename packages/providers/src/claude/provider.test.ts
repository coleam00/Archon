import { describe, test, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Options, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { createMockLogger } from '../test/mocks/logger';
import type { MessageChunk } from '../types';

const mockLogger = createMockLogger();
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
}));

// Stream-shape tests below drop the trailing `settled` chunk; it has its own tests.
type MockQuery = (...args: Parameters<typeof sdkQuery>) => AsyncGenerator<unknown, void, unknown>;

// Keep the SDK input signature while allowing tests to exercise malformed and
// forward-compatible events at the provider's runtime validation boundary.
const mockQuery = mock<MockQuery>(async function* (_params) {
  // Empty generator by default
});

// Mock the claude-agent-sdk
mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: mockQuery,
}));

import { runProviderConformance } from '@archon/provider-contract/conformance';
import { ClaudeProvider, shouldPassNoEnvFile } from './provider';
import * as claudeModule from './provider';
import * as binaryResolver from './binary-resolver';

describe('shouldPassNoEnvFile', () => {
  test('returns false when cliPath is undefined (dev mode — SDK 0.2.x resolves a native binary)', () => {
    // Pre-0.2.x the SDK shipped cli.js and dev mode = JS. Since 0.2.x the
    // SDK ships per-platform native binaries via optional deps. The flag
    // (a Bun runtime option) is meaningless to native binaries and gets
    // rejected as `error: unknown option '--no-env-file'`. CWD .env leak
    // protection comes from stripCwdEnv() at entry, not from this flag.
    expect(shouldPassNoEnvFile(undefined)).toBe(false);
  });

  test('returns true for an explicit cli.js path (legacy npm-installed cli.js, SDK spawns via Bun)', () => {
    expect(
      shouldPassNoEnvFile('/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js')
    ).toBe(true);
  });

  test('returns true for .mjs and .cjs paths (also Bun-runnable JS entry points)', () => {
    expect(shouldPassNoEnvFile('/path/to/cli.mjs')).toBe(true);
    expect(shouldPassNoEnvFile('/path/to/cli.cjs')).toBe(true);
  });

  test('returns false for non-Bun-runnable JS-adjacent extensions', () => {
    // `.ts`/`.tsx`/`.jsx` are deliberately excluded — the SDK never shipped
    // those as entry points, so accepting them would only widen misconfiguration.
    expect(shouldPassNoEnvFile('/path/to/cli.ts')).toBe(false);
    expect(shouldPassNoEnvFile('/path/to/cli.tsx')).toBe(false);
    expect(shouldPassNoEnvFile('/path/to/cli.jsx')).toBe(false);
  });

  test('returns false for a native binary path (curl installer, SDK execs directly)', () => {
    expect(shouldPassNoEnvFile('/Users/test/.local/bin/claude')).toBe(false);
  });

  test('returns false for a Windows native binary path', () => {
    expect(shouldPassNoEnvFile('C:\\Users\\test\\.local\\bin\\claude.exe')).toBe(false);
  });

  test('returns false for a Homebrew symlink path', () => {
    expect(shouldPassNoEnvFile('/opt/homebrew/bin/claude')).toBe(false);
  });

  test('extension match is suffix-only (paths ending in cli.js but not literally `.js` extension are still rejected)', () => {
    // Defensive: only string-suffix matches `.js` count as JS executables.
    expect(shouldPassNoEnvFile('/path/to/cli.json')).toBe(false);
    expect(shouldPassNoEnvFile('/path/to/cli.js.bak')).toBe(false);
  });
});

describe('ClaudeProvider', () => {
  let client: ClaudeProvider;

  beforeEach(() => {
    client = new ClaudeProvider();
    mockQuery.mockClear();
    mockLogger.info.mockClear();
    mockLogger.warn.mockClear();
    mockLogger.error.mockClear();
    mockLogger.debug.mockClear();
  });

  describe('constructor', () => {
    test('throws when running as root (UID 0)', () => {
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
      expect(caps).toMatchObject({
        sessionResume: true,
        sessionFork: true,
        mcp: true,
        hooks: true,
        skills: true,
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
        if (chunk.type !== 'settled') chunks.push(chunk);
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
        if (chunk.type !== 'settled') chunks.push(chunk);
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
          usage: {
            input_tokens: 20,
            output_tokens: 5,
            cache_read_input_tokens: 70,
            cache_creation_input_tokens: 10,
          },
        };
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test prompt', '/workspace')) {
        if (chunk.type !== 'settled') chunks.push(chunk);
      }

      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toEqual({
        type: 'result',
        sessionId: 'session-123-abc',
        tokens: { input: 100, output: 5, cacheRead: 70, cacheWrite: 10 },
      });
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
        if (chunk.type !== 'settled') chunks.push(chunk);
      }

      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toEqual({
        type: 'result',
        sessionId: 'sid-structured',
        structuredOutput: { type: 'BUG', severity: 'high' },
      });
    });

    test('yields result with cost, stopReason, numTurns, and a resolved model when SDK provides them', async () => {
      mockQuery.mockImplementation(async function* () {
        yield {
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
            },
          },
        };
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        if (chunk.type !== 'settled') chunks.push(chunk);
      }

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

    describe('cost of a resumed or forked session is the query’s own spend', () => {
      // Totals recorded from real haiku runs on SDK 0.3.282, whose resumed and forked
      // sessions report total_cost_usd and modelUsage cumulatively.
      const haiku = (costUSD: number, outputTokens: number): Record<string, unknown> => ({
        'claude-haiku-4-5-20251001': { inputTokens: 900, outputTokens, costUSD },
      });
      function resultFor(sessionId: string, total: number, outputTokens: number): void {
        mockQuery.mockImplementationOnce(async function* () {
          yield {
            type: 'result',
            session_id: sessionId,
            total_cost_usd: total,
            modelUsage: haiku(total, outputTokens),
          };
        });
      }
      async function costOf(
        resumeSessionId?: string,
        options?: { forkSession: boolean }
      ): Promise<number | undefined> {
        let cost: number | undefined;
        for await (const chunk of client.sendQuery(
          'test',
          '/workspace',
          resumeSessionId,
          options
        )) {
          if (chunk.type === 'result') cost = chunk.cost;
        }
        return cost;
      }

      test('a resumed turn reports what it spent, not the session total', async () => {
        resultFor('spend-resume', 0.030896, 55);
        expect(await costOf()).toBe(0.030896);

        resultFor('spend-resume', 0.0356233, 103);
        expect(await costOf('spend-resume')).toBeCloseTo(0.0047273, 10);
      });

      test('a fork reports its own spend, differenced against the source session', async () => {
        resultFor('spend-fork-source', 0.0356233, 103);
        await costOf();

        resultFor('spend-fork-child', 0.0421297, 151);
        expect(await costOf('spend-fork-source', { forkSession: true })).toBeCloseTo(0.0065064, 10);

        // The fork's own totals become the baseline for resuming it.
        resultFor('spend-fork-child', 0.05, 180);
        expect(await costOf('spend-fork-child')).toBeCloseTo(0.0078703, 10);
      });

      test('resuming a session this process never saw reports cost as unknown', async () => {
        // Created by an earlier process: its total includes turns this node did not run.
        resultFor('spend-unseen', 0.0356233, 103);
        expect(await costOf('spend-unseen')).toBeUndefined();
        expect(mockLogger.warn).toHaveBeenCalledWith(
          { sessionId: 'spend-unseen', baseline: 'unknown' },
          'claude.query_cost_unknown'
        );
      });

      test('the resolved model is the one this query used, not the session’s busiest', async () => {
        mockQuery.mockImplementationOnce(async function* () {
          yield {
            type: 'result',
            session_id: 'spend-model',
            total_cost_usd: 0.5,
            modelUsage: { 'claude-opus-5-5': { outputTokens: 4000, costUSD: 0.5 } },
          };
        });
        await costOf();
        mockQuery.mockImplementationOnce(async function* () {
          yield {
            type: 'result',
            session_id: 'spend-model',
            total_cost_usd: 0.51,
            modelUsage: {
              'claude-opus-5-5': { outputTokens: 4000, costUSD: 0.5 },
              'claude-haiku-4-5-20251001': { outputTokens: 60, costUSD: 0.01 },
            },
          };
        });

        let resolved: string | undefined;
        for await (const chunk of client.sendQuery('test', '/workspace', 'spend-model')) {
          if (chunk.type === 'result') resolved = chunk.resolvedModel?.id;
        }
        expect(resolved).toBe('claude-haiku-4-5-20251001');
      });

      test('a resumed query with no new output names no model from earlier turns', async () => {
        // A crash or startup-error result can carry the session's totals unchanged.
        const totals = {
          type: 'result',
          session_id: 'spend-zero-delta',
          total_cost_usd: 0.6,
          modelUsage: {
            'claude-opus-5-5': { outputTokens: 5000, costUSD: 0.5 },
            'claude-haiku-4-5-20251001': { outputTokens: 100, costUSD: 0.1 },
          },
        };
        mockQuery.mockImplementationOnce(async function* () {
          yield totals;
        });
        await costOf();
        mockQuery.mockImplementationOnce(async function* () {
          yield totals;
        });

        const results: MessageChunk[] = [];
        for await (const chunk of client.sendQuery('test', '/workspace', 'spend-zero-delta')) {
          if (chunk.type === 'result') results.push(chunk);
        }
        expect(results).toHaveLength(1);
        expect(results[0]).toMatchObject({ cost: 0 });
        expect(results[0]).not.toHaveProperty('resolvedModel');
      });

      test('without a baseline, a multi-model session names no model', async () => {
        mockQuery.mockImplementationOnce(async function* () {
          yield {
            type: 'result',
            session_id: 'spend-unseen-multi',
            total_cost_usd: 0.6,
            modelUsage: {
              'claude-opus-5-5': { outputTokens: 5000, costUSD: 0.5 },
              'claude-haiku-4-5-20251001': { outputTokens: 100, costUSD: 0.1 },
            },
          };
        });

        const results: MessageChunk[] = [];
        for await (const chunk of client.sendQuery('test', '/workspace', 'spend-unseen-multi')) {
          if (chunk.type === 'result') results.push(chunk);
        }
        expect(results[0]).not.toHaveProperty('resolvedModel');
        expect(results[0]).not.toHaveProperty('cost');
      });

      test('a total below the baseline reports cost as unknown', async () => {
        resultFor('spend-reset', 0.03, 50);
        await costOf();

        resultFor('spend-reset', 0.004, 20);
        expect(await costOf('spend-reset')).toBeUndefined();
      });
    });

    test('picks the greatest-output-token model and warns when modelUsage has multiple keys', async () => {
      // A subagent pinned via `agents:` (or a fallbackModel takeover) puts more
      // than one model in the record, and key order carries no guarantee — the
      // main model here is deliberately NOT first.
      mockQuery.mockImplementation(async function* () {
        yield {
          type: 'result',
          session_id: 'sid-multi-model',
          modelUsage: {
            'claude-haiku-4-5-20251001': {
              inputTokens: 400,
              outputTokens: 20,
              cacheReadInputTokens: 0,
            },
            'claude-sonnet-5': {
              inputTokens: 120,
              outputTokens: 900,
              cacheReadInputTokens: 10,
            },
          },
        };
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        if (chunk.type !== 'settled') chunks.push(chunk);
      }

      expect(chunks[0]).toMatchObject({ resolvedModel: { id: 'claude-sonnet-5' } });
      expect(mockLogger.warn).toHaveBeenCalledWith(
        {
          models: ['claude-haiku-4-5-20251001', 'claude-sonnet-5'],
          selected: 'claude-sonnet-5',
        },
        'claude.resolved_model_ambiguous'
      );
    });

    test('omits resolvedModel when modelUsage is an empty record', async () => {
      mockQuery.mockImplementation(async function* () {
        yield { type: 'result', session_id: 'sid-empty-usage', modelUsage: {} };
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        if (chunk.type !== 'settled') chunks.push(chunk);
      }

      expect(chunks[0]).not.toHaveProperty('resolvedModel');
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    test('omits cost, stopReason, numTurns, and resolvedModel when SDK result has none', async () => {
      mockQuery.mockImplementation(async function* () {
        yield { type: 'result', session_id: 'sid-bare' };
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        if (chunk.type !== 'settled') chunks.push(chunk);
      }

      expect(chunks[0]).not.toHaveProperty('cost');
      expect(chunks[0]).not.toHaveProperty('stopReason');
      expect(chunks[0]).not.toHaveProperty('numTurns');
      expect(chunks[0]).not.toHaveProperty('resolvedModel');
    });

    test('omits stopReason when stop_reason is null', async () => {
      mockQuery.mockImplementation(async function* () {
        yield { type: 'result', session_id: 'sid-null-stop', stop_reason: null };
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        if (chunk.type !== 'settled') chunks.push(chunk);
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
        if (chunk.type !== 'settled') chunks.push(chunk);
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
        if (chunk.type !== 'settled') chunks.push(chunk);
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
        if (chunk.type !== 'settled') chunks.push(chunk);
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
        if (chunk.type !== 'settled') chunks.push(chunk);
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

    test('result chunk carries resumed:true when resumeSessionId provided (resume-or-error)', async () => {
      mockQuery.mockImplementation(async function* () {
        yield { type: 'result', session_id: 'resumed-sid' };
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('prompt', '/workspace', 'session-to-resume')) {
        if (chunk.type !== 'settled') chunks.push(chunk);
      }

      expect(chunks.find(c => c.type === 'result')).toMatchObject({ resumed: true });
    });

    test('result chunk omits resumed when no resumeSessionId', async () => {
      mockQuery.mockImplementation(async function* () {
        yield { type: 'result', session_id: 'fresh-sid' };
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('prompt', '/workspace')) {
        if (chunk.type !== 'settled') chunks.push(chunk);
      }

      const result = chunks.find(c => c.type === 'result');
      expect(result).toBeDefined();
      // Contract is "omitted when no resume was requested", not "present-but-undefined".
      expect(result).not.toHaveProperty('resumed');
    });

    // --- Phase 1 of #975 — SDK task/hook lifecycle event handling -----

    test('yields task_started chunk from SDK system message', async () => {
      mockQuery.mockImplementation(async function* () {
        yield {
          type: 'system',
          subtype: 'task_started',
          task_id: 't-1',
          description: 'Investigating the bug',
          task_type: 'general-purpose',
        };
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        if (chunk.type !== 'settled') chunks.push(chunk);
      }

      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toEqual({
        type: 'task_started',
        taskId: 't-1',
        description: 'Investigating the bug',
        taskType: 'general-purpose',
      });
    });

    test('hides a skip_transcript task lifecycle while preserving its idle heartbeat', async () => {
      mockQuery.mockImplementation(async function* () {
        yield {
          type: 'system',
          subtype: 'task_started',
          task_id: 't-housekeeping',
          description: 'Ambient task',
          skip_transcript: true,
        };
        yield {
          type: 'system',
          subtype: 'task_progress',
          task_id: 't-housekeeping',
          description: 'Ambient task is still running',
        };
        yield {
          type: 'system',
          subtype: 'task_notification',
          task_id: 't-housekeeping',
          status: 'completed',
          summary: 'Ambient task finished',
        };
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        if (chunk.type !== 'settled') chunks.push(chunk);
      }

      expect(chunks).toEqual([{ type: 'system', content: '' }]);
    });

    test('hides an ambient task lifecycle while preserving its idle heartbeat', async () => {
      mockQuery.mockImplementation(async function* () {
        yield {
          type: 'system',
          subtype: 'task_started',
          task_id: 't-ambient',
          description: 'Live update watcher',
          ambient: true,
        };
        yield {
          type: 'system',
          subtype: 'task_progress',
          task_id: 't-ambient',
          description: 'Watching for updates',
        };
        yield {
          type: 'system',
          subtype: 'task_notification',
          task_id: 't-ambient',
          status: 'completed',
          summary: 'Watcher stopped',
        };
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        if (chunk.type !== 'settled') chunks.push(chunk);
      }

      expect(chunks).toEqual([{ type: 'system', content: '' }]);
    });

    test('yields task_progress with summary + usage + lastToolName', async () => {
      mockQuery.mockImplementation(async function* () {
        yield {
          type: 'system',
          subtype: 'task_progress',
          task_id: 't-1',
          description: 'Working on auth',
          summary: 'Reading auth module',
          usage: { total_tokens: 1234, tool_uses: 3, duration_ms: 28000 },
          last_tool_name: 'Read',
        };
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        if (chunk.type !== 'settled') chunks.push(chunk);
      }

      expect(chunks).toEqual([
        {
          type: 'task_progress',
          taskId: 't-1',
          description: 'Working on auth',
          summary: 'Reading auth module',
          usage: { total_tokens: 1234, tool_uses: 3, duration_ms: 28000 },
          lastToolName: 'Read',
        },
      ]);
    });

    test('yields task_notification with completed status', async () => {
      mockQuery.mockImplementation(async function* () {
        yield {
          type: 'system',
          subtype: 'task_notification',
          task_id: 't-1',
          status: 'completed',
          output_file: '/tmp/task-output.json',
          summary: 'Plan ready',
        };
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        if (chunk.type !== 'settled') chunks.push(chunk);
      }

      expect(chunks).toEqual([
        {
          type: 'task_notification',
          taskId: 't-1',
          status: 'completed',
          summary: 'Plan ready',
          outputFile: '/tmp/task-output.json',
        },
      ]);
    });

    test('yields task_notification with failed status', async () => {
      mockQuery.mockImplementation(async function* () {
        yield {
          type: 'system',
          subtype: 'task_notification',
          task_id: 't-2',
          status: 'failed',
          output_file: '/tmp/task-2.json',
          summary: 'Task failed',
        };
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        if (chunk.type !== 'settled') chunks.push(chunk);
      }

      expect(chunks[0]).toMatchObject({ type: 'task_notification', status: 'failed' });
    });

    test('drops housekeeping task_notification when SDK sets ambient', async () => {
      mockQuery.mockImplementation(async function* () {
        yield {
          type: 'system',
          subtype: 'task_notification',
          task_id: 't-ambient',
          status: 'completed',
          summary: 'Watcher stopped',
          ambient: true,
        };
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        if (chunk.type !== 'settled') chunks.push(chunk);
      }

      expect(chunks).toHaveLength(0);
    });

    test('drops housekeeping task_notification when SDK sets skip_transcript', async () => {
      mockQuery.mockImplementation(async function* () {
        yield {
          type: 'system',
          subtype: 'task_notification',
          task_id: 't-housekeeping',
          status: 'completed',
          summary: 'Housekeeping task finished',
          skip_transcript: true,
        };
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        if (chunk.type !== 'settled') chunks.push(chunk);
      }

      expect(chunks).toHaveLength(0);
    });

    // --- #2083 — background-task liveness (SDK 0.3.209 background_tasks_changed) ---

    test('yields background_tasks chunk from SDK background_tasks_changed', async () => {
      mockQuery.mockImplementation(async function* () {
        yield {
          type: 'system',
          subtype: 'background_tasks_changed',
          tasks: [
            { task_id: 't-1', task_type: 'local_agent', description: 'Research problem A' },
            { task_id: 't-2', task_type: 'local_agent', description: 'Research problem B' },
          ],
        };
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        if (chunk.type !== 'settled') chunks.push(chunk);
      }

      expect(chunks).toEqual([
        {
          type: 'background_tasks',
          tasks: [
            { taskId: 't-1', taskType: 'local_agent', description: 'Research problem A' },
            { taskId: 't-2', taskType: 'local_agent', description: 'Research problem B' },
          ],
        },
      ]);
    });

    test('forwards an EMPTY background_tasks_changed set (drain signal)', async () => {
      mockQuery.mockImplementation(async function* () {
        yield { type: 'system', subtype: 'background_tasks_changed', tasks: [] };
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        if (chunk.type !== 'settled') chunks.push(chunk);
      }

      // An empty set means "all background work drained" — it must be forwarded,
      // not dropped, or the executor's wait gate would never release.
      expect(chunks).toEqual([{ type: 'background_tasks', tasks: [] }]);
    });

    test('filters ambient entries from background task replacement sets', async () => {
      mockQuery.mockImplementation(async function* () {
        yield {
          type: 'system',
          subtype: 'background_tasks_changed',
          tasks: [
            {
              task_id: 't-user',
              task_type: 'local_agent',
              description: 'Research problem',
            },
            {
              task_id: 't-ambient',
              task_type: 'live_update_watcher',
              description: 'Watch for updates',
              ambient: true,
            },
          ],
        };
        yield {
          type: 'system',
          subtype: 'background_tasks_changed',
          tasks: [
            {
              task_id: 't-ambient',
              task_type: 'live_update_watcher',
              description: 'Watch for updates',
              ambient: true,
            },
          ],
        };
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        if (chunk.type !== 'settled') chunks.push(chunk);
      }

      expect(chunks).toEqual([
        {
          type: 'background_tasks',
          tasks: [{ taskId: 't-user', taskType: 'local_agent', description: 'Research problem' }],
        },
        { type: 'background_tasks', tasks: [] },
      ]);
    });

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

      const types: string[] = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        types.push(chunk.type);
      }

      expect(types).toEqual([
        'result',
        'background_tasks',
        'task_notification',
        'background_tasks',
        'result',
        'settled',
      ]);
      expect(readAfterIdle).toBe(false);
      // The CLI emits its session-state events only when asked.
      const options = (mockQuery.mock.calls[0][0] as { options: { env: Record<string, string> } })
        .options;
      expect(options.env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS).toBe('1');
    });

    test('an idle session before any result does not settle the turn', async () => {
      mockQuery.mockImplementation(async function* () {
        yield { type: 'system', subtype: 'session_state_changed', state: 'idle' };
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'answer' }] } };
        yield { type: 'result', subtype: 'success', session_id: 's-1', is_error: false };
      });

      const types: string[] = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        types.push(chunk.type);
      }

      expect(types).toEqual(['assistant', 'result', 'settled']);
    });

    test('yields hook_started chunk from SDK system message', async () => {
      mockQuery.mockImplementation(async function* () {
        yield {
          type: 'system',
          subtype: 'hook_started',
          hook_id: 'h-1',
          hook_name: 'Bash',
          hook_event: 'PreToolUse',
        };
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        if (chunk.type !== 'settled') chunks.push(chunk);
      }

      expect(chunks).toEqual([
        {
          type: 'hook_started',
          hookId: 'h-1',
          hookName: 'Bash',
          hookEvent: 'PreToolUse',
        },
      ]);
    });

    test('yields hook_response chunk with outcome and exit code', async () => {
      mockQuery.mockImplementation(async function* () {
        yield {
          type: 'system',
          subtype: 'hook_response',
          hook_id: 'h-1',
          hook_name: 'Bash',
          hook_event: 'PreToolUse',
          outcome: 'success',
          exit_code: 0,
        };
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        if (chunk.type !== 'settled') chunks.push(chunk);
      }

      expect(chunks).toEqual([
        {
          type: 'hook_response',
          hookId: 'h-1',
          hookName: 'Bash',
          hookEvent: 'PreToolUse',
          outcome: 'success',
          exitCode: 0,
        },
      ]);
    });

    test('yields hook_response with error outcome and no exit_code', async () => {
      mockQuery.mockImplementation(async function* () {
        yield {
          type: 'system',
          subtype: 'hook_response',
          hook_id: 'h-2',
          hook_name: 'Edit',
          hook_event: 'PreToolUse',
          outcome: 'error',
        };
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        if (chunk.type !== 'settled') chunks.push(chunk);
      }

      expect(chunks[0]).toEqual({
        type: 'hook_response',
        hookId: 'h-2',
        hookName: 'Edit',
        hookEvent: 'PreToolUse',
        outcome: 'error',
      });
      expect(chunks[0]).not.toHaveProperty('exitCode');
    });

    test('emits complete task lifecycle in correct order', async () => {
      mockQuery.mockImplementation(async function* () {
        yield {
          type: 'system',
          subtype: 'task_started',
          task_id: 't-1',
          description: 'Working on the bug',
        };
        yield {
          type: 'system',
          subtype: 'task_progress',
          task_id: 't-1',
          description: 'Working on the bug',
          summary: 'Reading stack trace',
        };
        yield {
          type: 'system',
          subtype: 'task_notification',
          task_id: 't-1',
          status: 'completed',
          output_file: '/tmp/t-1.json',
          summary: 'Done',
        };
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        if (chunk.type !== 'settled') chunks.push(chunk);
      }

      expect(chunks.map(c => c.type)).toEqual([
        'task_started',
        'task_progress',
        'task_notification',
      ]);
    });

    // --- Phase 4 of #975 — agentProgressSummaries enabled for workflow nodes -----

    test('enables agentProgressSummaries by default for workflow nodes', async () => {
      mockQuery.mockImplementation(async function* () {
        // Empty
      });

      for await (const _ of client.sendQuery('test', '/workspace', undefined, {
        nodeConfig: { nodeId: 'plan' },
      })) {
        // consume
      }

      const callArgs = mockQuery.mock.calls[0][0] as { options: Record<string, unknown> };
      expect(callArgs.options).toMatchObject({ agentProgressSummaries: true });
    });

    test('respects explicit agentProgressSummaries: false override', async () => {
      mockQuery.mockImplementation(async function* () {
        // Empty
      });

      for await (const _ of client.sendQuery('test', '/workspace', undefined, {
        nodeConfig: { nodeId: 'plan', agentProgressSummaries: false },
      })) {
        // consume
      }

      const callArgs = mockQuery.mock.calls[0][0] as { options: Record<string, unknown> };
      expect(callArgs.options).toMatchObject({ agentProgressSummaries: false });
    });

    test('does not set agentProgressSummaries for direct chat (no nodeConfig)', async () => {
      mockQuery.mockImplementation(async function* () {
        // Empty
      });

      for await (const _ of client.sendQuery('test', '/workspace')) {
        // consume
      }

      const callArgs = mockQuery.mock.calls[0][0] as { options: Record<string, unknown> };
      // Phase 4 opt-in is for workflow nodes only. Direct chat keeps the
      // SDK default (false) so the chat surface is unchanged.
      expect(callArgs.options).not.toHaveProperty('agentProgressSummaries');
    });

    // --- Issue #2324 — tool-scoped hook frames must reach the audit stream -----

    test('opts the SDK into lifecycle hook events for every surface (#2324)', async () => {
      mockQuery.mockImplementation(async function* () {
        // Empty
      });

      for await (const _ of client.sendQuery('test', '/workspace')) {
        // consume
      }

      const callArgs = mockQuery.mock.calls[0][0] as { options: Record<string, unknown> };
      // The SDK defaults `includeHookEvents` to false, which suppresses
      // `hook_started` / `hook_response` for every hook type except
      // SessionStart and Setup. Without an explicit opt-in, a node-level
      // `PreToolUse` hook that denies Bash never reaches the workflow
      // `hook_activity` stream.
      expect(callArgs.options).toMatchObject({ includeHookEvents: true });
    });

    test('forwards a denied PreToolUse hook through the chunk pipeline (#2324)', async () => {
      mockQuery.mockImplementation(async function* () {
        yield {
          type: 'system',
          subtype: 'hook_started',
          hook_id: 'h-1',
          hook_name: 'Bash',
          hook_event: 'PreToolUse',
        };
        yield {
          type: 'system',
          subtype: 'hook_response',
          hook_id: 'h-1',
          hook_name: 'Bash',
          hook_event: 'PreToolUse',
          outcome: 'error',
          exit_code: 2,
        };
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        if (chunk.type !== 'settled') chunks.push(chunk);
      }

      expect(chunks).toEqual([
        {
          type: 'hook_started',
          hookId: 'h-1',
          hookName: 'Bash',
          hookEvent: 'PreToolUse',
        },
        {
          type: 'hook_response',
          hookId: 'h-1',
          hookName: 'Bash',
          hookEvent: 'PreToolUse',
          outcome: 'error',
          exitCode: 2,
        },
      ]);
    });

    test('forwards a PostToolUse hook lifecycle (#2324)', async () => {
      mockQuery.mockImplementation(async function* () {
        yield {
          type: 'system',
          subtype: 'hook_started',
          hook_id: 'h-2',
          hook_name: 'Edit',
          hook_event: 'PostToolUse',
        };
        yield {
          type: 'system',
          subtype: 'hook_response',
          hook_id: 'h-2',
          hook_name: 'Edit',
          hook_event: 'PostToolUse',
          outcome: 'success',
          exit_code: 0,
        };
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        if (chunk.type !== 'settled') chunks.push(chunk);
      }

      expect(chunks).toEqual([
        {
          type: 'hook_started',
          hookId: 'h-2',
          hookName: 'Edit',
          hookEvent: 'PostToolUse',
        },
        {
          type: 'hook_response',
          hookId: 'h-2',
          hookName: 'Edit',
          hookEvent: 'PostToolUse',
          outcome: 'success',
          exitCode: 0,
        },
      ]);
    });

    test('drops hook_progress frames (only emitted for async hooks — none registered) (#2324)', async () => {
      mockQuery.mockImplementation(async function* () {
        yield {
          type: 'system',
          subtype: 'hook_progress',
          hook_id: 'h-3',
          hook_name: 'Bash',
          hook_event: 'PreToolUse',
          stdout: 'still running...',
          stderr: '',
          output: '',
        };
        yield {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: 'Real response' }],
          },
        };
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        if (chunk.type !== 'settled') chunks.push(chunk);
      }

      // The hook_progress frame is intentionally not surfaced: Archon
      // registers only synchronous hooks, and the hooks guide documents
      // the carve-out. Only the assistant message reaches the stream.
      expect(chunks).toEqual([{ type: 'assistant', content: 'Real response' }]);
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
        if (chunk.type !== 'settled') chunks.push(chunk);
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
        if (chunk.type !== 'settled') chunks.push(chunk);
      }

      // Only the assistant message should be yielded
      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toEqual({ type: 'assistant', content: 'Real response' });
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
      // executableArgs is omitted when cliPath is undefined (dev mode, SDK
      // 0.2.x resolves a native binary). CWD .env leak protection comes
      // from stripCwdEnv() at entry, not from the --no-env-file flag.
      expect(callArgs.options.executableArgs).toBeUndefined();
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

    test('passes executableArgs: [--no-env-file] when cliPath ends in a Bun-runnable JS extension', async () => {
      // Belt-and-suspenders integration check: the dev-mode path is exercised
      // in the test above (executableArgs: undefined). This test exercises the
      // legacy explicit-cli.js path through the real buildBaseClaudeOptions
      // codepath, so a regression in the conditional spread would be caught.
      const spy = spyOn(binaryResolver, 'resolveClaudeBinaryPath').mockResolvedValue(
        '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js'
      );

      mockQuery.mockImplementation(async function* () {
        // empty
      });

      for await (const _ of client.sendQuery('test', '/workspace')) {
        // consume
      }

      const callArgs = mockQuery.mock.calls[0][0] as {
        options: {
          executableArgs?: string[];
          pathToClaudeCodeExecutable?: string;
        };
      };
      expect(callArgs.options.executableArgs).toEqual(['--no-env-file']);
      expect(callArgs.options.pathToClaudeCodeExecutable).toBe(
        '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js'
      );

      spy.mockRestore();
    });

    test('container run SKIPS host binary resolution (works when host Claude is absent)', async () => {
      // Simulate a compiled binary with no host Claude — resolveClaudeBinaryPath
      // would throw. A container run must NOT call it (Claude is baked into the
      // runner image; the SDK bypasses disk resolution via spawnClaudeCodeProcess).
      const spy = spyOn(binaryResolver, 'resolveClaudeBinaryPath').mockRejectedValue(
        new Error('Claude Code not found — set CLAUDE_BIN_PATH')
      );
      mockQuery.mockImplementation(async function* () {
        // empty
      });

      // Must not throw at resolution time.
      for await (const _ of client.sendQuery('test', '/workspace', undefined, {
        execContext: { kind: 'container', containerId: 'c-1' },
      })) {
        // consume
      }

      expect(spy).not.toHaveBeenCalled();
      const callArgs = mockQuery.mock.calls[0][0] as {
        options: { pathToClaudeCodeExecutable?: string; spawnClaudeCodeProcess?: unknown };
      };
      // SDK spawn hook is set; host disk path is omitted.
      expect(typeof callArgs.options.spawnClaudeCodeProcess).toBe('function');
      expect(callArgs.options.pathToClaudeCodeExecutable).toBeUndefined();

      spy.mockRestore();
    });

    test('keeps all stderr output in the failure evidence', async () => {
      mockQuery.mockImplementation(async function* (args) {
        // Simulate non-error stderr output followed by crash
        if (args.options?.stderr) {
          args.options.stderr('Spawning Claude Code process: node cli.js');
          args.options.stderr('AJV validation: schema loaded');
          args.options.stderr('startup diagnostic: ready');
        }
        throw new Error('process exited with code 1');
      });

      const failure = await failureOf(client.sendQuery('test', '/workspace'));
      expect(failure.evidence).toContain('stderr:');
      expect(failure.evidence).toContain('AJV validation');
      expect(failure.evidence).toContain('startup diagnostic');
    });

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

    test('defaults settingSources to project + user when not provided', async () => {
      mockQuery.mockImplementation(async function* () {
        yield { type: 'result', session_id: 'test-session' };
      });

      for await (const _ of client.sendQuery('test', '/tmp')) {
        // consume
      }

      expect(mockQuery).toHaveBeenCalledTimes(1);
      const callArgs = mockQuery.mock.calls[0][0] as { options: Record<string, unknown> };
      expect(callArgs.options.settingSources).toEqual(['project', 'user']);
    });

    test("honors explicit settingSources: ['project'] to opt out of user scope", async () => {
      // Locks in the contract: setting settingSources: ['project'] in
      // .archon/config.yaml must NOT be silently widened to the new default.
      // A future refactor that drops the `?? ['project', 'user']` guard would
      // expand skill/command/agent scope for every project-only deployment.
      mockQuery.mockImplementation(async function* () {
        yield { type: 'result', session_id: 'test-session' };
      });

      for await (const _ of client.sendQuery('test', '/tmp', undefined, {
        assistantConfig: { settingSources: ['project'] },
      })) {
        // consume
      }

      expect(mockQuery).toHaveBeenCalledTimes(1);
      const callArgs = mockQuery.mock.calls[0][0] as { options: Record<string, unknown> };
      expect(callArgs.options.settingSources).toEqual(['project']);
    });

    test('honors assistant-level settingSources: [] without widening to defaults', async () => {
      mockQuery.mockImplementation(async function* () {
        yield { type: 'result', session_id: 'test-session' };
      });

      for await (const _ of client.sendQuery('test', '/tmp', undefined, {
        assistantConfig: { settingSources: [] },
      })) {
        // consume
      }

      expect(mockQuery).toHaveBeenCalledTimes(1);
      const callArgs = mockQuery.mock.calls[0][0] as { options: Record<string, unknown> };
      expect(callArgs.options.settingSources).toEqual([]);
    });

    test('per-node settingSources override wins over the assistant default', async () => {
      mockQuery.mockImplementation(async function* () {
        yield { type: 'result', session_id: 'test-session' };
      });

      for await (const _ of client.sendQuery('test', '/tmp', undefined, {
        nodeConfig: { settingSources: ['project'] },
        assistantConfig: { settingSources: ['project', 'user'] },
      })) {
        // consume
      }

      expect(mockQuery).toHaveBeenCalledTimes(1);
      const callArgs = mockQuery.mock.calls[0][0] as { options: Record<string, unknown> };
      expect(callArgs.options.settingSources).toEqual(['project']);
    });

    test('per-node settingSources applies when no assistant default is set', async () => {
      mockQuery.mockImplementation(async function* () {
        yield { type: 'result', session_id: 'test-session' };
      });

      for await (const _ of client.sendQuery('test', '/tmp', undefined, {
        nodeConfig: { settingSources: [] },
      })) {
        // consume
      }

      expect(mockQuery).toHaveBeenCalledTimes(1);
      const callArgs = mockQuery.mock.calls[0][0] as { options: Record<string, unknown> };
      // An explicit empty array is a valid opt-out of ALL setting sources —
      // it must not fall through to the ['project', 'user'] default.
      expect(callArgs.options.settingSources).toEqual([]);
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

    describe('CLAUDE_API_KEY -> ANTHROPIC_API_KEY mapping', () => {
      const ENV_KEYS_UNDER_TEST = [
        'CLAUDE_API_KEY',
        'ANTHROPIC_API_KEY',
        'CLAUDE_CODE_OAUTH_TOKEN',
      ] as const;
      let savedEnv: Partial<Record<(typeof ENV_KEYS_UNDER_TEST)[number], string>>;

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

      test('maps when only the API key is set', async () => {
        mockQuery.mockImplementation(async function* () {
          yield { type: 'result', session_id: 'sid' };
        });

        delete process.env.ANTHROPIC_API_KEY;
        delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
        process.env.CLAUDE_API_KEY = 'sk-test';

        for await (const _ of client.sendQuery('test', '/tmp')) {
          // consume
        }

        expect(mockQuery).toHaveBeenCalledTimes(1);
        const callArgs = mockQuery.mock.calls[0][0] as { options: Record<string, unknown> };
        const env = callArgs.options.env as Record<string, string>;
        expect(env.CLAUDE_API_KEY).toBe('sk-test');
        expect(env.ANTHROPIC_API_KEY).toBe('sk-test');
        // Only the subprocess env copy is written — never process.env itself
        expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
      });

      test('does not clobber an explicit ANTHROPIC_API_KEY', async () => {
        mockQuery.mockImplementation(async function* () {
          yield { type: 'result', session_id: 'sid' };
        });

        delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
        process.env.CLAUDE_API_KEY = 'sk-a';
        process.env.ANTHROPIC_API_KEY = 'sk-b';

        for await (const _ of client.sendQuery('test', '/tmp')) {
          // consume
        }

        expect(mockQuery).toHaveBeenCalledTimes(1);
        const callArgs = mockQuery.mock.calls[0][0] as { options: Record<string, unknown> };
        const env = callArgs.options.env as Record<string, string>;
        expect(env.ANTHROPIC_API_KEY).toBe('sk-b');
      });

      test('OAuth token wins — no injection', async () => {
        mockQuery.mockImplementation(async function* () {
          yield { type: 'result', session_id: 'sid' };
        });

        delete process.env.ANTHROPIC_API_KEY;
        process.env.CLAUDE_API_KEY = 'sk-a';
        process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-x';

        for await (const _ of client.sendQuery('test', '/tmp')) {
          // consume
        }

        expect(mockQuery).toHaveBeenCalledTimes(1);
        const callArgs = mockQuery.mock.calls[0][0] as { options: Record<string, unknown> };
        const env = callArgs.options.env as Record<string, string>;
        expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      });

      test('no key, no injection', async () => {
        mockQuery.mockImplementation(async function* () {
          yield { type: 'result', session_id: 'sid' };
        });

        delete process.env.CLAUDE_API_KEY;
        delete process.env.ANTHROPIC_API_KEY;
        delete process.env.CLAUDE_CODE_OAUTH_TOKEN;

        for await (const _ of client.sendQuery('test', '/tmp')) {
          // consume
        }

        expect(mockQuery).toHaveBeenCalledTimes(1);
        const callArgs = mockQuery.mock.calls[0][0] as { options: Record<string, unknown> };
        const env = callArgs.options.env as Record<string, string>;
        expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      });

      test('requestOptions.env still wins over the mapping', async () => {
        mockQuery.mockImplementation(async function* () {
          yield { type: 'result', session_id: 'sid' };
        });

        delete process.env.ANTHROPIC_API_KEY;
        delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
        process.env.CLAUDE_API_KEY = 'sk-a';

        for await (const _ of client.sendQuery('test', '/tmp', undefined, {
          env: { ANTHROPIC_API_KEY: 'sk-override' },
        })) {
          // consume
        }

        expect(mockQuery).toHaveBeenCalledTimes(1);
        const callArgs = mockQuery.mock.calls[0][0] as { options: Record<string, unknown> };
        const env = callArgs.options.env as Record<string, string>;
        expect(env.ANTHROPIC_API_KEY).toBe('sk-override');
      });

      test('per-user subscription via requestOptions.env suppresses the mirror', async () => {
        mockQuery.mockImplementation(async function* () {
          yield { type: 'result', session_id: 'sid' };
        });

        delete process.env.ANTHROPIC_API_KEY;
        delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
        process.env.CLAUDE_API_KEY = 'sk-install-fallback';

        // Exact shape produced by deliverCredential()'s anthropic oauth branch:
        // the delivered env carries OAuth tokens only, never ANTHROPIC_API_KEY.
        // The mirror must not inject the install key alongside the user's
        // subscription token (the CLI would prefer the API key and rebill).
        for await (const _ of client.sendQuery('test', '/tmp', undefined, {
          env: {
            CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-user',
            ANTHROPIC_OAUTH_TOKEN: 'sk-ant-oat01-user',
          },
        })) {
          // consume
        }

        expect(mockQuery).toHaveBeenCalledTimes(1);
        const callArgs = mockQuery.mock.calls[0][0] as { options: Record<string, unknown> };
        const env = callArgs.options.env as Record<string, string>;
        expect(env.ANTHROPIC_API_KEY).toBeUndefined();
        expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-user');
      });

      test('treats an empty-string ANTHROPIC_API_KEY as missing', async () => {
        mockQuery.mockImplementation(async function* () {
          yield { type: 'result', session_id: 'sid' };
        });

        delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
        process.env.CLAUDE_API_KEY = 'sk-test';
        process.env.ANTHROPIC_API_KEY = '';

        for await (const _ of client.sendQuery('test', '/tmp')) {
          // consume
        }

        expect(mockQuery).toHaveBeenCalledTimes(1);
        const callArgs = mockQuery.mock.calls[0][0] as { options: Record<string, unknown> };
        const env = callArgs.options.env as Record<string, string>;
        expect(env.ANTHROPIC_API_KEY).toBe('sk-test');
      });
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

    // #2556: Archon's ladder is the union of every provider's vocabulary, so a
    // Claude node can ask for every shared rung; values outside the SDK's slice
    // land on its nearest endpoint.
    test('passes native rungs through and clamps the shared endpoints', async () => {
      for (const [declared, applied] of [
        ['xhigh', 'xhigh'],
        ['minimal', 'low'],
        ['max', 'max'],
        ['ultra', 'max'],
        ['persistent', 'max'],
      ] as const) {
        mockQuery.mockClear();
        mockQuery.mockImplementation(async function* () {
          yield { type: 'result', session_id: 'sid' };
        });

        for await (const _ of client.sendQuery('test', '/tmp', undefined, {
          nodeConfig: { effort: declared },
        })) {
          // consume
        }

        const callArgs = mockQuery.mock.calls[0][0] as { options: Record<string, unknown> };
        expect(callArgs.options.effort).toBe(applied);
      }
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
      // Sent as an unrecorded custom prompt, so a resume renders it fresh.
      expect(callArgs.options.systemPrompt).toEqual({
        type: 'custom',
        prompt: 'You are a security reviewer',
        snapshot: false,
      });
    });

    test('a resumed session gets the system prompt of this request, not a recorded one', async () => {
      // SDK >= 0.3.267 records the system prompt and re-sends the record on resume
      // unless snapshot is false. A node that resumes another node's session, and a
      // chat turn whose append lists current workflows, must reach the model as sent.
      mockQuery.mockImplementation(async function* () {
        yield { type: 'result', session_id: 'sid' };
      });

      for await (const _ of client.sendQuery('test', '/tmp', 'earlier-session', {
        systemPrompt: { type: 'preset', preset: 'claude_code', append: 'Workflows now: a, b' },
        nodeConfig: {},
      })) {
        // consume
      }

      const callArgs = mockQuery.mock.calls[0][0] as { options: Record<string, unknown> };
      expect(callArgs.options.resume).toBe('earlier-session');
      expect(callArgs.options.systemPrompt).toEqual({
        type: 'preset',
        preset: 'claude_code',
        append: 'Workflows now: a, b',
        snapshot: false,
      });
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
      expect(callArgs.options.systemPrompt).toEqual({
        type: 'preset',
        preset: 'claude_code',
        snapshot: false,
      });
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
        if (chunk.type !== 'settled') chunks.push(chunk);
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

describe('sendQuery decomposition behaviors', () => {
  let client: ClaudeProvider;

  beforeEach(() => {
    client = new ClaudeProvider();
    mockQuery.mockClear();
    mockLogger.info.mockClear();
    mockLogger.warn.mockClear();
    mockLogger.error.mockClear();
    mockLogger.debug.mockClear();
  });

  test('PostToolUse hooks preserve success, failure, and interruption outcomes', async () => {
    mockQuery.mockImplementation(async function* (args) {
      const successHook = args.options?.hooks?.PostToolUse?.[0]?.hooks?.[0];
      const failureHook = args.options?.hooks?.PostToolUseFailure?.[0]?.hooks?.[0];
      const hookOptions = { signal: new AbortController().signal };
      await successHook?.(
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
          tool_name: 'Task',
          tool_use_id: 'interrupt-id',
          error: 'stopped',
          is_interrupt: true,
        } as never,
        'interrupt-id',
        hookOptions
      );
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } };
    });

    const chunks = [];
    for await (const chunk of client.sendQuery('test', '/workspace')) chunks.push(chunk);

    expect(chunks.slice(0, 3)).toEqual([
      {
        type: 'tool_result',
        toolName: 'Read',
        toolOutput: 'ok',
        toolCallId: 'success-id',
        toolOutcome: 'success',
      },
      {
        type: 'tool_result',
        toolName: 'Bash',
        toolOutput: '❌ Error: exit 1',
        toolCallId: 'error-id',
        toolOutcome: 'error',
      },
      {
        type: 'tool_result',
        toolName: 'Task',
        toolOutput: '⚠️ Interrupted: stopped',
        toolCallId: 'interrupt-id',
        toolOutcome: 'interrupted',
      },
    ]);
  });

  test('terminal tool result queue drain preserves hook outcome', async () => {
    mockQuery.mockImplementation(async function* (args) {
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } };
      const successHook = args.options?.hooks?.PostToolUse?.[0]?.hooks?.[0];
      await successHook?.(
        { tool_name: 'Read', tool_use_id: 'late-id', tool_response: 'ok' } as never,
        'late-id',
        { signal: new AbortController().signal }
      );
    });

    const chunks = [];
    for await (const chunk of client.sendQuery('test', '/workspace')) chunks.push(chunk);

    expect(chunks).toContainEqual({
      type: 'tool_result',
      toolName: 'Read',
      toolOutput: 'ok',
      toolCallId: 'late-id',
      toolOutcome: 'success',
    });
  });

  test('PostToolUse hook handles circular reference without crashing', async () => {
    mockQuery.mockImplementation(async function* (args) {
      // Simulate a tool use that triggers the PostToolUse hook with circular data
      const hooks = args.options?.hooks?.PostToolUse;
      if (hooks?.[0]?.hooks?.[0]) {
        const circular: Record<string, unknown> = { key: 'val' };
        circular.self = circular; // circular reference
        await hooks[0].hooks[0](
          {
            tool_name: 'TestTool',
            tool_use_id: 'tc-circ',
            tool_response: circular,
          } as never,
          'tc-circ',
          { signal: new AbortController().signal }
        );
      }
      yield {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'done' }] },
      };
    });

    // Should not throw — the try/catch in PostToolUse should handle the circular ref
    const chunks = [];
    for await (const chunk of client.sendQuery('test', '/workspace')) {
      if (chunk.type !== 'settled') chunks.push(chunk);
    }

    // The assistant message should still come through
    expect(chunks.some(c => c.type === 'assistant')).toBe(true);
    // The error should be logged
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'claude.post_tool_use_hook_error'
    );
  });

  test('logs a failed result at error level', async () => {
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
      if (chunk.type !== 'settled') chunks.push(chunk);
    }

    expect(chunks[0]).toMatchObject({
      type: 'result',
      isError: true,
      errorSubtype: 'max_turns',
      failure: { class: 'unknown', evidence: 'max_turns' },
    });
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'sid-err', errorSubtype: 'max_turns' }),
      'claude.result_failed'
    );
  });

  test('treats is_error: true + subtype: success as clean success (stop_sequence)', async () => {
    // Claude Agent SDK's SDKResultSuccess explicitly types is_error as boolean
    // (not literal false). When a model is configured with stop sequences (e.g.
    // via output_format / json_schema enforcement) the SDK reports is_error:
    // true alongside subtype: 'success' and stop_reason: 'stop_sequence' — its
    // way of signalling "non-default termination, but not a failure".
    // Regression test for #1425.
    mockQuery.mockImplementation(async function* () {
      yield {
        type: 'result',
        session_id: 'sid-stop-seq',
        is_error: true,
        subtype: 'success',
        stop_reason: 'stop_sequence',
      };
    });

    const chunks = [];
    for await (const chunk of client.sendQuery('test', '/workspace')) {
      if (chunk.type !== 'settled') chunks.push(chunk);
    }

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({
      type: 'result',
      sessionId: 'sid-stop-seq',
      stopReason: 'stop_sequence',
    });
    expect(chunks[0]).not.toHaveProperty('isError');
    expect(chunks[0]).not.toHaveProperty('errorSubtype');
    expect(chunks[0]).not.toHaveProperty('errors');
    expect(mockLogger.error).not.toHaveBeenCalledWith(expect.anything(), 'claude.result_is_error');
    expect(mockLogger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'sid-stop-seq', stopReason: 'stop_sequence' }),
      'claude.result_success_validated'
    );
  });

  describe('inline agents (nodeConfig.agents)', () => {
    let workflowCwd: string;

    beforeEach(() => {
      workflowCwd = mkdtempSync(join(tmpdir(), 'archon-claude-workflow-'));
    });

    afterEach(() => {
      rmSync(workflowCwd, { recursive: true, force: true });
    });

    const stageClaudeSkill = (name: string): void => {
      const dir = join(workflowCwd, '.claude', 'skills', name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: test\n---\n`);
    };

    test('passes inline agents map through to SDK options.agents', async () => {
      mockQuery.mockImplementation(async function* () {
        yield { type: 'result', session_id: 'sid' };
      });

      const agents = {
        'brief-gen': {
          description: 'Summarises issues',
          prompt: 'Be concise.',
          model: 'haiku',
          tools: ['Bash', 'Read'],
        },
      };

      for await (const _ of client.sendQuery('test', workflowCwd, undefined, {
        nodeConfig: { nodeId: 'agent-node', agents },
      })) {
        // consume
      }

      expect(mockQuery).toHaveBeenCalledTimes(1);
      const callArgs = mockQuery.mock.calls[0][0] as { options: Record<string, unknown> };
      expect(callArgs.options.agents).toMatchObject(agents);
    });

    test('does not set options.agent when only inline agents are present', async () => {
      mockQuery.mockImplementation(async function* () {
        yield { type: 'result', session_id: 'sid' };
      });

      for await (const _ of client.sendQuery('test', workflowCwd, undefined, {
        nodeConfig: {
          nodeId: 'agent-node',
          agents: {
            'sub-a': { description: 'd', prompt: 'p' },
          },
        },
      })) {
        // consume
      }

      const callArgs = mockQuery.mock.calls[0][0] as { options: Record<string, unknown> };
      expect(callArgs.options.agent).toBeUndefined();
      expect(callArgs.options.agents).toMatchObject({
        'sub-a': { description: 'd', prompt: 'p' },
      });
    });

    test('workflow omission selects no skills and enables strict MCP', async () => {
      mockQuery.mockImplementation(async function* () {
        yield { type: 'result', session_id: 'sid' };
      });

      for await (const _ of client.sendQuery('test', workflowCwd, undefined, {
        nodeConfig: { nodeId: 'closed-node' },
      })) {
        // consume
      }

      const callArgs = mockQuery.mock.calls[0][0] as { options: Record<string, unknown> };
      expect(callArgs.options.agent).toBeUndefined();
      expect(callArgs.options.agents).toBeUndefined();
      expect(callArgs.options.allowedTools).toBeUndefined();
      expect(callArgs.options.skills).toEqual([]);
      expect(callArgs.options.strictMcpConfig).toBe(true);
      expect(callArgs.options.mcpServers).toBeUndefined();
    });

    test('passes exact native skill selection while preserving inline agents', async () => {
      mockQuery.mockImplementation(async function* () {
        yield { type: 'result', session_id: 'sid' };
      });
      stageClaudeSkill('my-skill');

      for await (const _ of client.sendQuery('test', workflowCwd, undefined, {
        nodeConfig: {
          nodeId: 'skilled-node',
          skills: ['my-skill'],
          agents: {
            'extra-sub': { description: 'd', prompt: 'p' },
          },
        },
      })) {
        // consume
      }

      const callArgs = mockQuery.mock.calls[0][0] as { options: Record<string, unknown> };
      expect(callArgs.options.skills).toEqual(['my-skill']);
      expect(callArgs.options.agent).toBeUndefined();
      expect(callArgs.options.agents).toEqual({
        'extra-sub': { description: 'd', prompt: 'p' },
      });
    });

    test('native skills without allowed_tools leave the SDK tool set unrestricted', async () => {
      mockQuery.mockImplementation(async function* () {
        yield { type: 'result', session_id: 'sid' };
      });

      stageClaudeSkill('agent-browser');
      for await (const _ of client.sendQuery('test', workflowCwd, undefined, {
        nodeConfig: {
          nodeId: 'skilled-node',
          skills: ['agent-browser'],
          // no allowed_tools → options.tools is undefined
        },
      })) {
        // consume
      }

      const callArgs = mockQuery.mock.calls[0][0] as { options: Record<string, unknown> };
      expect(callArgs.options.skills).toEqual(['agent-browser']);
      expect(callArgs.options.tools).toBeUndefined();
    });

    test('skills with allowed_tools includes Skill in the tools list', async () => {
      mockQuery.mockImplementation(async function* () {
        yield { type: 'result', session_id: 'sid' };
      });

      stageClaudeSkill('agent-browser');
      for await (const _ of client.sendQuery('test', workflowCwd, undefined, {
        nodeConfig: {
          nodeId: 'skilled-node',
          skills: ['agent-browser'],
          allowed_tools: ['Bash', 'Read'],
        },
      })) {
        // consume
      }

      const callArgs = mockQuery.mock.calls[0][0] as { options: Record<string, unknown> };
      expect(callArgs.options.tools).toEqual(['Bash', 'Read', 'Skill']);
      expect(callArgs.options.allowedTools).toContain('Skill');
    });

    test('fails before querying when a declared skill is unavailable to Claude', async () => {
      mockQuery.mockImplementation(async function* () {
        yield { type: 'result', session_id: 'sid' };
      });
      const agentsOnly = join(workflowCwd, '.agents', 'skills', 'my-skill');
      mkdirSync(agentsOnly, { recursive: true });
      writeFileSync(join(agentsOnly, 'SKILL.md'), '# agents only\n');

      const failure = await failureOf(
        client.sendQuery('test', workflowCwd, undefined, {
          nodeConfig: { nodeId: 'missing-skill', skills: ['my-skill'] },
        })
      );

      expect(failure.class).toBe('unknown');
      expect(failure.evidence).toContain('.claude/skills/');
      expect(mockQuery).not.toHaveBeenCalled();
    });

    test('warns but still runs when a declared skill is on no root at all', async () => {
      // Claude's built-in skills and `plugin:skill` names resolve inside the SDK
      // and exist under no skills directory. Throwing on "absent from disk" made
      // every one of them undeclarable (PR #2535 review), so an unresolved name
      // warns and lets the SDK decide.
      mockQuery.mockImplementation(async function* () {
        yield { type: 'result', session_id: 'sid' };
      });

      const chunks: string[] = [];
      for await (const chunk of client.sendQuery('test', workflowCwd, undefined, {
        nodeConfig: { nodeId: 'builtin-skill', skills: ['dataviz'] },
      })) {
        if (chunk.type === 'system') chunks.push(chunk.content ?? '');
      }

      expect(mockQuery).toHaveBeenCalled();
      const callArgs = mockQuery.mock.calls[0]![0] as { options: Options };
      expect(callArgs.options.skills).toEqual(['dataviz']);
      expect(chunks.join('\n')).toContain('built-in');
    });

    test('names only the unreachable skill when a built-in is declared alongside it', async () => {
      mockQuery.mockImplementation(async function* () {
        yield { type: 'result', session_id: 'sid' };
      });
      const agentsOnly = join(workflowCwd, '.agents', 'skills', 'stranded-skill');
      mkdirSync(agentsOnly, { recursive: true });
      writeFileSync(join(agentsOnly, 'SKILL.md'), '# agents only\n');

      const failure = await failureOf(
        client.sendQuery('test', workflowCwd, undefined, {
          nodeConfig: { nodeId: 'mixed', skills: ['dataviz', 'stranded-skill'] },
        })
      );

      // 'dataviz' resolves nowhere on disk and may be a built-in, so it must not
      // be blamed in an error about a misplaced install.
      expect(failure.evidence).toContain('stranded-skill');
      expect(failure.evidence).not.toContain('dataviz');
      expect(mockQuery).not.toHaveBeenCalled();
    });

    test('resolves user skills from the effective CLAUDE_CONFIG_DIR on host', async () => {
      mockQuery.mockImplementation(async function* () {
        yield { type: 'result', session_id: 'sid' };
      });
      const configDir = join(workflowCwd, 'custom-claude-config');
      const skillDir = join(configDir, 'skills', 'custom-skill');
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, 'SKILL.md'), '# custom\n');

      for await (const _ of client.sendQuery('test', workflowCwd, undefined, {
        env: { CLAUDE_CONFIG_DIR: configDir },
        nodeConfig: { nodeId: 'custom-config', skills: ['custom-skill'] },
      })) {
        // consume
      }

      expect(mockQuery).toHaveBeenCalledTimes(1);
      const options = (mockQuery.mock.calls[0][0] as { options: Record<string, unknown> }).options;
      expect(options.skills).toEqual(['custom-skill']);
    });

    test('rejects a user-only skill when effective settingSources is project-only', async () => {
      const configDir = join(workflowCwd, 'project-only-config');
      const skillDir = join(configDir, 'skills', 'user-only');
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, 'SKILL.md'), '# user only\n');

      const consume = () =>
        client.sendQuery('test', workflowCwd, undefined, {
          env: { CLAUDE_CONFIG_DIR: configDir },
          assistantConfig: { settingSources: ['project'] },
          nodeConfig: { nodeId: 'project-only', skills: ['user-only'] },
        });

      expect((await failureOf(consume())).evidence).toMatch(
        /enabled Claude-native skill directory/
      );
      expect(mockQuery).not.toHaveBeenCalled();
    });

    test('rejects a project-only skill when per-node settingSources is user-only', async () => {
      stageClaudeSkill('project-only');

      const consume = () =>
        client.sendQuery('test', workflowCwd, undefined, {
          nodeConfig: {
            nodeId: 'user-only',
            skills: ['project-only'],
            settingSources: ['user'],
          },
        });

      expect((await failureOf(consume())).evidence).toMatch(
        /enabled Claude-native skill directory/
      );
      expect(mockQuery).not.toHaveBeenCalled();
    });

    test('rejects every declared skill when effective settingSources is empty', async () => {
      stageClaudeSkill('disabled');

      const consume = () =>
        client.sendQuery('test', workflowCwd, undefined, {
          assistantConfig: { settingSources: ['project', 'user'] },
          nodeConfig: { nodeId: 'no-sources', skills: ['disabled'], settingSources: [] },
        });

      expect((await failureOf(consume())).evidence).toMatch(
        /effective settingSources currently enables none/
      );
      expect(mockQuery).not.toHaveBeenCalled();
    });

    test('assistant-level empty settingSources rejects every declared workflow skill', async () => {
      stageClaudeSkill('assistant-disabled');

      const consume = () =>
        client.sendQuery('test', workflowCwd, undefined, {
          assistantConfig: { settingSources: [] },
          nodeConfig: { nodeId: 'assistant-no-sources', skills: ['assistant-disabled'] },
        });

      expect((await failureOf(consume())).evidence).toMatch(
        /effective settingSources currently enables none/
      );
      expect(mockQuery).not.toHaveBeenCalled();
    });

    test('container workflows fail before spend for a host user-only skill', async () => {
      mockQuery.mockImplementation(async function* () {
        yield { type: 'result', session_id: 'sid' };
      });
      const configDir = join(workflowCwd, 'host-claude-config');
      const skillDir = join(configDir, 'skills', 'user-only');
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, 'SKILL.md'), '# user only\n');

      const failure = await failureOf(
        client.sendQuery('test', workflowCwd, undefined, {
          env: { CLAUDE_CONFIG_DIR: configDir },
          execContext: { kind: 'container', containerId: 'c-1' },
          nodeConfig: { nodeId: 'container-skill', skills: ['user-only'] },
        })
      );

      expect(failure.class).toBe('unknown');
      expect(failure.evidence).toContain('Container workflows');
      expect(failure.evidence).toContain('project-local .claude/skills/');
      expect(mockQuery).not.toHaveBeenCalled();
    });

    test('container workflows accept a declared project-local skill', async () => {
      mockQuery.mockImplementation(async function* () {
        yield { type: 'result', session_id: 'sid' };
      });
      stageClaudeSkill('container-project-skill');

      for await (const _ of client.sendQuery('test', workflowCwd, undefined, {
        execContext: { kind: 'container', containerId: 'c-1' },
        nodeConfig: { nodeId: 'container-project', skills: ['container-project-skill'] },
      })) {
        // consume
      }

      expect(mockQuery).toHaveBeenCalledTimes(1);
      const options = (mockQuery.mock.calls[0][0] as { options: Record<string, unknown> }).options;
      expect(options.skills).toEqual(['container-project-skill']);
      expect(options.strictMcpConfig).toBe(true);
    });

    test('uses the same closed capability options when resuming', async () => {
      mockQuery.mockImplementation(async function* () {
        yield { type: 'result', session_id: 'sid' };
      });

      for (const sessionId of [undefined, 'resume-me']) {
        for await (const _ of client.sendQuery('test', workflowCwd, sessionId, {
          nodeConfig: { nodeId: 'closed-node' },
        })) {
          // consume
        }
      }

      expect(mockQuery).toHaveBeenCalledTimes(2);
      for (const call of mockQuery.mock.calls) {
        const options = (call[0] as { options: Record<string, unknown> }).options;
        expect(options.skills).toEqual([]);
        expect(options.strictMcpConfig).toBe(true);
      }
      const resumedOptions = (mockQuery.mock.calls[1][0] as { options: Record<string, unknown> })
        .options;
      expect(resumedOptions.resume).toBe('resume-me');
    });

    test('strict MCP passes exactly the workflow-declared server map', async () => {
      mockQuery.mockImplementation(async function* () {
        yield { type: 'result', session_id: 'sid' };
      });
      const mcpPath = join(workflowCwd, 'mcp.json');
      writeFileSync(
        mcpPath,
        JSON.stringify({ declared: { command: 'node', args: ['server.mjs'] } })
      );

      for await (const _ of client.sendQuery('test', workflowCwd, undefined, {
        nodeConfig: { nodeId: 'mcp-node', mcp: mcpPath },
      })) {
        // consume
      }

      const options = (mockQuery.mock.calls[0][0] as { options: Record<string, unknown> }).options;
      expect(options.strictMcpConfig).toBe(true);
      expect(Object.keys(options.mcpServers as Record<string, unknown>)).toEqual(['declared']);
      expect(options.allowedTools).toContain('mcp__declared__*');
    });

    test('keeps partial non-workflow nodeConfig on ambient defaults', async () => {
      mockQuery.mockImplementation(async function* () {
        yield { type: 'result', session_id: 'sid' };
      });

      for await (const _ of client.sendQuery('title', workflowCwd, undefined, {
        nodeConfig: { allowed_tools: [] },
      })) {
        // consume
      }

      const options = (mockQuery.mock.calls[0][0] as { options: Record<string, unknown> }).options;
      expect(options.skills).toBeUndefined();
      expect(options.strictMcpConfig).toBeUndefined();
      expect(options.tools).toEqual([]);
    });

    test('does not grant Skill to a non-workflow call that carries skills', async () => {
      // The `options.skills` narrowing is gated on the workflow path. Granting
      // the Skill tool outside that gate would expose the whole ambient catalog
      // instead of a declared subset (PR #2535 review).
      mockQuery.mockImplementation(async function* () {
        yield { type: 'result', session_id: 'sid' };
      });

      for await (const _ of client.sendQuery('title', workflowCwd, undefined, {
        nodeConfig: { allowed_tools: ['Read'], skills: ['my-skill'] },
      })) {
        // consume
      }

      const options = (mockQuery.mock.calls[0][0] as { options: Record<string, unknown> }).options;
      expect(options.skills).toBeUndefined();
      expect(options.tools).toEqual(['Read']);
      expect(options.allowedTools ?? []).not.toContain('Skill');
    });
  });
});

// ─── API errors surfaced as text (#1797) ─────────────────────────────────
// The SDK does not throw on API-level failures (auth, billing, rate limit).
// It synthesizes an assistant message (model: '<synthetic>', wrapper
// `error` code) with the error prose, then emits a result with
// subtype: 'success' AND is_error: true — the same field pair as the
// legitimate stop-sequence carve-out (#1425). Shapes below are verbatim
// captures from claude CLI 2.1.210 (isolated config dir).

describe('typed failures (#1797, #3524)', () => {
  let client: ClaudeProvider;

  beforeEach(() => {
    client = new ClaudeProvider();
    mockQuery.mockClear();
    mockLogger.info.mockClear();
    mockLogger.warn.mockClear();
    mockLogger.error.mockClear();
    mockLogger.debug.mockClear();
  });

  interface CollectedStream {
    chunks: Array<Record<string, unknown>>;
    error?: Error;
  }

  async function collect(gen: AsyncIterable<Record<string, unknown>>): Promise<CollectedStream> {
    const chunks: Array<Record<string, unknown>> = [];
    try {
      for await (const chunk of gen) {
        if (chunk.type !== 'settled') chunks.push(chunk);
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

  test.each([
    ['authentication_failed', 'auth'],
    ['oauth_org_not_allowed', 'auth'],
    ['account_on_hold', 'auth'],
    ['verification_required', 'auth'],
    ['cloud_credential_error', 'auth'],
    ['billing_error', 'quota_exhausted'],
    ['rate_limit', 'rate_limited'],
    ['overloaded', 'rate_limited'],
    ['server_error', 'transient'],
    ['invalid_request', 'unknown'],
    ['model_not_found', 'unknown'],
    ['max_output_tokens', 'unknown'],
    ['unknown', 'unknown'],
  ])('API error code %s reports a %s failure and keeps the evidence', async (code, expected) => {
    const text = `API Error: vendor text for ${code}`;
    mockQuery.mockImplementation(async function* () {
      yield syntheticAssistantMessage(code, text);
      yield apiErrorResult(text);
    });

    const stream = await collect(client.sendQuery('test', '/workspace'));
    const result = onlyResult(stream);

    expect(result.isError).toBe(true);
    expect(result.failure).toEqual({ class: expected, evidence: text });
    // The error prose is never output.
    expect(stream.chunks.filter(c => c.type === 'assistant')).toHaveLength(0);
    // The provider makes one SDK call; retry belongs to the engine.
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  test('a reworded message with the same code keeps the same class', async () => {
    const classes: unknown[] = [];
    for (const text of ['Invalid API key · Fix external API key', 'Unauthorized: key revoked']) {
      mockQuery.mockImplementation(async function* () {
        yield syntheticAssistantMessage('authentication_failed', text);
        yield apiErrorResult(text);
      });
      classes.push(
        (
          onlyResult(await collect(client.sendQuery('test', '/workspace'))).failure as {
            class: string;
          }
        ).class
      );
    }
    expect(classes).toEqual(['auth', 'auth']);
  });

  test('text that reads as a different class does not change the code’s class', async () => {
    // "rate limit" and "401" in the words of a server_error stay transient.
    const text = 'rate limit reached, 401 unauthorized, credit balance too low';
    mockQuery.mockImplementation(async function* () {
      yield syntheticAssistantMessage('server_error', text);
      yield apiErrorResult(text);
    });

    const result = onlyResult(await collect(client.sendQuery('test', '/workspace')));
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
    mockQuery.mockImplementation(async function* () {
      yield syntheticAssistantMessage('unknown', text);
      yield apiErrorResult(text, status);
    });

    const result = onlyResult(await collect(client.sendQuery('test', '/workspace')));
    expect((result.failure as { class: string }).class).toBe(expected);
  });

  test('a rate limit inside a rejected subscription window is an exhausted quota with its reset', async () => {
    const text = "You've hit your session limit · resets 3pm";
    mockQuery.mockImplementation(async function* () {
      yield {
        type: 'rate_limit_event',
        rate_limit_info: { status: 'rejected', resetsAt: 1790367600, rateLimitType: 'five_hour' },
      };
      yield syntheticAssistantMessage('rate_limit', text);
      yield apiErrorResult(text, 429);
    });

    const result = onlyResult(await collect(client.sendQuery('test', '/workspace')));
    expect(result.failure).toEqual({
      class: 'quota_exhausted',
      resetAt: new Date(1790367600 * 1000).toISOString(),
      evidence: text,
    });
  });

  test('a rate limit while the subscription window is still allowed is load shedding', async () => {
    mockQuery.mockImplementation(async function* () {
      yield {
        type: 'rate_limit_event',
        rate_limit_info: { status: 'allowed_warning', resetsAt: 1790367600 },
      };
      yield syntheticAssistantMessage('rate_limit', 'Rate limited · Try again later');
      yield apiErrorResult('Rate limited · Try again later', 429);
    });

    const result = onlyResult(await collect(client.sendQuery('test', '/workspace')));
    expect(result.failure).toEqual({
      class: 'rate_limited',
      evidence: 'Rate limited · Try again later',
    });
  });

  test('an api_error result without a synthetic message is still a failure', async () => {
    mockQuery.mockImplementation(async function* () {
      yield apiErrorResult('Something went wrong upstream');
    });

    const result = onlyResult(await collect(client.sendQuery('test', '/workspace')));
    expect(result.failure).toEqual({ class: 'unknown', evidence: 'Something went wrong upstream' });
  });

  test('a spend-limit result reports budget_exceeded and keeps its cost and subtype', async () => {
    mockQuery.mockImplementation(async function* () {
      yield {
        type: 'result',
        subtype: 'error_max_budget_usd',
        is_error: true,
        errors: ['Reached maximum budget ($0.50)'],
        total_cost_usd: 0.51,
        session_id: 'sid-budget',
      };
    });

    const result = onlyResult(await collect(client.sendQuery('test', '/workspace')));
    expect(result.failure).toEqual({
      class: 'budget_exceeded',
      evidence: 'error_max_budget_usd: Reached maximum budget ($0.50)',
    });
    expect(result.errorSubtype).toBe('error_max_budget_usd');
    expect(result.errors).toEqual(['Reached maximum budget ($0.50)']);
    expect(result.cost).toBeCloseTo(0.51);
  });

  test('an error_during_execution result keeps its subtype and reports unknown', async () => {
    mockQuery.mockImplementation(async function* () {
      yield {
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        errors: ['No conversation found with session ID: stale'],
        session_id: 'sid-stale',
      };
    });

    const result = onlyResult(await collect(client.sendQuery('test', '/workspace', 'stale')));
    expect(result.errorSubtype).toBe('error_during_execution');
    expect(result.failure).toEqual({
      class: 'unknown',
      evidence: 'error_during_execution: No conversation found with session ID: stale',
    });
  });

  test('a stream ending after a synthetic error reports it as the failure', async () => {
    mockQuery.mockImplementation(async function* () {
      yield syntheticAssistantMessage('billing_error', 'Credit balance is too low');
      // stream ends abnormally — no result event
    });

    const stream = await collect(client.sendQuery('test', '/workspace'));
    const result = onlyResult(stream);
    expect(result.failure).toEqual({
      class: 'quota_exhausted',
      evidence: 'Credit balance is too low',
    });
    expect(stream.chunks.filter(c => c.type === 'assistant')).toHaveLength(0);
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

  test('a thrown error with no typed field is unknown whatever its words say', async () => {
    mockQuery.mockImplementation(async function* () {
      throw new Error('process exited with code 1: unauthorized, rate limit');
    });

    const result = onlyResult(await collect(client.sendQuery('test', '/workspace')));
    expect((result.failure as { class: string }).class).toBe('unknown');
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  // The SDK reports a spawn failure caused by a MISSING WORKING DIRECTORY as a
  // libc/architecture mismatch, because posix_spawn returns ENOENT against the
  // executable's path and the SDK only checks that the executable exists.
  test('a launch failure in a missing working directory names the directory', async () => {
    mockQuery.mockImplementation(async function* () {
      throw sdkThrown(
        'Claude Code native binary at /pkg/claude exists but failed to launch. ' +
          "This usually means the binary does not match this system's libc.",
        { errorClass: 'executable_launch_failed' }
      );
    });

    const result = onlyResult(
      await collect(client.sendQuery('test', '/worktrees/removed-by-cleanup'))
    );
    const failure = result.failure as { class: string; evidence: string };
    expect(failure.class).toBe('unknown');
    expect(failure.evidence).toMatch(
      /working directory "\/worktrees\/removed-by-cleanup" does not exist/
    );
    expect(failure.evidence).toMatch(/The binary is fine/);
  });

  test('a launch failure in an existing working directory keeps the SDK message', async () => {
    const message = 'Claude Code native binary at /pkg/claude exists but failed to launch.';
    mockQuery.mockImplementation(async function* () {
      throw sdkThrown(message, { errorClass: 'executable_launch_failed' });
    });

    const result = onlyResult(await collect(client.sendQuery('test', process.cwd())));
    expect(result.failure).toEqual({ class: 'unknown', evidence: message });
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
    mockQuery.mockImplementation(async function* () {
      yield {
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
      };
      yield {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'done',
        session_id: 'sid-legit',
      };
    });

    const stream = await collect(client.sendQuery('test', '/workspace'));
    expect(
      stream.chunks.some(c => typeof c.content === 'string' && c.content.includes('Not logged in'))
    ).toBe(true);
    const result = onlyResult(stream);
    expect(result).not.toHaveProperty('isError');
    expect(result).not.toHaveProperty('failure');
  });

  test('#1425 stop-sequence carve-out is preserved (is_error + subtype success without API-error signals)', async () => {
    mockQuery.mockImplementation(async function* () {
      yield {
        type: 'assistant',
        message: {
          model: 'claude-sonnet-4-5',
          content: [{ type: 'text', text: 'Rate limit guidance: back off exponentially.' }],
        },
        session_id: 'sid-stop-seq',
      };
      yield {
        type: 'result',
        subtype: 'success',
        is_error: true,
        stop_reason: 'stop_sequence',
        session_id: 'sid-stop-seq',
      };
    });

    const result = onlyResult(await collect(client.sendQuery('test', '/workspace')));
    expect(result).not.toHaveProperty('isError');
    expect(result).not.toHaveProperty('failure');
    expect(mockLogger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'sid-stop-seq' }),
      'claude.result_success_validated'
    );
  });

  test('real-model message carrying an error code (e.g. max_output_tokens) is not suppressed', async () => {
    // A REAL (non-synthetic) message can carry a wrapper error code alongside
    // genuine truncated output. Only '<synthetic>' content is SDK error prose.
    mockQuery.mockImplementation(async function* () {
      yield {
        type: 'assistant',
        message: {
          model: 'claude-sonnet-4-5',
          content: [{ type: 'text', text: 'partial output before truncation' }],
        },
        error: 'max_output_tokens',
        session_id: 'sid-trunc',
      };
      yield {
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: 'sid-trunc',
      };
    });

    const stream = await collect(client.sendQuery('test', '/workspace'));
    expect(stream.chunks.some(c => c.content === 'partial output before truncation')).toBe(true);
    expect(onlyResult(stream)).not.toHaveProperty('failure');
  });

  test('fail-safe: synthetic error contradicted by a clean result yields the withheld text late', async () => {
    mockQuery.mockImplementation(async function* () {
      yield syntheticAssistantMessage('server_error', 'Upstream hiccup');
      yield {
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: 'sid-recovered',
      };
    });

    const stream = await collect(client.sendQuery('test', '/workspace'));
    expect(stream.chunks.some(c => c.type === 'assistant' && c.content === 'Upstream hiccup')).toBe(
      true
    );
    expect(onlyResult(stream)).not.toHaveProperty('failure');
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'server_error' }),
      'claude.synthetic_error_not_confirmed'
    );
  });

  test('conforms to the provider contract', async () => {
    function turn(events: unknown[] | Error): () => AsyncIterable<unknown> {
      return () => {
        mockQuery.mockImplementation(async function* () {
          if (events instanceof Error) throw events;
          yield* events;
        });
        return client.sendQuery('test', '/workspace');
      };
    }
    const violations = await runProviderConformance({
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
            { type: 'result', subtype: 'success', is_error: false, session_id: 's' },
            { type: 'system', subtype: 'session_state_changed', state: 'idle' },
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
          expected: 'rate_limited',
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
          name: 'unclassified error',
          expected: 'unknown',
          evidence: 'something unexpected',
          run: turn(new Error('something unexpected')),
        },
      ],
    });
    expect(violations).toEqual([]);
  });
});
