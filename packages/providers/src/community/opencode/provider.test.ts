import { beforeEach, describe, expect, mock, test } from 'bun:test';

import { createMockLogger } from '../../test/mocks/logger';

// ─── Mock logger ────────────────────────────────────────────────────────────
const mockLogger = createMockLogger();
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
}));

// ─── Helpers to build scripted event sequences ───────────────────────────────

type ScriptedEvent = { type: string; properties: Record<string, unknown> };

function textDeltaEvent(sessionID: string, delta: string): ScriptedEvent {
  return {
    type: 'message.part.delta',
    properties: { sessionID, messageID: 'msg1', partID: 'prt1', field: 'text', delta },
  };
}

function stepFinishEvent(
  sessionID: string,
  cost: number,
  tokens: { input: number; output: number }
): ScriptedEvent {
  return {
    type: 'message.part.updated',
    properties: {
      sessionID,
      part: {
        id: 'prt-sf',
        type: 'step-finish',
        sessionID,
        messageID: 'msg1',
        cost,
        tokens,
      },
    },
  };
}

function sessionIdleEvent(sessionID: string): ScriptedEvent {
  return { type: 'session.idle', properties: { sessionID } };
}

function sessionErrorEvent(sessionID: string, message: string): ScriptedEvent {
  return {
    type: 'session.error',
    properties: { sessionID, error: { message, code: 'ERR' } },
  };
}

async function* makeStream(events: ScriptedEvent[]): AsyncGenerator<unknown> {
  for (const e of events) yield e;
}

// ─── Mock @opencode-ai/sdk ───────────────────────────────────────────────────

const SESSION_ID = 'ses_test123';

let scriptedEvents: ScriptedEvent[] = [];

const mockSessionCreate = mock(async () => ({ data: { id: SESSION_ID } }));
const mockSessionGet = mock(async (_opts: unknown) => ({ data: { id: SESSION_ID } }));
const mockSessionPromptAsync = mock(async () => undefined);
const mockSessionAbort = mock(async () => undefined);
const mockEventSubscribe = mock(async () => ({ stream: makeStream(scriptedEvents) }));

const mockClient = {
  session: {
    create: mockSessionCreate,
    get: mockSessionGet,
    promptAsync: mockSessionPromptAsync,
    abort: mockSessionAbort,
  },
  event: {
    subscribe: mockEventSubscribe,
  },
};

mock.module('@opencode-ai/sdk', () => ({
  createOpencode: mock(async () => ({
    client: mockClient,
    server: { url: 'http://127.0.0.1:4096', close: mock(() => undefined) },
  })),
}));

// ─── Import provider AFTER mocks are wired ──────────────────────────────────
// mock.module() calls above intercept the @opencode-ai/sdk dynamic import
// that provider.ts performs lazily, so the static import below is safe.

import { OpencodeProvider } from './provider';

beforeEach(() => {
  scriptedEvents = [];
  mockSessionCreate.mockReset();
  mockSessionGet.mockReset();
  mockSessionPromptAsync.mockReset();
  mockEventSubscribe.mockReset();
  mockSessionAbort.mockReset();
  // Restore default implementations after reset.
  mockSessionCreate.mockImplementation(async () => ({ data: { id: SESSION_ID } }));
  mockSessionGet.mockImplementation(async (_opts: unknown) => ({ data: { id: SESSION_ID } }));
  mockSessionPromptAsync.mockImplementation(async () => undefined);
  mockSessionAbort.mockImplementation(async () => undefined);
  mockEventSubscribe.mockImplementation(async () => ({ stream: makeStream(scriptedEvents) }));
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('OpencodeProvider', () => {
  test('streams assistant text and emits result chunk', async () => {
    const provider = new OpencodeProvider();

    scriptedEvents = [
      textDeltaEvent(SESSION_ID, 'Hello'),
      textDeltaEvent(SESSION_ID, ' world'),
      stepFinishEvent(SESSION_ID, 0.001, { input: 100, output: 20 }),
      sessionIdleEvent(SESSION_ID),
    ];

    const chunks: Array<{ type: string; content?: string }> = [];
    for await (const chunk of provider.sendQuery('say hello', '/tmp')) {
      chunks.push(chunk as never);
    }

    const assistantChunks = chunks.filter(c => c.type === 'assistant');
    expect(assistantChunks).toEqual([
      { type: 'assistant', content: 'Hello' },
      { type: 'assistant', content: ' world' },
    ]);

    const result = chunks.find(c => c.type === 'result') as
      | { type: string; sessionId?: string; tokens?: unknown; cost?: number }
      | undefined;
    expect(result).toMatchObject({
      type: 'result',
      sessionId: SESSION_ID,
      tokens: { input: 100, output: 20, total: 120 },
      cost: 0.001,
    });
  });

  test('filters events from other sessions', async () => {
    const provider = new OpencodeProvider();

    const otherSession = 'ses_OTHER';
    scriptedEvents = [
      textDeltaEvent(otherSession, 'noise'),
      textDeltaEvent(SESSION_ID, 'signal'),
      sessionIdleEvent(otherSession), // ignored — different session
      sessionIdleEvent(SESSION_ID),
    ];

    const chunks: Array<{ type: string; content?: string }> = [];
    for await (const chunk of provider.sendQuery('test', '/tmp')) {
      chunks.push(chunk as never);
    }

    const assistantChunks = chunks.filter(c => c.type === 'assistant');
    expect(assistantChunks).toEqual([{ type: 'assistant', content: 'signal' }]);
  });

  test('yields isError result on session.error', async () => {
    const provider = new OpencodeProvider();

    scriptedEvents = [sessionErrorEvent(SESSION_ID, 'model not found')];

    const chunks: Array<{ type: string; isError?: boolean; errors?: string[] }> = [];
    for await (const chunk of provider.sendQuery('test', '/tmp')) {
      chunks.push(chunk as never);
    }

    const result = chunks.find(c => c.type === 'result');
    expect(result?.isError).toBe(true);
    expect(result?.errors).toContain('model not found');
  });

  test('yields system warning and creates new session on failed resume', async () => {
    const provider = new OpencodeProvider();

    mockSessionGet.mockImplementation(async () => {
      throw new Error('session not found');
    });

    scriptedEvents = [sessionIdleEvent(SESSION_ID)];

    const chunks: Array<{ type: string; content?: string }> = [];
    for await (const chunk of provider.sendQuery('test', '/tmp', 'ses_MISSING')) {
      chunks.push(chunk as never);
    }

    const systemChunks = chunks.filter(c => c.type === 'system');
    expect(systemChunks.length).toBeGreaterThan(0);
    expect(systemChunks[0]?.content).toContain('Could not resume');
    expect(mockSessionCreate).toHaveBeenCalled();
  });

  test('passes model spec to promptAsync when model is configured', async () => {
    const provider = new OpencodeProvider();

    scriptedEvents = [sessionIdleEvent(SESSION_ID)];

    for await (const _ of provider.sendQuery('test', '/tmp', undefined, {
      model: 'ollama/qwen3:8b',
    })) {
      // drain
    }

    expect(mockSessionPromptAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          model: { providerID: 'ollama', modelID: 'qwen3:8b' },
        }),
      })
    );
  });

  test('omits model field when no model specified', async () => {
    const provider = new OpencodeProvider();

    scriptedEvents = [sessionIdleEvent(SESSION_ID)];

    for await (const _ of provider.sendQuery('test', '/tmp')) {
      // drain
    }

    const callArg = mockSessionPromptAsync.mock.calls[
      mockSessionPromptAsync.mock.calls.length - 1
    ]?.[0] as { body?: { model?: unknown } } | undefined;
    expect(callArg?.body?.model).toBeUndefined();
  });

  test('yields system warning for invalid model format', async () => {
    const provider = new OpencodeProvider();

    scriptedEvents = [sessionIdleEvent(SESSION_ID)];

    const chunks: Array<{ type: string; content?: string }> = [];
    for await (const chunk of provider.sendQuery('test', '/tmp', undefined, {
      model: 'invalid-no-slash',
    })) {
      chunks.push(chunk as never);
    }

    const warnings = chunks.filter(c => c.type === 'system');
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]?.content).toContain('invalid model format');
  });

  test('getType returns opencode', () => {
    expect(new OpencodeProvider().getType()).toBe('opencode');
  });

  test('getCapabilities returns OPENCODE_CAPABILITIES', () => {
    const provider = new OpencodeProvider();
    expect(provider.getCapabilities().sessionResume).toBe(true);
    expect(provider.getCapabilities().structuredOutput).toBe(true);
    expect(provider.getCapabilities().mcp).toBe(false);
  });
});
