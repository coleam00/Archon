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
import { AiderDeskClient, parseSseFrame, type FetchFn } from './client';
import { AiderDeskApiError } from './errors';
import type { AiderDeskSseEvent, AiderDeskTask, AiderDeskTaskFull } from './types';

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Create a mock task full response. Used by tests that load tasks for message
 * inspection (e.g. resume scenarios) — most tests now mock the bind / stream
 * roundtrip directly and skip the messages-roundtrip shape entirely.
 */
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

function mockTaskRow(overrides: Partial<AiderDeskTask> = {}): AiderDeskTask {
  return {
    id: 'task-123',
    name: 'Test Task',
    state: 'TODO',
    workingMode: 'local',
    currentMode: 'code',
    mainModel: null,
    provider: null,
    model: null,
    agentProfileId: null,
    reasoningEffort: null,
    thinkingTokens: null,
    parentId: null,
    archived: false,
    baseDir: '/test',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    startedAt: null,
    completedAt: null,
    interruptedAt: null,
    aiderTotalCost: 0,
    agentTotalCost: 0,
    lastAgentProviderMetadata: null,
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

/** Build a synthetic Response whose body is a stream of SSE frames. */
function sseResponse(events: AiderDeskSseEvent[], contentType = 'text/event-stream'): Response {
  const text = events
    .map(ev => {
      // Match AiderDesk's wire format: the event type lives on the `event:`
      // line only — `kind` is NOT inside the data payload. For `task-updated`
      // the data IS the bare task object (the inner AiderDeskTask fields), so
      // we unwrap `ev.task` before serialization.
      const name = ev.kind;
      const payload =
        name === 'task-updated'
          ? ev.task
          : Object.fromEntries(Object.entries(ev).filter(([k]) => k !== 'kind'));
      const dataStr = JSON.stringify(payload);
      return `event: ${name}\ndata: ${dataStr}\n\n`;
    })
    .join('');
  const encoded = new TextEncoder().encode(text);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoded);
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': contentType },
  });
}

/** Build a synthetic JSON Response (for non-streaming endpoints). */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Build a fetch counter / recorder that matches our test fixtures.
 *
 * Each test installs its own dispatcher and we hand-count and assert. This
 * is intentionally NOT a generic mock library — we want the controller path
 * (URL, body, headers) to stay visible and editable.
 */
type Recorder = {
  fetch: FetchFn;
  calls: Array<{ url: string; init?: RequestInit }>;
};
function recorder(): Recorder {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl: FetchFn = (async (url: string, init?: RequestInit) => {
    calls.push({ url: url as string, init });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as FetchFn;
  return { fetch: fetchImpl, calls };
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('AiderDeskProvider', () => {
  let rec: Recorder;
  beforeEach(() => {
    rec = recorder();
  });

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
      expect(AIDERDESK_CAPABILITIES.sessionResume).toBe(true);
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

    it('binds mainModel on the task before run-prompt', async () => {
      const freshTask = mockTaskRow({ id: 'task-new', state: 'TODO' });
      const boundTask = mockTaskRow({
        id: 'task-new',
        state: 'TODO',
        mainModel: 'poe/minimax-m3',
        currentMode: 'agent',
      });

      const rec2: Recorder = { calls: [], fetch: undefined as unknown as FetchFn };
      const recFetch: FetchFn = (async (url: string, init?: RequestInit) => {
        rec2.calls.push({ url: url as string, init });
        const u = url as string;
        if (u.endsWith('/project/tasks/new')) {
          return jsonResponse(freshTask);
        }
        if (u.endsWith('/project/tasks') && init?.method === 'POST') {
          // Echo the updates back so the provider's updatedTask returns a task.
          const body = init.body ? JSON.parse(init.body as string) : {};
          return jsonResponse({ ...boundTask, ...body.updates });
        }
        if (u.endsWith('/run-prompt')) {
          return sseResponse([
            {
              kind: 'response-chunk',
              taskId: 'task-new',
              messageId: 'm1',
              chunk: 'Hello',
            },
            {
              kind: 'response-completed',
              taskId: 'task-new',
              messageId: 'm1',
              content: 'Hello',
            },
            { kind: 'stream-end' },
          ]);
        }
        return new Response('{}', { status: 200 });
      }) as FetchFn;
      rec2.fetch = recFetch;

      const provider = new AiderDeskProvider({ fetchFn: recFetch });
      const chunks = await collectChunks(
        provider.sendQuery('hi', '/test', undefined, {
          model: 'poe/minimax-m3',
          env: { AIDERDESK_API_URL: 'http://localhost:24337' },
        })
      );

      // Find the bind call (/project/tasks, the second POST).
      const bindCall = rec2.calls.find(
        c => c.url.endsWith('/project/tasks') && c.init?.method === 'POST'
      );
      expect(bindCall).toBeDefined();
      const bindBody = JSON.parse(bindCall!.init!.body as string);
      expect(bindBody.updates.mainModel).toBe('poe/minimax-m3');
      expect(bindBody.updates.currentMode).toBe('agent');
      expect(bindBody.id).toBe('task-new');

      // Verify run-prompt followed.
      const runPromptCall = rec2.calls.find(c => c.url.endsWith('/run-prompt'));
      expect(runPromptCall).toBeDefined();

      // Verify chunk sequence: assistant 'Hello' + result.
      const assistantChunks = chunks.filter((c: any) => c.type === 'assistant');
      expect(assistantChunks.map((c: any) => c.content)).toEqual(['Hello']);
      const resultChunk = chunks.find((c: any) => c.type === 'result') as any;
      expect(resultChunk).toBeDefined();
      expect(resultChunk.sessionId).toBe('task-new');
      expect(resultChunk.isError).toBe(false);
      expect(resultChunk.stopReason).toBe('end_turn');
      expect(resultChunk.resolvedModel?.id).toBe('poe/minimax-m3');
    });

    it('uses SSE Accept header on /api/run-prompt', async () => {
      const rec3: Recorder = { calls: [], fetch: undefined as unknown as FetchFn };
      const recFetch: FetchFn = (async (url: string, init?: RequestInit) => {
        rec3.calls.push({ url: url as string, init });
        const u = url as string;
        if (u.endsWith('/project/tasks/new')) return jsonResponse(mockTaskRow());
        if (u.endsWith('/project/tasks')) return jsonResponse(mockTaskRow());
        if (u.endsWith('/run-prompt')) {
          return sseResponse([
            { kind: 'response-completed', taskId: 't', messageId: 'm', content: 'ok' },
            { kind: 'stream-end' },
          ]);
        }
        return new Response('{}', { status: 200 });
      }) as FetchFn;
      rec3.fetch = recFetch;

      const provider = new AiderDeskProvider({ fetchFn: recFetch });
      await collectChunks(
        provider.sendQuery('hi', '/test', undefined, {
          model: 'poe/minimax-m3',
          env: { AIDERDESK_API_URL: 'http://localhost:24337' },
        })
      );

      const runPromptCall = rec3.calls.find(c => c.url.endsWith('/run-prompt'));
      expect(runPromptCall).toBeDefined();
      const headers = runPromptCall!.init!.headers as Record<string, string>;
      expect(headers.Accept).toBe('text/event-stream');
    });

    it('streams response-chunks through assistant MessageChunks', async () => {
      const rec4: Recorder = { calls: [], fetch: undefined as unknown as FetchFn };
      const recFetch: FetchFn = (async (url: string, init?: RequestInit) => {
        const u = url as string;
        if (u.endsWith('/project/tasks/new')) return jsonResponse(mockTaskRow());
        if (u.endsWith('/project/tasks')) return jsonResponse(mockTaskRow());
        if (u.endsWith('/run-prompt')) {
          return sseResponse([
            { kind: 'response-chunk', taskId: 't', messageId: 'm', chunk: 'hello' },
            { kind: 'response-chunk', taskId: 't', messageId: 'm', chunk: ' world' },
            { kind: 'response-completed', taskId: 't', messageId: 'm', content: 'hello world' },
            { kind: 'stream-end' },
          ]);
        }
        return new Response('{}', { status: 200 });
      }) as FetchFn;

      const provider = new AiderDeskProvider({ fetchFn: recFetch });
      const chunks = await collectChunks(
        provider.sendQuery('hi', '/test', undefined, {
          model: 'poe/minimax-m3',
          env: { AIDERDESK_API_URL: 'http://localhost:24337' },
        })
      );

      const assistants = chunks.filter((c: any) => c.type === 'assistant') as any[];
      expect(assistants.map(c => c.content)).toEqual(['hello', ' world']);
    });

    it('maps ask-question event to a system warning chunk', async () => {
      const recFetch: FetchFn = (async (url: string) => {
        const u = url as string;
        if (u.endsWith('/project/tasks/new')) return jsonResponse(mockTaskRow());
        if (u.endsWith('/project/tasks')) return jsonResponse(mockTaskRow());
        if (u.endsWith('/run-prompt')) {
          return sseResponse([
            {
              kind: 'ask-question',
              taskId: 't',
              question: 'Which model should I use?',
              options: ['haiku', 'sonnet'],
            },
            { kind: 'stream-end' },
          ]);
        }
        return new Response('{}', { status: 200 });
      }) as FetchFn;

      const provider = new AiderDeskProvider({ fetchFn: recFetch });
      const chunks = await collectChunks(
        provider.sendQuery('hi', '/test', undefined, {
          model: 'poe/minimax-m3',
          env: { AIDERDESK_API_URL: 'http://localhost:24337' },
        })
      );

      const systemChunks = chunks.filter((c: any) => c.type === 'system') as any[];
      expect(systemChunks.length).toBeGreaterThanOrEqual(1);
      expect(systemChunks[0].content).toContain('Which model should I use?');

      const resultChunk = chunks.find((c: any) => c.type === 'result') as any;
      expect(resultChunk.stopReason).toBe('awaiting_user_input');
    });

    it('maps completed tool event to a tool_result chunk', async () => {
      const recFetch: FetchFn = (async (url: string) => {
        const u = url as string;
        if (u.endsWith('/project/tasks/new')) return jsonResponse(mockTaskRow());
        if (u.endsWith('/project/tasks')) return jsonResponse(mockTaskRow());
        if (u.endsWith('/run-prompt')) {
          return sseResponse([
            {
              kind: 'tool',
              taskId: 't',
              messageId: 'tool-call-1',
              toolName: 'bash',
              finished: true,
              result: '42\n',
            },
            { kind: 'response-completed', taskId: 't', messageId: 'm', content: 'done' },
            { kind: 'stream-end' },
          ]);
        }
        return new Response('{}', { status: 200 });
      }) as FetchFn;

      const provider = new AiderDeskProvider({ fetchFn: recFetch });
      const chunks = await collectChunks(
        provider.sendQuery('hi', '/test', undefined, {
          model: 'poe/minimax-m3',
          env: { AIDERDESK_API_URL: 'http://localhost:24337' },
        })
      );

      const toolResult = chunks.find((c: any) => c.type === 'tool_result') as any;
      expect(toolResult).toBeDefined();
      expect(toolResult.toolName).toBe('bash');
      expect(toolResult.toolOutput).toBe('42\n');
      expect(toolResult.toolCallId).toBe('tool-call-1');
    });

    it('throws when receiving an INTERRUPTED state via task-updated', async () => {
      const recFetch: FetchFn = (async (url: string) => {
        const u = url as string;
        if (u.endsWith('/project/tasks/new')) return jsonResponse(mockTaskRow());
        if (u.endsWith('/project/tasks')) return jsonResponse(mockTaskRow());
        if (u.endsWith('/run-prompt')) {
          return sseResponse([
            { kind: 'task-updated', task: mockTaskRow({ state: 'INTERRUPTED' }) },
            { kind: 'stream-end' },
          ]);
        }
        return new Response('{}', { status: 200 });
      }) as FetchFn;

      const provider = new AiderDeskProvider({ fetchFn: recFetch });
      const chunks = await collectChunks(
        provider.sendQuery('hi', '/test', undefined, {
          model: 'poe/minimax-m3',
          env: { AIDERDESK_API_URL: 'http://localhost:24337' },
        })
      );

      const resultChunk = chunks.find((c: any) => c.type === 'result') as any;
      expect(resultChunk).toBeDefined();
      expect(resultChunk.isError).toBe(true);
      expect(resultChunk.stopReason).toBe('interrupted');
    });

    it('creates a new task and runs prompt when no resumeSessionId', async () => {
      const recFetch: FetchFn = (async (url: string) => {
        const u = url as string;
        if (u.endsWith('/project/tasks/new')) return jsonResponse(mockTaskRow());
        if (u.endsWith('/project/tasks')) return jsonResponse(mockTaskRow());
        if (u.endsWith('/run-prompt')) {
          return sseResponse([
            {
              kind: 'response-completed',
              taskId: 'task-123',
              messageId: 'm',
              content: 'Hello from AiderDesk!',
            },
            { kind: 'stream-end' },
          ]);
        }
        return new Response('{}', { status: 200 });
      }) as FetchFn;

      const provider = new AiderDeskProvider({ fetchFn: recFetch });
      const chunks = await collectChunks(
        provider.sendQuery('hello', '/test', undefined, {
          model: 'poe/minimax-m3',
          env: { AIDERDESK_API_URL: 'http://localhost:24337' },
        })
      );

      // Should NOT have an assistant 'Hello' chunk — the whole string came
      // through as a response-completed. Final result still gets `end_turn`.
      const resultChunk = chunks.find((c: any) => c.type === 'result') as any;
      expect(resultChunk).toBeDefined();
      expect(resultChunk.sessionId).toBe('task-123');
      expect(resultChunk.isError).toBe(false);
      expect(resultChunk.stopReason).toBe('end_turn');
      // No resume was attempted → no `resumed` flag.
      expect(resultChunk.resumed).toBeUndefined();
    });

    it('resumes existing task when resumeSessionId is provided', async () => {
      const recFetch: FetchFn = (async (url: string) => {
        const u = url as string;
        if (u.endsWith('/project/tasks/load') && !u.includes('?projectDir=')) {
          return jsonResponse(mockTaskFull({ id: 'existing-task-id', state: 'IN_PROGRESS' }));
        }
        // Some implementations encode projectDir in the body.
        if (u.endsWith('/project/tasks/load')) {
          return jsonResponse(mockTaskFull({ id: 'existing-task-id', state: 'IN_PROGRESS' }));
        }
        if (u.endsWith('/project/tasks')) return jsonResponse(mockTaskRow());
        if (u.endsWith('/run-prompt')) {
          return sseResponse([
            {
              kind: 'response-completed',
              taskId: 'existing-task-id',
              messageId: 'm',
              content: 'Resumed!',
            },
            { kind: 'stream-end' },
          ]);
        }
        return new Response('{}', { status: 200 });
      }) as FetchFn;

      const provider = new AiderDeskProvider({ fetchFn: recFetch });
      const chunks = await collectChunks(
        provider.sendQuery('continue', '/test', 'existing-task-id', {
          model: 'poe/minimax-m3',
          env: { AIDERDESK_API_URL: 'http://localhost:24337' },
        })
      );

      const resultChunk = chunks.find((c: any) => c.type === 'result') as any;
      expect(resultChunk.sessionId).toBe('existing-task-id');
      expect(resultChunk.resumed).toBe(true);
    });

    it('yields resume failure warning when loadTask fails', async () => {
      const recFetch: FetchFn = (async (url: string) => {
        const u = url as string;
        if (u.endsWith('/project/tasks/load')) return new Response('Not found', { status: 404 });
        if (u.endsWith('/project/tasks/new')) return jsonResponse(mockTaskRow());
        if (u.endsWith('/project/tasks')) return jsonResponse(mockTaskRow());
        if (u.endsWith('/run-prompt')) {
          return sseResponse([
            {
              kind: 'response-completed',
              taskId: 'task-123',
              messageId: 'm',
              content: 'Fresh start!',
            },
            { kind: 'stream-end' },
          ]);
        }
        return new Response('{}', { status: 200 });
      }) as FetchFn;

      const provider = new AiderDeskProvider({ fetchFn: recFetch });
      const chunks = await collectChunks(
        provider.sendQuery('hello', '/test', 'bad-task-id', {
          model: 'poe/minimax-m3',
          env: { AIDERDESK_API_URL: 'http://localhost:24337' },
        })
      );

      const systemChunks = chunks.filter((c: any) => c.type === 'system') as any[];
      expect(systemChunks.length).toBeGreaterThanOrEqual(1);
      expect(systemChunks[0].content).toContain('Could not resume');

      const resultChunk = chunks.find((c: any) => c.type === 'result') as any;
      expect(resultChunk.resumed).toBe(false);
    });

    it('yields error result when run-prompt returns a non-2xx response', async () => {
      const recFetch: FetchFn = (async (url: string) => {
        const u = url as string;
        if (u.endsWith('/project/tasks/new')) return jsonResponse(mockTaskRow());
        if (u.endsWith('/project/tasks')) return jsonResponse(mockTaskRow());
        if (u.endsWith('/run-prompt'))
          return new Response('Internal Server Error', { status: 500 });
        return new Response('{}', { status: 200 });
      }) as FetchFn;

      const provider = new AiderDeskProvider({ fetchFn: recFetch });
      const chunks = await collectChunks(
        provider.sendQuery('hello', '/test', undefined, {
          model: 'poe/minimax-m3',
          env: { AIDERDESK_API_URL: 'http://localhost:24337' },
        })
      );

      const resultChunk = chunks.find((c: any) => c.type === 'result') as any;
      expect(resultChunk).toBeDefined();
      expect(resultChunk.isError).toBe(true);
    });

    it('handles structured output by augmenting prompt and parsing response', async () => {
      let capturedRunPromptBody: string | undefined;
      const recFetch: FetchFn = (async (url: string, init?: RequestInit) => {
        const u = url as string;
        if (u.endsWith('/project/tasks/new')) return jsonResponse(mockTaskRow());
        if (u.endsWith('/project/tasks')) return jsonResponse(mockTaskRow());
        if (u.endsWith('/run-prompt')) {
          // Capture body so we can assert against the augmentation after the
          // response has been streamed — calling expect inside the closure
          // throws before runPromptStream can dispatch the response-chunk
          // and finalize the result chunk with structuredOutput.
          capturedRunPromptBody = (init?.body as string) ?? '';
          return sseResponse([
            {
              kind: 'response-completed',
              taskId: 't',
              messageId: 'm',
              content: '{"answer": "42"}',
            },
            { kind: 'stream-end' },
          ]);
        }
        return new Response('{}', { status: 200 });
      }) as FetchFn;

      const provider = new AiderDeskProvider({ fetchFn: recFetch });
      const chunks = await collectChunks(
        provider.sendQuery('hi', '/test', undefined, {
          model: 'poe/minimax-m3',
          env: { AIDERDESK_API_URL: 'http://localhost:24337' },
          outputFormat: {
            type: 'json_schema',
            schema: { type: 'object', properties: { answer: { type: 'string' } } },
          },
        })
      );

      expect(capturedRunPromptBody).toContain('Respond with ONLY a JSON object');
      // capturedRunPromptBody is JSON.stringify(init.body) so inner quotes are
      // escaped — look for the schema property name "answer" in JSON-escape form.
      expect(capturedRunPromptBody).toContain('\\"answer\\"');

      const resultChunk = chunks.find((c: any) => c.type === 'result') as any;
      expect(resultChunk.structuredOutput).toEqual({ answer: '42' });
    });

    it('yields result chunk with sessionId even when assistant produced nothing', async () => {
      const recFetch: FetchFn = (async (url: string) => {
        const u = url as string;
        if (u.endsWith('/project/tasks/new')) return jsonResponse(mockTaskRow());
        if (u.endsWith('/project/tasks')) return jsonResponse(mockTaskRow());
        if (u.endsWith('/run-prompt')) {
          return sseResponse([
            { kind: 'response-completed', taskId: 't', messageId: 'm', content: 'silent' },
            { kind: 'stream-end' },
          ]);
        }
        return new Response('{}', { status: 200 });
      }) as FetchFn;

      const provider = new AiderDeskProvider({ fetchFn: recFetch });
      const chunks = await collectChunks(
        provider.sendQuery('hi', '/test', undefined, {
          model: 'poe/minimax-m3',
          env: { AIDERDESK_API_URL: 'http://localhost:24337' },
        })
      );

      const resultChunk = chunks.find((c: any) => c.type === 'result') as any;
      expect(resultChunk).toBeDefined();
      expect(resultChunk.sessionId).toBe('task-123');
      // We no longer carry token usage — AiderDesk's REST has no enumerable
      // per-message usageReport, so we leave the field undefined rather than
      // pinning defaults to zero. The caller can read structuredOutput if
      // they want schema-shaped output.
      expect(resultChunk.tokens).toBeUndefined();
    });
  });

  describe('parseSseFrame', () => {
    it('decodes a user-message frame', () => {
      const ev = parseSseFrame(
        'event: user-message\ndata: {"taskId":"t","baseDir":"/x","content":"hi"}'
      );
      expect(ev).toEqual({
        kind: 'user-message',
        taskId: 't',
        baseDir: '/x',
        content: 'hi',
      });
    });

    it('parses a response-chunk frame', () => {
      const ev = parseSseFrame(
        'event: response-chunk\ndata: {"taskId":"t","messageId":"m","chunk":"hello"}'
      );
      expect(ev?.kind).toBe('response-chunk');
      if (ev?.kind === 'response-chunk') {
        expect(ev.chunk).toBe('hello');
      }
    });

    it('treats stream-end as the terminal sentinel', () => {
      const ev = parseSseFrame('event: stream-end\ndata: {}');
      expect(ev).toEqual({ kind: 'stream-end' });
    });

    it('treats the conventional [DONE] sentinel as stream-end', () => {
      const ev = parseSseFrame('data: [DONE]');
      expect(ev).toEqual({ kind: 'stream-end' });
    });

    it('tolerates CRLF line endings', () => {
      const ev = parseSseFrame('event: stream-end\r\ndata: {}\r\n');
      expect(ev).toEqual({ kind: 'stream-end' });
    });

    it('falls back to event name "message" when event line is missing', () => {
      const ev = parseSseFrame('data: {"kind":"stream-end","extra":1}');
      // No `event:` line → eventName stays "message", but data is non-empty JSON,
      // so we route under `unknown` with the eventName "message".
      expect(ev?.kind).toBe('unknown');
      if (ev?.kind === 'unknown') {
        expect(ev.eventName).toBe('message');
      }
    });

    it('returns null for empty / comment-only frames', () => {
      expect(parseSseFrame('')).toBeNull();
      expect(parseSseFrame(': keepalive')).toBeNull();
      expect(parseSseFrame('\n\n')).toBeNull();
    });

    it('returns unknown-kind with raw payload for non-JSON data', () => {
      const ev = parseSseFrame('event: weird\ndata: not-json');
      expect(ev?.kind).toBe('unknown');
      if (ev?.kind === 'unknown') {
        expect(ev.eventName).toBe('weird');
        expect(ev.payload).toBe('not-json');
      }
    });

    it('routes task-updated events with task cast as AiderDeskTask', () => {
      const payload = JSON.stringify({
        id: 't-1',
        name: 'n',
        state: 'TODO',
        workingMode: 'local',
        currentMode: 'code',
        mainModel: null,
        provider: null,
        model: null,
        agentProfileId: null,
        reasoningEffort: null,
        thinkingTokens: null,
        parentId: null,
        archived: false,
        baseDir: '/x',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        startedAt: null,
        completedAt: null,
        interruptedAt: null,
        aiderTotalCost: 0,
        agentTotalCost: 0,
        lastAgentProviderMetadata: null,
      });
      const ev = parseSseFrame(`event: task-updated\ndata: ${payload}`);
      expect(ev?.kind).toBe('task-updated');
    });

    it('routes ask-question events with options filtered to strings', () => {
      const ev = parseSseFrame(
        'event: ask-question\ndata: {"taskId":"t","question":"q","options":["a","b"]}'
      );
      expect(ev?.kind).toBe('ask-question');
      if (ev?.kind === 'ask-question') {
        expect(ev.question).toBe('q');
        expect(ev.options).toEqual(['a', 'b']);
      }
    });

    it('handles a tool frame with finished=true and result', () => {
      const ev = parseSseFrame(
        'event: tool\ndata: {"taskId":"t","messageId":"m","toolName":"bash","finished":true,"result":"ok"}'
      );
      expect(ev?.kind).toBe('tool');
      if (ev?.kind === 'tool') {
        expect(ev.toolName).toBe('bash');
        expect(ev.finished).toBe(true);
        expect(ev.result).toBe('ok');
      }
    });
  });

  describe('AiderDeskClient.updateTask', () => {
    it('POST /api/project/tasks with {projectDir, id, updates}', async () => {
      const rec5: Recorder = { calls: [], fetch: undefined as unknown as FetchFn };
      const recFetch: FetchFn = (async (url: string, init?: RequestInit) => {
        rec5.calls.push({ url: url as string, init });
        return jsonResponse(mockTaskRow({ id: 't-1', mainModel: 'poe/minimax-m3' }));
      }) as FetchFn;
      rec5.fetch = recFetch;

      const client = new AiderDeskClient({
        apiUrl: 'http://localhost:24337',
        fetchFn: recFetch,
        timeoutMs: 5_000,
      });
      const updated = await client.updateTask('/proj', 't-1', {
        mainModel: 'poe/minimax-m3',
        currentMode: 'agent',
        workingMode: 'local',
      });

      expect(rec5.calls.length).toBe(1);
      expect(rec5.calls[0].url).toBe('http://localhost:24337/api/project/tasks');
      expect(rec5.calls[0].init?.method).toBe('POST');
      const body = JSON.parse(rec5.calls[0].init!.body as string);
      expect(body).toEqual({
        projectDir: '/proj',
        id: 't-1',
        updates: {
          mainModel: 'poe/minimax-m3',
          currentMode: 'agent',
          workingMode: 'local',
        },
      });
      expect(updated.mainModel).toBe('poe/minimax-m3');
    });
  });
});

// Touch the AiderDeskApiError export so consumers can import-class-check it
// without leaving a tree-shaking warning. (Some test runners flag unused
// imports; this is the lightest-footprint signal.)
void AiderDeskApiError;
