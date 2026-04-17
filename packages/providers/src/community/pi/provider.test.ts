import { beforeEach, describe, expect, mock, test } from 'bun:test';

import { createMockLogger } from '../../test/mocks/logger';

// ─── Mock @archon/paths logger so provider instantiation is quiet ───────

const mockLogger = createMockLogger();
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
}));

// ─── Mock Pi SDK surface ────────────────────────────────────────────────
//
// Pi's `createAgentSession` returns a session whose `subscribe(listener)`
// stores a callback, and whose `prompt(text)` drives events through that
// callback before resolving. We reproduce that shape with a mutable
// `listener` variable plus `mockPrompt` that replays a scripted event
// sequence synchronously.

type FakeEvent = Record<string, unknown>;
let capturedListener: ((event: FakeEvent) => void) | undefined;

const scriptedEvents: FakeEvent[] = [];
const mockPrompt = mock(async () => {
  for (const ev of scriptedEvents) capturedListener?.(ev);
});
const mockAbort = mock(async () => undefined);
const mockDispose = mock(() => undefined);
const mockSubscribe = mock((listener: (event: FakeEvent) => void) => {
  capturedListener = listener;
  return () => {
    capturedListener = undefined;
  };
});

const mockSession = {
  subscribe: mockSubscribe,
  prompt: mockPrompt,
  abort: mockAbort,
  dispose: mockDispose,
  isStreaming: false,
};

const mockCreateAgentSession = mock(async () => ({
  session: mockSession,
  extensionsResult: { extensions: [], errors: [], runtime: {} },
  modelFallbackMessage: undefined,
}));

// Per-test state backing the AuthStorage mock. `fileCreds` emulates what's
// in ~/.pi/agent/auth.json; `runtimeOverrides` emulates env-var passthrough
// via setRuntimeApiKey. Tests mutate these via helpers.
let fileCreds: Record<string, { type: 'api_key' | 'oauth'; key?: string }> = {};
let runtimeOverrides: Record<string, string> = {};

const mockSetRuntimeApiKey = mock((providerId: string, key: string) => {
  runtimeOverrides[providerId] = key;
});
const mockGetApiKey = mock(async (providerId: string): Promise<string | undefined> => {
  // Mirror Pi's resolution: runtime → file api_key → file oauth → env var
  if (runtimeOverrides[providerId]) return runtimeOverrides[providerId];
  const cred = fileCreds[providerId];
  if (cred?.type === 'api_key') return cred.key;
  if (cred?.type === 'oauth') return 'oauth-access-token-stub';
  return undefined;
});
const mockAuthCreate = mock(() => ({
  setRuntimeApiKey: mockSetRuntimeApiKey,
  getApiKey: mockGetApiKey,
}));
const mockModelRegistryInMemory = mock(() => ({}));
const mockSessionManagerInMemory = mock(() => ({}));
const mockSettingsManagerInMemory = mock(() => ({}));
const MockDefaultResourceLoader = mock(function (_opts: unknown) {
  // constructor stub — no methods exercised in tests
});

// Tool factory mocks — each returns an opaque object tagged with the tool
// name so assertions can verify which tools the provider selected.
const mockCreateReadTool = mock((_cwd: string) => ({ __piTool: 'read' }));
const mockCreateBashTool = mock((_cwd: string) => ({ __piTool: 'bash' }));
const mockCreateEditTool = mock((_cwd: string) => ({ __piTool: 'edit' }));
const mockCreateWriteTool = mock((_cwd: string) => ({ __piTool: 'write' }));
const mockCreateGrepTool = mock((_cwd: string) => ({ __piTool: 'grep' }));
const mockCreateFindTool = mock((_cwd: string) => ({ __piTool: 'find' }));
const mockCreateLsTool = mock((_cwd: string) => ({ __piTool: 'ls' }));

mock.module('@mariozechner/pi-coding-agent', () => ({
  createAgentSession: mockCreateAgentSession,
  AuthStorage: { create: mockAuthCreate },
  ModelRegistry: { inMemory: mockModelRegistryInMemory },
  SessionManager: { inMemory: mockSessionManagerInMemory },
  SettingsManager: { inMemory: mockSettingsManagerInMemory },
  DefaultResourceLoader: MockDefaultResourceLoader,
  createReadTool: mockCreateReadTool,
  createBashTool: mockCreateBashTool,
  createEditTool: mockCreateEditTool,
  createWriteTool: mockCreateWriteTool,
  createGrepTool: mockCreateGrepTool,
  createFindTool: mockCreateFindTool,
  createLsTool: mockCreateLsTool,
}));

// getModel is imported from pi-ai. Return a fake model for known refs and
// undefined for unknown refs so the provider's not-found branch is testable.
const mockGetModel = mock((provider: string, modelId: string) => {
  if (provider === 'nonexistent') return undefined;
  return { id: modelId, provider, name: `${provider}/${modelId}` };
});
mock.module('@mariozechner/pi-ai', () => ({
  getModel: mockGetModel,
}));

// Import AFTER mocks are set — module resolution freezes the mocks.
import { PiProvider } from './provider';
import { PI_CAPABILITIES } from './capabilities';

// ─── Helpers ────────────────────────────────────────────────────────────

async function consume(
  generator: AsyncGenerator<unknown>
): Promise<{ chunks: unknown[]; error?: Error }> {
  const chunks: unknown[] = [];
  try {
    for await (const chunk of generator) chunks.push(chunk);
    return { chunks };
  } catch (err) {
    return { chunks, error: err as Error };
  }
}

function resetScript(events: FakeEvent[]): void {
  scriptedEvents.length = 0;
  scriptedEvents.push(...events);
}

// ─── Test suite ─────────────────────────────────────────────────────────

describe('PiProvider', () => {
  beforeEach(() => {
    mockPrompt.mockClear();
    mockAbort.mockClear();
    mockDispose.mockClear();
    mockSubscribe.mockClear();
    mockCreateAgentSession.mockClear();
    mockGetModel.mockClear();
    mockAuthCreate.mockClear();
    mockSetRuntimeApiKey.mockClear();
    mockGetApiKey.mockClear();
    MockDefaultResourceLoader.mockClear();
    mockCreateReadTool.mockClear();
    mockCreateBashTool.mockClear();
    mockCreateEditTool.mockClear();
    mockCreateWriteTool.mockClear();
    mockCreateGrepTool.mockClear();
    mockCreateFindTool.mockClear();
    mockCreateLsTool.mockClear();
    capturedListener = undefined;
    scriptedEvents.length = 0;
    fileCreds = {};
    runtimeOverrides = {};
    delete process.env.GEMINI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
  });

  test('getType returns "pi"', () => {
    expect(new PiProvider().getType()).toBe('pi');
  });

  test('getCapabilities matches PI_CAPABILITIES constant', () => {
    expect(new PiProvider().getCapabilities()).toEqual(PI_CAPABILITIES);
  });

  test('throws when no model is configured', async () => {
    const { error } = await consume(new PiProvider().sendQuery('hi', '/tmp'));
    expect(error?.message).toContain('Pi provider requires a model');
  });

  test('throws when model ref is malformed', async () => {
    const { error } = await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, { model: 'sonnet' })
    );
    expect(error?.message).toContain('Invalid Pi model ref');
  });

  test('throws when Pi provider id is unknown AND no creds available', async () => {
    // No env var, no auth.json entry → fail-fast with hint about env-var table
    const { error } = await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'unknownprovider/some-model',
      })
    );
    expect(error?.message).toContain("no credentials for provider 'unknownprovider'");
    expect(error?.message).toContain("not in the Archon adapter's env-var table");
  });

  test('throws when env var missing AND auth.json has no entry', async () => {
    // GEMINI_API_KEY not set (beforeEach deletes it), fileCreds empty
    const { error } = await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
      })
    );
    expect(error?.message).toContain('no credentials for provider');
    expect(error?.message).toContain('GEMINI_API_KEY');
    expect(error?.message).toContain('/login');
  });

  test('uses OAuth credential from ~/.pi/agent/auth.json when no env var set', async () => {
    // Simulate user running `pi /login` → auth.json has OAuth entry
    fileCreds.anthropic = { type: 'oauth' };
    resetScript([
      {
        type: 'agent_end',
        messages: [
          {
            role: 'assistant',
            usage: {
              input: 1,
              output: 1,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 2,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: 'stop',
            content: [],
          },
        ],
      },
    ]);

    const { error } = await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'anthropic/claude-haiku-4-5',
      })
    );
    expect(error).toBeUndefined();
    // Runtime override NOT set — no env var present — so Pi's getApiKey
    // resolves through the OAuth code path.
    expect(mockSetRuntimeApiKey).not.toHaveBeenCalled();
    expect(mockGetApiKey).toHaveBeenCalledWith('anthropic');
  });

  test('throws when getModel returns undefined', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    // 'nonexistent' is handled in mockGetModel to return undefined, but
    // the adapter rejects unknown providers before getModel. To exercise
    // the not-found branch, use a known provider but unknown modelId by
    // temporarily swapping mockGetModel to always return undefined.
    mockGetModel.mockImplementationOnce(() => undefined);
    const { error } = await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/unknown-model-id',
      })
    );
    expect(error?.message).toContain('Pi model not found');
  });

  test('request env (codebase env vars) overrides process.env via setRuntimeApiKey', async () => {
    process.env.GEMINI_API_KEY = 'from-process-env';
    resetScript([
      {
        type: 'agent_end',
        messages: [
          {
            role: 'assistant',
            usage: {
              input: 1,
              output: 1,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 2,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: 'stop',
            content: [],
          },
        ],
      },
    ]);

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
        env: { GEMINI_API_KEY: 'from-request-env' },
      })
    );

    expect(mockSetRuntimeApiKey).toHaveBeenCalledWith('google', 'from-request-env');
    // Runtime override is priority #1 in Pi's resolution chain, so getApiKey
    // returns 'from-request-env' (via our mock's runtimeOverrides map).
    expect(runtimeOverrides.google).toBe('from-request-env');
  });

  test('env var overrides auth.json api_key entry', async () => {
    // Both present: env var wins (mirrors Pi's resolution priority)
    fileCreds.anthropic = { type: 'api_key', key: 'from-auth-json' };
    process.env.ANTHROPIC_API_KEY = 'from-env';
    resetScript([
      {
        type: 'agent_end',
        messages: [
          {
            role: 'assistant',
            usage: {
              input: 1,
              output: 1,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 2,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: 'stop',
            content: [],
          },
        ],
      },
    ]);

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'anthropic/claude-haiku-4-5',
      })
    );
    expect(mockSetRuntimeApiKey).toHaveBeenCalledWith('anthropic', 'from-env');
  });

  test('yields assistant chunks from text_delta events', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript([
      {
        type: 'message_update',
        message: { role: 'assistant' },
        assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Hello', partial: {} },
      },
      {
        type: 'message_update',
        message: { role: 'assistant' },
        assistantMessageEvent: {
          type: 'text_delta',
          contentIndex: 0,
          delta: ' world',
          partial: {},
        },
      },
      {
        type: 'agent_end',
        messages: [
          {
            role: 'assistant',
            usage: {
              input: 1,
              output: 2,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 3,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: 'stop',
            content: [],
          },
        ],
      },
    ]);

    const { chunks, error } = await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
      })
    );
    expect(error).toBeUndefined();
    expect(chunks).toEqual([
      { type: 'assistant', content: 'Hello' },
      { type: 'assistant', content: ' world' },
      expect.objectContaining({ type: 'result', stopReason: 'stop' }),
    ]);
  });

  test('yields tool + tool_result chunks for tool_execution events', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript([
      {
        type: 'tool_execution_start',
        toolCallId: 'call-1',
        toolName: 'read',
        args: { path: '/x' },
      },
      {
        type: 'tool_execution_end',
        toolCallId: 'call-1',
        toolName: 'read',
        result: 'contents',
        isError: false,
      },
      {
        type: 'agent_end',
        messages: [
          {
            role: 'assistant',
            usage: {
              input: 1,
              output: 1,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 2,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: 'stop',
            content: [],
          },
        ],
      },
    ]);

    const { chunks } = await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
      })
    );
    expect(chunks.length).toBe(3);
    expect(chunks[0]).toMatchObject({
      type: 'tool',
      toolName: 'read',
      toolInput: { path: '/x' },
      toolCallId: 'call-1',
    });
    expect(chunks[1]).toMatchObject({
      type: 'tool_result',
      toolName: 'read',
      toolOutput: 'contents',
      toolCallId: 'call-1',
    });
    expect(chunks[2]).toMatchObject({ type: 'result' });
  });

  test('logs and ignores resumeSessionId (sessionResume: false in v1)', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript([
      {
        type: 'agent_end',
        messages: [
          {
            role: 'assistant',
            usage: {
              input: 1,
              output: 1,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 2,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: 'stop',
            content: [],
          },
        ],
      },
    ]);

    const { error } = await consume(
      new PiProvider().sendQuery('hi', '/tmp', 'some-session-id', {
        model: 'google/gemini-2.5-pro',
      })
    );
    expect(error).toBeUndefined();
    // No way to assert logger.debug was called without exposing the mock;
    // the key assertion is that resumeSessionId does NOT throw and
    // completion proceeds normally.
    expect(mockCreateAgentSession).toHaveBeenCalledTimes(1);
  });

  test('disposes session after completion', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript([
      {
        type: 'agent_end',
        messages: [
          {
            role: 'assistant',
            usage: {
              input: 1,
              output: 1,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 2,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: 'stop',
            content: [],
          },
        ],
      },
    ]);

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
      })
    );
    expect(mockDispose).toHaveBeenCalledTimes(1);
  });

  // ─── v2 wiring: thinking, tools, systemPrompt ─────────────────────────

  function scriptedAgentEnd(): FakeEvent[] {
    return [
      {
        type: 'agent_end',
        messages: [
          {
            role: 'assistant',
            usage: {
              input: 1,
              output: 1,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 2,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: 'stop',
            content: [],
          },
        ],
      },
    ];
  }

  test('nodeConfig.thinking=high passes thinkingLevel to createAgentSession', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
        nodeConfig: { thinking: 'high' },
      })
    );

    const [callArgs] = mockCreateAgentSession.mock.calls[0] as [Record<string, unknown>];
    expect(callArgs.thinkingLevel).toBe('high');
  });

  test('nodeConfig.effort=medium passes thinkingLevel when thinking absent', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
        nodeConfig: { effort: 'medium' },
      })
    );

    const [callArgs] = mockCreateAgentSession.mock.calls[0] as [Record<string, unknown>];
    expect(callArgs.thinkingLevel).toBe('medium');
  });

  test('nodeConfig.thinking=off omits thinkingLevel (Pi runs without explicit thinking)', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
        nodeConfig: { thinking: 'off' },
      })
    );

    const [callArgs] = mockCreateAgentSession.mock.calls[0] as [Record<string, unknown>];
    expect(callArgs.thinkingLevel).toBeUndefined();
  });

  test('Claude-shape object thinking yields system warning and is not applied', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    const { chunks } = await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
        nodeConfig: { thinking: { type: 'enabled', budget_tokens: 4000 } },
      })
    );

    const systemChunks = chunks.filter(
      (c): c is { type: 'system'; content: string } =>
        typeof c === 'object' && c !== null && (c as { type?: string }).type === 'system'
    );
    expect(systemChunks.some(c => c.content.includes('object form is Claude-specific'))).toBe(true);

    const [callArgs] = mockCreateAgentSession.mock.calls[0] as [Record<string, unknown>];
    expect(callArgs.thinkingLevel).toBeUndefined();
  });

  test('nodeConfig.allowed_tools filters Pi built-in tools', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
        nodeConfig: { allowed_tools: ['read', 'grep'] },
      })
    );

    const [callArgs] = mockCreateAgentSession.mock.calls[0] as [Record<string, unknown>];
    expect(Array.isArray(callArgs.tools)).toBe(true);
    const tools = callArgs.tools as Array<{ __piTool: string }>;
    expect(tools.map(t => t.__piTool).sort()).toEqual(['grep', 'read']);
  });

  test('nodeConfig.allowed_tools: [] disables all Pi tools (LLM-only)', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
        nodeConfig: { allowed_tools: [] },
      })
    );

    const [callArgs] = mockCreateAgentSession.mock.calls[0] as [Record<string, unknown>];
    expect(callArgs.tools).toEqual([]);
  });

  test('unknown tool names yield system warning', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    const { chunks } = await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
        nodeConfig: { allowed_tools: ['read', 'WebFetch'] },
      })
    );

    const systemChunks = chunks.filter(
      (c): c is { type: 'system'; content: string } =>
        typeof c === 'object' && c !== null && (c as { type?: string }).type === 'system'
    );
    expect(systemChunks.some(c => c.content.includes('WebFetch'))).toBe(true);
  });

  test('denied_tools alone starts from full built-in set', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
        nodeConfig: { denied_tools: ['bash', 'write'] },
      })
    );

    const [callArgs] = mockCreateAgentSession.mock.calls[0] as [Record<string, unknown>];
    const tools = callArgs.tools as Array<{ __piTool: string }>;
    // Pi has 7 built-ins, 2 denied → 5 remain
    expect(tools).toHaveLength(5);
    expect(tools.find(t => t.__piTool === 'bash')).toBeUndefined();
    expect(tools.find(t => t.__piTool === 'write')).toBeUndefined();
  });

  test('no allowed_tools / denied_tools leaves Pi default tools in place', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
      })
    );

    const [callArgs] = mockCreateAgentSession.mock.calls[0] as [Record<string, unknown>];
    // tools key should be absent — Pi uses its default codingTools
    expect('tools' in callArgs).toBe(false);
  });

  test('requestOptions.systemPrompt threads through to DefaultResourceLoader', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
        systemPrompt: 'You are a careful investigator.',
      })
    );

    // DefaultResourceLoader constructor received systemPrompt
    const loaderArgs = MockDefaultResourceLoader.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(loaderArgs?.systemPrompt).toBe('You are a careful investigator.');
    expect(loaderArgs?.noExtensions).toBe(true);
    expect(loaderArgs?.noContextFiles).toBe(true);
  });

  test('nodeConfig.systemPrompt used when requestOptions.systemPrompt absent', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
        nodeConfig: { systemPrompt: 'node-level prompt' },
      })
    );

    const loaderArgs = MockDefaultResourceLoader.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(loaderArgs?.systemPrompt).toBe('node-level prompt');
  });

  test('requestOptions.systemPrompt wins over nodeConfig.systemPrompt', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
        systemPrompt: 'request-level wins',
        nodeConfig: { systemPrompt: 'node-level' },
      })
    );

    const loaderArgs = MockDefaultResourceLoader.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(loaderArgs?.systemPrompt).toBe('request-level wins');
  });

  test('capabilities reflect v2 wiring', () => {
    const caps = new PiProvider().getCapabilities();
    expect(caps.thinkingControl).toBe(true);
    expect(caps.effortControl).toBe(true);
    expect(caps.toolRestrictions).toBe(true);
    // Still false:
    expect(caps.mcp).toBe(false);
    expect(caps.hooks).toBe(false);
    expect(caps.skills).toBe(false);
    expect(caps.structuredOutput).toBe(false);
    expect(caps.sessionResume).toBe(false);
  });
});
