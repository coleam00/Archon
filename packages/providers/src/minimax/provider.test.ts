import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { createMockLogger } from '../test/mocks/logger';

const mockLogger = createMockLogger();
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
}));

import { MiniMaxProvider } from './provider';
import { parseMiniMaxConfig } from './config';
import { MINIMAX_CAPABILITIES } from './capabilities';

// ─── Config parser tests ─────────────────────────────────────────────────

describe('parseMiniMaxConfig', () => {
  test('returns empty object for empty input', () => {
    expect(parseMiniMaxConfig({})).toEqual({});
  });

  test('parses model field', () => {
    expect(parseMiniMaxConfig({ model: 'MiniMax-M2.7' })).toEqual({ model: 'MiniMax-M2.7' });
  });

  test('parses baseURL field', () => {
    const cfg = parseMiniMaxConfig({ baseURL: 'https://api.minimaxi.com/v1' });
    expect(cfg.baseURL).toBe('https://api.minimaxi.com/v1');
  });

  test('ignores invalid model type', () => {
    expect(parseMiniMaxConfig({ model: 42 })).toEqual({});
  });

  test('ignores invalid baseURL type', () => {
    expect(parseMiniMaxConfig({ baseURL: true })).toEqual({});
  });

  test('ignores unknown fields', () => {
    const cfg = parseMiniMaxConfig({ model: 'MiniMax-M2.7', unknown: 'field' });
    expect(cfg).toEqual({ model: 'MiniMax-M2.7' });
  });
});

// ─── Capabilities tests ──────────────────────────────────────────────────

describe('MINIMAX_CAPABILITIES', () => {
  test('has expected capability flags', () => {
    expect(MINIMAX_CAPABILITIES).toEqual({
      sessionResume: false,
      mcp: false,
      hooks: false,
      skills: false,
      toolRestrictions: false,
      structuredOutput: false,
      envInjection: true,
      costControl: false,
      effortControl: false,
      thinkingControl: false,
      fallbackModel: false,
      sandbox: false,
    });
  });
});

// ─── MiniMaxProvider unit tests ───────────────────────────────────────────

describe('MiniMaxProvider', () => {
  let provider: MiniMaxProvider;

  beforeEach(() => {
    provider = new MiniMaxProvider({ retryBaseDelayMs: 1 });
    mockLogger.error.mockClear();
    mockLogger.warn.mockClear();
    mockLogger.info.mockClear();
    mockLogger.debug.mockClear();
  });

  describe('getType', () => {
    test('returns minimax', () => {
      expect(provider.getType()).toBe('minimax');
    });
  });

  describe('getCapabilities', () => {
    test('returns MINIMAX_CAPABILITIES', () => {
      expect(provider.getCapabilities()).toEqual(MINIMAX_CAPABILITIES);
    });

    test('sessionResume is false', () => {
      expect(provider.getCapabilities().sessionResume).toBe(false);
    });

    test('envInjection is true', () => {
      expect(provider.getCapabilities().envInjection).toBe(true);
    });

    test('mcp and hooks are false', () => {
      const caps = provider.getCapabilities();
      expect(caps.mcp).toBe(false);
      expect(caps.hooks).toBe(false);
    });
  });

  describe('sendQuery', () => {
    test('throws when MINIMAX_API_KEY is not set', async () => {
      // Ensure no API key in env
      const origKey = process.env.MINIMAX_API_KEY;
      delete process.env.MINIMAX_API_KEY;

      try {
        const gen = provider.sendQuery('hello', '/tmp');
        await expect(gen.next()).rejects.toThrow('MINIMAX_API_KEY is not set');
      } finally {
        if (origKey !== undefined) process.env.MINIMAX_API_KEY = origKey;
      }
    });

    test('uses injected env API key over process env', async () => {
      const origKey = process.env.MINIMAX_API_KEY;
      delete process.env.MINIMAX_API_KEY;

      // Mock fetch to return a minimal SSE response
      const mockFetch = mock(() =>
        Promise.resolve(
          new Response('data: {"choices":[{"delta":{"content":"hi"},"index":0}]}\ndata: [DONE]\n', {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
          })
        )
      );
      globalThis.fetch = mockFetch as typeof globalThis.fetch;

      try {
        const gen = provider.sendQuery('hello', '/tmp', undefined, {
          env: { MINIMAX_API_KEY: 'injected-key' },
        });
        const chunks: unknown[] = [];
        for await (const chunk of gen) {
          chunks.push(chunk);
        }
        // Should have called fetch with the right auth header
        expect(mockFetch).toHaveBeenCalled();
        const callArgs = mockFetch.mock.calls[0] as [string, RequestInit];
        const headers = callArgs[1].headers as Record<string, string>;
        expect(headers['Authorization']).toBe('Bearer injected-key');
      } finally {
        if (origKey !== undefined) process.env.MINIMAX_API_KEY = origKey;
      }
    });

    test('aborts immediately if abortSignal is already aborted', async () => {
      process.env.MINIMAX_API_KEY = 'test-key';
      const controller = new AbortController();
      controller.abort();

      const gen = provider.sendQuery('hello', '/tmp', undefined, {
        abortSignal: controller.signal,
      });
      await expect(gen.next()).rejects.toThrow('Query aborted');
    });

    test('uses default model MiniMax-M2.7 when none specified', async () => {
      process.env.MINIMAX_API_KEY = 'test-key';

      const mockFetch = mock(() =>
        Promise.resolve(
          new Response('data: {"choices":[{"delta":{"content":"ok"},"index":0}]}\ndata: [DONE]\n', {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
          })
        )
      );
      globalThis.fetch = mockFetch as typeof globalThis.fetch;

      const chunks: unknown[] = [];
      for await (const chunk of provider.sendQuery('hello', '/tmp')) {
        chunks.push(chunk);
      }

      const callArgs = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(callArgs[1].body as string) as Record<string, unknown>;
      expect(body.model).toBe('MiniMax-M2.7');
    });

    test('uses custom model when specified via requestOptions', async () => {
      process.env.MINIMAX_API_KEY = 'test-key';

      const mockFetch = mock(() =>
        Promise.resolve(
          new Response('data: {"choices":[{"delta":{"content":"ok"},"index":0}]}\ndata: [DONE]\n', {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
          })
        )
      );
      globalThis.fetch = mockFetch as typeof globalThis.fetch;

      for await (const _ of provider.sendQuery('hello', '/tmp', undefined, {
        model: 'MiniMax-M2.7-highspeed',
      })) {
        // consume
      }

      const callArgs = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(callArgs[1].body as string) as Record<string, unknown>;
      expect(body.model).toBe('MiniMax-M2.7-highspeed');
    });

    test('includes system prompt when provided', async () => {
      process.env.MINIMAX_API_KEY = 'test-key';

      const mockFetch = mock(() =>
        Promise.resolve(
          new Response('data: [DONE]\n', {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
          })
        )
      );
      globalThis.fetch = mockFetch as typeof globalThis.fetch;

      for await (const _ of provider.sendQuery('hello', '/tmp', undefined, {
        systemPrompt: 'Be concise.',
      })) {
        // consume
      }

      const callArgs = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(callArgs[1].body as string) as {
        messages: { role: string; content: string }[];
      };
      expect(body.messages[0]).toEqual({ role: 'system', content: 'Be concise.' });
    });

    test('uses custom base URL from assistantConfig', async () => {
      process.env.MINIMAX_API_KEY = 'test-key';

      const mockFetch = mock(() =>
        Promise.resolve(
          new Response('data: [DONE]\n', {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
          })
        )
      );
      globalThis.fetch = mockFetch as typeof globalThis.fetch;

      for await (const _ of provider.sendQuery('hello', '/tmp', undefined, {
        assistantConfig: { baseURL: 'https://api.minimaxi.com/v1' },
      })) {
        // consume
      }

      const callArgs = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(callArgs[0]).toContain('api.minimaxi.com');
    });

    test('temperature is always 1.0 in request body', async () => {
      process.env.MINIMAX_API_KEY = 'test-key';

      const mockFetch = mock(() =>
        Promise.resolve(
          new Response('data: [DONE]\n', {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
          })
        )
      );
      globalThis.fetch = mockFetch as typeof globalThis.fetch;

      for await (const _ of provider.sendQuery('hello', '/tmp')) {
        // consume
      }

      const callArgs = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(callArgs[1].body as string) as Record<string, unknown>;
      expect(body.temperature).toBe(1.0);
    });

    test('throws on auth error without retry', async () => {
      process.env.MINIMAX_API_KEY = 'bad-key';

      const mockFetch = mock(() =>
        Promise.resolve(
          new Response('{"error":"unauthorized"}', {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          })
        )
      );
      globalThis.fetch = mockFetch as typeof globalThis.fetch;

      const gen = provider.sendQuery('hello', '/tmp');
      await expect(gen.next()).rejects.toThrow('MiniMax auth error');
      // Should NOT retry on auth errors
      expect(mockFetch.mock.calls.length).toBe(1);
    });

    test('yields assistant chunk and result chunk from streaming response', async () => {
      process.env.MINIMAX_API_KEY = 'test-key';

      const sseBody =
        'data: {"choices":[{"delta":{"content":"Hello"},"index":0}]}\n' +
        'data: {"choices":[{"delta":{"content":" world"},"index":0}]}\n' +
        'data: [DONE]\n';

      const mockFetch = mock(() =>
        Promise.resolve(
          new Response(sseBody, {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
          })
        )
      );
      globalThis.fetch = mockFetch as typeof globalThis.fetch;

      const chunks: unknown[] = [];
      for await (const chunk of provider.sendQuery('hi', '/tmp')) {
        chunks.push(chunk);
      }

      expect(chunks).toContainEqual({ type: 'assistant', content: 'Hello' });
      expect(chunks).toContainEqual({ type: 'assistant', content: ' world' });
      // Last chunk should be result
      const last = chunks[chunks.length - 1] as { type: string };
      expect(last.type).toBe('result');
    });

    test('yields result chunk with token usage when provided', async () => {
      process.env.MINIMAX_API_KEY = 'test-key';

      const sseBody =
        'data: {"choices":[{"delta":{"content":"hi"},"index":0}]}\n' +
        'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n' +
        'data: [DONE]\n';

      const mockFetch = mock(() =>
        Promise.resolve(
          new Response(sseBody, {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
          })
        )
      );
      globalThis.fetch = mockFetch as typeof globalThis.fetch;

      const chunks: unknown[] = [];
      for await (const chunk of provider.sendQuery('hi', '/tmp')) {
        chunks.push(chunk);
      }

      const resultChunk = chunks.find(
        (c): c is { type: 'result'; tokens: { input: number; output: number } } =>
          (c as { type: string }).type === 'result'
      );
      expect(resultChunk?.tokens).toEqual({ input: 10, output: 5 });
    });
  });
});
