import { mock, describe, it, expect, beforeEach } from 'bun:test';
import type { Logger } from 'pino';

// Mock logger — must be set up before importing any @archon/paths consumer
const mockLogger = {
  fatal: mock(() => undefined),
  error: mock(() => undefined),
  warn: mock(() => undefined),
  info: mock(() => undefined),
  debug: mock(() => undefined),
  trace: mock(() => undefined),
  child: mock(() => mockLogger),
  bindings: mock(() => ({ module: 'test' })),
  isLevelEnabled: mock(() => true),
  level: 'info',
} as unknown as Logger;

mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
}));

import { AiderDeskProvider } from './provider';
import { AIDERDESK_CAPABILITIES } from './capabilities';
import { AiderDeskClient, type FetchFn } from './client';
import { AiderDeskApiError } from './errors';
import type { AiderDeskTaskFull } from './types';

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Create a mock task full response. */
function mockTaskFull(overrides: Partial<AiderDeskTaskFull> = {}): AiderDeskTaskFull {
  return {
    id: 'task-123',
    name: 'Test Task',
    state: 'READY_FOR_REVIEW',
    workingMode: 'local',
    currentMode: 'code',
    mainModel: 'ollama/qwen3-coder:30b',
    provider: 'ollama',
    model: 'qwen3-coder:30b',
    agentProfileId: null,
    reasoningEffort: null,
    thinkingTokens: null,
    parentId: null,
    archived: false,
    baseDir: '/test',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    startedAt: '2026-01-01T00:00:00Z',
    completedAt: '2026-01-01T00:01:00Z',
    interruptedAt: null,
    aiderTotalCost: 0,
    agentTotalCost: 0,
    lastAgentProviderMetadata: null,
    messages: [],
    files: [],
    todoItems: [],
    question: null,
    ...overrides,
  };
}

/** Collect all chunks from an async generator. */
async function collectChunks(gen: AsyncGenerator<unknown>): Promise<unknown[]> {
  const chunks: unknown[] = [];
  for await (const chunk of gen) {
    chunks.push(chunk);
  }
  return chunks;
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('AiderDeskProvider', () => {
  describe('getType', () => {
    it('returns "aiderdesk"', () => {
      const provider = new AiderDeskProvider();
      expect(provider.getType()).toBe('aiderdesk');
    });
  });

  describe('getCapabilities', () => {
    it('returns AIDERDESK_CAPABILITIES', () => {
      const provider = new AiderDeskProvider();
      expect(provider.getCapabilities()).toBe(AIDERDESK_CAPABILITIES);
    });

    it('has sessionResume: true', () => {
      const caps = AIDERDESK_CAPABILITIES;
      expect(caps.sessionResume).toBe(true);
    });

    it('has structuredOutput: best-effort', () => {
      expect(AIDERDESK_CAPABILITIES.structuredOutput).toBe('best-effort');
    });

    it('has nativeTools: false', () => {
      expect(AIDERDESK_CAPABILITIES.nativeTools).toBe(false);
    });

    it('has containerExec: false', () => {
      expect(AIDERDESK_CAPABILITIES.containerExec).toBe(false);
    });
  });

  describe('sendQuery', () => {
    it('yields error result when no model is specified', async () => {
      const provider = new AiderDeskProvider();
      const chunks = await collectChunks(provider.sendQuery('hello', '/test', undefined, {}));

      // Should have system warning + result error
      const systemChunk = chunks.find((c: any) => c.type === 'system');
      const resultChunk = chunks.find((c: any) => c.type === 'result');
      expect(systemChunk).toBeDefined();
      expect(resultChunk).toBeDefined();
      expect((resultChunk as any).isError).toBe(true);
    });

    it('yields error result when model format is invalid', async () => {
      const provider = new AiderDeskProvider();
      const chunks = await collectChunks(
        provider.sendQuery('hello', '/test', undefined, { model: 'invalid-no-slash' })
      );

      const resultChunk = chunks.find((c: any) => c.type === 'result') as any;
      expect(resultChunk).toBeDefined();
      expect(resultChunk.isError).toBe(true);
      expect(resultChunk.errors[0]).toContain('Invalid model format');
    });

    it('creates a new task and runs prompt when no resumeSessionId', async () => {
      // Create a mock fetch that responds to our API calls
      const mockTask = mockTaskFull({
        messages: [{ id: 'msg-1', role: 'assistant', content: 'Hello from AiderDesk!' }],
      });

      let createdTask = false;
      let ranPrompt = false;

      const mockFetch: FetchFn = (async (url: string, init?: RequestInit) => {
        const body = init?.body ? JSON.parse(init.body as string) : {};
        const urlStr = url as string;

        if (urlStr.includes('/project/tasks/new')) {
          createdTask = true;
          return new Response(JSON.stringify(mockTaskFull({ state: 'TODO' })), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }

        if (urlStr.includes('/run-prompt')) {
          ranPrompt = true;
          return new Response(JSON.stringify(mockTask), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }

        if (urlStr.includes('/project/tasks/load')) {
          return new Response(JSON.stringify(mockTask), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }

        return new Response('{}', { status: 200 });
      }) as FetchFn;

      const provider = new AiderDeskProvider({ fetchFn: mockFetch });
      const chunks = await collectChunks(
        provider.sendQuery('hello', '/test', undefined, {
          model: 'ollama/qwen3-coder:30b',
          env: { AIDERDESK_API_URL: 'http://localhost:24337' },
        })
      );

      expect(createdTask).toBe(true);
      expect(ranPrompt).toBe(true);

      // Should have assistant chunk with the response
      const assistantChunks = chunks.filter((c: any) => c.type === 'assistant');
      expect(assistantChunks.length).toBe(1);
      expect((assistantChunks[0] as any).content).toBe('Hello from AiderDesk!');

      // Should have result chunk
      const resultChunk = chunks.find((c: any) => c.type === 'result') as any;
      expect(resultChunk).toBeDefined();
      expect(resultChunk.sessionId).toBe('task-123');
      expect(resultChunk.isError).toBe(false);
    });

    it('resumes existing task when resumeSessionId is provided', async () => {
      const mockTask = mockTaskFull({
        messages: [{ id: 'msg-1', role: 'assistant', content: 'Resumed!' }],
      });

      let loadedTask = false;

      const mockFetch: FetchFn = (async (url: string, init?: RequestInit) => {
        const urlStr = url as string;

        if (urlStr.includes('/project/tasks/load')) {
          loadedTask = true;
          return new Response(JSON.stringify(mockTask), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }

        if (urlStr.includes('/run-prompt')) {
          return new Response(JSON.stringify(mockTask), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }

        return new Response('{}', { status: 200 });
      }) as FetchFn;

      const provider = new AiderDeskProvider({ fetchFn: mockFetch });
      const chunks = await collectChunks(
        provider.sendQuery('continue', '/test', 'existing-task-id', {
          model: 'ollama/qwen3-coder:30b',
          env: { AIDERDESK_API_URL: 'http://localhost:24337' },
        })
      );

      expect(loadedTask).toBe(true);

      const resultChunk = chunks.find((c: any) => c.type === 'result') as any;
      expect(resultChunk).toBeDefined();
      expect(resultChunk.sessionId).toBe('task-123');
      expect(resultChunk.resumed).toBe(true);
    });

    it('yields resume warning and creates new task when resume fails', async () => {
      const mockTask = mockTaskFull({
        messages: [{ id: 'msg-1', role: 'assistant', content: 'Fresh start!' }],
      });

      let createdTask = false;

      const mockFetch: FetchFn = (async (url: string, init?: RequestInit) => {
        const urlStr = url as string;
        const body = init?.body ? JSON.parse(init.body as string) : {};

        if (urlStr.includes('/project/tasks/load') && body.id === 'bad-task-id') {
          return new Response('Not found', { status: 404 });
        }

        if (urlStr.includes('/project/tasks/new')) {
          createdTask = true;
          return new Response(JSON.stringify(mockTaskFull({ state: 'TODO' })), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }

        if (urlStr.includes('/run-prompt')) {
          return new Response(JSON.stringify(mockTask), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }

        return new Response('{}', { status: 200 });
      }) as FetchFn;

      const provider = new AiderDeskProvider({ fetchFn: mockFetch });
      const chunks = await collectChunks(
        provider.sendQuery('hello', '/test', 'bad-task-id', {
          model: 'ollama/qwen3-coder:30b',
          env: { AIDERDESK_API_URL: 'http://localhost:24337' },
        })
      );

      expect(createdTask).toBe(true);

      // Should have a system warning about resume failure
      const systemChunks = chunks.filter((c: any) => c.type === 'system');
      expect(systemChunks.length).toBeGreaterThanOrEqual(1);
      expect((systemChunks[0] as any).content).toContain('Could not resume');

      const resultChunk = chunks.find((c: any) => c.type === 'result') as any;
      expect(resultChunk.resumed).toBe(false);
    });

    it('yields error result when run-prompt fails', async () => {
      const mockFetch: FetchFn = (async (url: string, init?: RequestInit) => {
        const urlStr = url as string;

        if (urlStr.includes('/project/tasks/new')) {
          return new Response(JSON.stringify(mockTaskFull({ state: 'TODO' })), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }

        if (urlStr.includes('/run-prompt')) {
          return new Response('Internal Server Error', { status: 500 });
        }

        return new Response('{}', { status: 200 });
      }) as FetchFn;

      const provider = new AiderDeskProvider({ fetchFn: mockFetch });
      const chunks = await collectChunks(
        provider.sendQuery('hello', '/test', undefined, {
          model: 'ollama/qwen3-coder:30b',
          env: { AIDERDESK_API_URL: 'http://localhost:24337' },
        })
      );

      const resultChunk = chunks.find((c: any) => c.type === 'result') as any;
      expect(resultChunk).toBeDefined();
      expect(resultChunk.isError).toBe(true);
    });

    it('extracts tokens from assistant messages', async () => {
      const mockTask = mockTaskFull({
        messages: [
          {
            id: 'msg-1',
            role: 'assistant',
            content: 'Response with tokens',
            usageReport: {
              inputTokens: 100,
              outputTokens: 50,
              totalTokens: 150,
              cost: 0.001,
            },
          },
        ],
      });

      const mockFetch: FetchFn = (async (url: string) => {
        const urlStr = url as string;
        if (urlStr.includes('/project/tasks/new')) {
          return new Response(JSON.stringify(mockTaskFull({ state: 'TODO' })), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (urlStr.includes('/run-prompt')) {
          return new Response(JSON.stringify(mockTask), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response('{}', { status: 200 });
      }) as FetchFn;

      const provider = new AiderDeskProvider({ fetchFn: mockFetch });
      const chunks = await collectChunks(
        provider.sendQuery('hello', '/test', undefined, {
          model: 'ollama/qwen3-coder:30b',
          env: { AIDERDESK_API_URL: 'http://localhost:24337' },
        })
      );

      const resultChunk = chunks.find((c: any) => c.type === 'result') as any;
      expect(resultChunk.tokens).toBeDefined();
      expect(resultChunk.tokens.input).toBe(100);
      expect(resultChunk.tokens.output).toBe(50);
      expect(resultChunk.tokens.total).toBe(150);
      expect(resultChunk.tokens.cost).toBe(0.001);
    });

    it('polls when task is in non-terminal state', async () => {
      const mockTask = mockTaskFull({
        state: 'IN_PROGRESS',
        messages: [],
      });

      const mockTaskComplete = mockTaskFull({
        state: 'READY_FOR_REVIEW',
        messages: [{ id: 'msg-1', role: 'assistant', content: 'Done!' }],
      });

      let loadCount = 0;

      const mockFetch: FetchFn = (async (url: string) => {
        const urlStr = url as string;
        if (urlStr.includes('/project/tasks/new')) {
          return new Response(JSON.stringify(mockTaskFull({ state: 'TODO' })), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (urlStr.includes('/run-prompt')) {
          return new Response(JSON.stringify(mockTask), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (urlStr.includes('/project/tasks/load')) {
          loadCount++;
          // First poll returns IN_PROGRESS, second returns READY_FOR_REVIEW
          if (loadCount === 1) {
            return new Response(JSON.stringify(mockTask), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
          }
          return new Response(JSON.stringify(mockTaskComplete), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response('{}', { status: 200 });
      }) as FetchFn;

      const provider = new AiderDeskProvider({ fetchFn: mockFetch });
      const chunks = await collectChunks(
        provider.sendQuery('hello', '/test', undefined, {
          model: 'ollama/qwen3-coder:30b',
          env: { AIDERDESK_API_URL: 'http://localhost:24337' },
          assistantConfig: { pollIntervalMs: 10 },
        })
      );

      const resultChunk = chunks.find((c: any) => c.type === 'result') as any;
      expect(resultChunk).toBeDefined();
      expect(resultChunk.isError).toBe(false);

      // Should have polled at least once
      expect(loadCount).toBeGreaterThanOrEqual(1);
    });
  });
});
