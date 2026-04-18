import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { AgentSessionEvent } from '@mariozechner/pi-coding-agent';

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

// Typed against Pi's actual event union so tests fail at compile time when
// Pi renames a field (e.g. `assistantMessageEvent` → `amEvent`) rather than
// silently passing while production drifts. Using `as AgentSessionEvent` at
// the call site covers the cases where we construct partial message objects.
type FakeEvent = AgentSessionEvent;
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

const mockBindExtensions = mock(async (_bindings: unknown) => undefined);
const mockSetFlagValue = mock((_name: string, _value: boolean | string) => undefined);
const mockExtensionRunner = {
  setFlagValue: mockSetFlagValue,
};
const mockSession = {
  subscribe: mockSubscribe,
  prompt: mockPrompt,
  abort: mockAbort,
  dispose: mockDispose,
  bindExtensions: mockBindExtensions,
  extensionRunner: mockExtensionRunner,
  isStreaming: false,
  sessionId: 'mock-session-uuid',
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

const mockModelRegistryFind = mock((provider: string, modelId: string) => {
  if (provider === 'nonexistent') return undefined;
  return { id: modelId, provider, name: `${provider}/${modelId}` };
});
const mockModelRegistryCreate = mock(() => ({
  find: mockModelRegistryFind,
}));

// SessionManager mocks. Each returns a tagged session-manager stub so tests
// can assert whether resume resolved to an existing session or fell through
// to a fresh one.
const mockSessionCreate = mock((_cwd: string) => ({ __smKind: 'created' }));
const mockSessionOpen = mock((_path: string) => ({ __smKind: 'opened' }));
const mockSessionList = mock(
  async (_cwd: string) => [] as { id: string; path: string; cwd: string }[]
);

const mockSettingsManagerInMemory = mock(() => ({}));
const mockResourceLoaderReload = mock(async () => undefined);
// Return-style constructor: bun's mock() wraps the function such that the
// `this`-binding doesn't reliably propagate to `new` call sites. Returning a
// plain object from the constructor sidesteps this — ES semantics use the
// returned object when a constructor explicitly returns one.
const MockDefaultResourceLoader = mock((_opts: unknown) => ({
  reload: mockResourceLoaderReload,
}));

// Tool factory mocks — each returns an opaque object tagged with the tool
// name so assertions can verify which tools the provider selected.
const mockCreateReadTool = mock((_cwd: string) => ({ __piTool: 'read' }));
const mockCreateBashTool = mock((_cwd: string, _options?: unknown) => ({ __piTool: 'bash' }));
const mockCreateEditTool = mock((_cwd: string) => ({ __piTool: 'edit' }));
const mockCreateWriteTool = mock((_cwd: string) => ({ __piTool: 'write' }));
const mockCreateGrepTool = mock((_cwd: string) => ({ __piTool: 'grep' }));
const mockCreateFindTool = mock((_cwd: string) => ({ __piTool: 'find' }));
const mockCreateLsTool = mock((_cwd: string) => ({ __piTool: 'ls' }));

mock.module('@mariozechner/pi-coding-agent', () => ({
  createAgentSession: mockCreateAgentSession,
  AuthStorage: { create: mockAuthCreate },
  ModelRegistry: { create: mockModelRegistryCreate },
  SessionManager: {
    create: mockSessionCreate,
    open: mockSessionOpen,
    list: mockSessionList,
  },
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
    mockLogger.fatal.mockClear();
    mockLogger.error.mockClear();
    mockLogger.warn.mockClear();
    mockLogger.info.mockClear();
    mockLogger.debug.mockClear();
    mockLogger.trace.mockClear();
    mockPrompt.mockClear();
    mockAbort.mockClear();
    mockDispose.mockClear();
    mockSubscribe.mockClear();
    mockBindExtensions.mockClear();
    mockSetFlagValue.mockClear();
    mockResourceLoaderReload.mockClear();
    mockCreateAgentSession.mockClear();
    mockAuthCreate.mockClear();
    mockModelRegistryCreate.mockClear();
    mockModelRegistryFind.mockClear();
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
    mockSessionCreate.mockClear();
    mockSessionOpen.mockClear();
    mockSessionList.mockClear();
    mockSessionList.mockImplementation(async () => []);
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

  test('sendQuery installs PI_PACKAGE_DIR shim before Pi SDK loads', async () => {
    // Runtime-safety regression: Pi's config.js reads `getPackageJsonPath()` at
    // its module init, which resolves to a non-existent path inside compiled
    // archon binaries. The shim writes a stub package.json to tmpdir and sets
    // PI_PACKAGE_DIR so Pi's short-circuit kicks in. Must run BEFORE the
    // dynamic imports in sendQuery — we verify by calling the fast-fail "no
    // model" path (which returns before any Pi SDK logic executes) and
    // asserting the env var was set regardless.
    delete process.env.PI_PACKAGE_DIR;
    expect(process.env.PI_PACKAGE_DIR).toBeUndefined();
    await consume(new PiProvider().sendQuery('hi', '/tmp'));
    expect(process.env.PI_PACKAGE_DIR).toBeDefined();
    expect(process.env.PI_PACKAGE_DIR).toContain('archon-pi-shim');
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

  test('logs credential hint when Pi provider id is unknown AND no creds available', async () => {
    // No env var, no auth.json entry → log hint, but continue, to support custom providers that don't use credentials or that use non-Pi means of providing credentials.
    resetScript(scriptedAgentEnd());
    const { error } = await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'unknownprovider/some-model',
      })
    );

    expect(error).toBeUndefined();
    expect(mockLogger.info).toHaveBeenCalledWith(
      { piProvider: 'unknownprovider' },
      expect.stringContaining("not in the Archon adapter's env-var table")
    );
    expect(mockCreateAgentSession).toHaveBeenCalledTimes(1);
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

  test('throws when ModelRegistry.find returns undefined', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    // 'nonexistent' is handled in mockModelRegistryFind to return undefined, but
    // the adapter rejects unknown providers. To exercise
    // the not-found branch, use a known provider but unknown modelId by
    // temporarily swapping mockModelRegistryFind to always return undefined.
    mockModelRegistryFind.mockImplementationOnce(() => undefined);
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

  test('resumeSessionId not found → fresh session + system warning', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    mockSessionList.mockImplementationOnce(async () => []);
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

    const { chunks, error } = await consume(
      new PiProvider().sendQuery('hi', '/tmp', 'nonexistent-id', {
        model: 'google/gemini-2.5-pro',
      })
    );
    expect(error).toBeUndefined();
    // Resume attempted: list() called; no match → create() called (fresh session)
    expect(mockSessionList).toHaveBeenCalled();
    expect(mockSessionCreate).toHaveBeenCalledWith('/tmp');
    expect(mockSessionOpen).not.toHaveBeenCalled();
    // Resume failure surfaces as a system warning
    const systemChunks = chunks.filter(
      (c): c is { type: 'system'; content: string } =>
        typeof c === 'object' && c !== null && (c as { type?: string }).type === 'system'
    );
    expect(systemChunks.some(c => c.content.includes('Could not resume'))).toBe(true);
  });

  test('resumeSessionId matches existing session → open by path, no warning', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    mockSessionList.mockImplementationOnce(async () => [
      { id: 'existing-id', path: '/sessions/existing-id.jsonl', cwd: '/tmp' },
    ]);
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

    const { chunks, error } = await consume(
      new PiProvider().sendQuery('hi', '/tmp', 'existing-id', {
        model: 'google/gemini-2.5-pro',
      })
    );
    expect(error).toBeUndefined();
    expect(mockSessionOpen).toHaveBeenCalledWith('/sessions/existing-id.jsonl');
    expect(mockSessionCreate).not.toHaveBeenCalled();
    // No resume_failed warning
    const systemChunks = chunks.filter(
      (c): c is { type: 'system'; content: string } =>
        typeof c === 'object' && c !== null && (c as { type?: string }).type === 'system'
    );
    expect(systemChunks.some(c => c.content.includes('Could not resume'))).toBe(false);
  });

  test('result chunk carries Pi sessionId (for Archon to store and reuse)', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    const { chunks } = await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
      })
    );

    const resultChunk = chunks.find(
      (c): c is { type: 'result'; sessionId?: string } =>
        typeof c === 'object' && c !== null && (c as { type?: string }).type === 'result'
    );
    expect(resultChunk).toBeDefined();
    expect(resultChunk?.sessionId).toBe('mock-session-uuid');
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

  test('requestOptions.env with no tool restrictions overrides Pi defaults with env-aware bash', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
        env: { DATABASE_URL: 'postgres://managed' },
      })
    );

    const [callArgs] = mockCreateAgentSession.mock.calls[0] as [Record<string, unknown>];
    // Env present → we override Pi's built-in codingTools so bash sees the env.
    const tools = callArgs.tools as Array<{ __piTool: string }>;
    expect(Array.isArray(tools)).toBe(true);
    expect(tools.map(t => t.__piTool).sort()).toEqual(['bash', 'edit', 'read', 'write']);

    const bashCall = mockCreateBashTool.mock.calls.find(call => call[1] !== undefined);
    expect(bashCall).toBeDefined();
    const bashOptions = bashCall![1] as { spawnHook: (c: unknown) => unknown };
    expect(typeof bashOptions.spawnHook).toBe('function');

    // The spawnHook must merge caller env OVER Pi's inherited baseline, matching
    // Claude's { ...subprocessEnv, ...requestOptions.env } and Codex's buildCodexEnv.
    const merged = bashOptions.spawnHook({
      command: 'echo',
      cwd: '/tmp',
      env: { PATH: '/usr/bin', DATABASE_URL: 'postgres://stale' },
    }) as { env: Record<string, string> };
    expect(merged.env.PATH).toBe('/usr/bin');
    expect(merged.env.DATABASE_URL).toBe('postgres://managed');
  });

  test('requestOptions.env threads through to bash tool when allowed_tools includes bash', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
        nodeConfig: { allowed_tools: ['read', 'bash'] },
        env: { STRIPE_KEY: 'sk_test_abc' },
      })
    );

    const bashCall = mockCreateBashTool.mock.calls.find(call => call[1] !== undefined);
    expect(bashCall).toBeDefined();
    const bashOptions = bashCall![1] as { spawnHook: (c: unknown) => unknown };
    const merged = bashOptions.spawnHook({
      command: 'echo',
      cwd: '/tmp',
      env: { PATH: '/usr/bin' },
    }) as { env: Record<string, string> };
    expect(merged.env.STRIPE_KEY).toBe('sk_test_abc');
    expect(merged.env.PATH).toBe('/usr/bin');
  });

  test('empty requestOptions.env does NOT construct a spawnHook', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
        env: {},
      })
    );

    // Every createBashTool call in this test path is either (cwd) or (cwd, undefined).
    for (const call of mockCreateBashTool.mock.calls) {
      expect(call[1]).toBeUndefined();
    }
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
    expect(loaderArgs?.noExtensions).toBe(false);
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
    expect(caps.skills).toBe(true);
    expect(caps.sessionResume).toBe(true);
    expect(caps.envInjection).toBe(true);
    // Best-effort structured output via prompt engineering (not SDK-enforced).
    expect(caps.structuredOutput).toBe(true);
    // Still false:
    expect(caps.mcp).toBe(false);
    expect(caps.hooks).toBe(false);
  });

  test('extensions are enabled by default (noExtensions: false)', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
      })
    );

    const loaderArgs = MockDefaultResourceLoader.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    // Extensions (community packages and user-authored) are a core reason
    // users run Pi; off-by-default silently broke users who installed or
    // authored one and expected it to fire.
    expect(loaderArgs?.noExtensions).toBe(false);
    // Skills/prompts/themes/context stay suppressed — only extensions flip on.
    expect(loaderArgs?.noSkills).toBe(true);
    expect(loaderArgs?.noPromptTemplates).toBe(true);
    expect(loaderArgs?.noThemes).toBe(true);
    expect(loaderArgs?.noContextFiles).toBe(true);
  });

  test('assistantConfig.enableExtensions: true flips noExtensions to false', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
        assistantConfig: { enableExtensions: true },
      })
    );

    const loaderArgs = MockDefaultResourceLoader.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(loaderArgs?.noExtensions).toBe(false);
    // Skills/prompts/themes/context still suppressed — only extensions opt-in.
    expect(loaderArgs?.noSkills).toBe(true);
    expect(loaderArgs?.noPromptTemplates).toBe(true);
    expect(loaderArgs?.noThemes).toBe(true);
    expect(loaderArgs?.noContextFiles).toBe(true);
  });

  test('assistantConfig.enableExtensions: false keeps noExtensions: true', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
        assistantConfig: { enableExtensions: false },
      })
    );

    const loaderArgs = MockDefaultResourceLoader.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(loaderArgs?.noExtensions).toBe(true);
  });

  test('nodeConfig.skills with unknown name yields system warning, does not abort', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    const { chunks, error } = await consume(
      new PiProvider().sendQuery('hi', '/tmp/nonexistent-cwd', undefined, {
        model: 'google/gemini-2.5-pro',
        nodeConfig: { skills: ['definitely-does-not-exist'] },
      })
    );
    expect(error).toBeUndefined();
    const systemChunks = chunks.filter(
      (c): c is { type: 'system'; content: string } =>
        typeof c === 'object' && c !== null && (c as { type?: string }).type === 'system'
    );
    expect(systemChunks.some(c => c.content.includes('definitely-does-not-exist'))).toBe(true);

    // DefaultResourceLoader instantiated without additionalSkillPaths (all missing)
    const loaderArgs = MockDefaultResourceLoader.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(loaderArgs?.additionalSkillPaths).toBeUndefined();
  });

  test('nodeConfig.skills absent → no additionalSkillPaths option passed', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
      })
    );

    const loaderArgs = MockDefaultResourceLoader.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect('additionalSkillPaths' in (loaderArgs ?? {})).toBe(false);
  });

  // ─── Error + lifecycle paths (review: "zero test coverage") ─────────

  test('session.prompt rejection surfaces as thrown error to consumer', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    const promptError = new Error('pi backend exploded');
    mockPrompt.mockImplementationOnce(async () => {
      throw promptError;
    });

    const { error } = await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
      })
    );
    expect(error?.message).toBe('pi backend exploded');
    // dispose still happens on error path
    expect(mockDispose).toHaveBeenCalledTimes(1);
  });

  test('pre-aborted signal triggers session.abort before any yielding', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());
    const controller = new AbortController();
    controller.abort();

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
        abortSignal: controller.signal,
      })
    );
    expect(mockAbort).toHaveBeenCalled();
  });

  test('abort signal mid-stream calls session.abort', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    const controller = new AbortController();
    // Drive the listener with one chunk, then abort, then agent_end.
    mockPrompt.mockImplementationOnce(async () => {
      capturedListener?.({
        type: 'message_update',
        message: { role: 'assistant' } as never,
        assistantMessageEvent: {
          type: 'text_delta',
          contentIndex: 0,
          delta: 'partial',
          partial: { role: 'assistant' } as never,
        },
      });
      controller.abort();
      capturedListener?.({
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
          } as never,
        ],
      });
    });

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
        abortSignal: controller.signal,
      })
    );
    expect(mockAbort).toHaveBeenCalled();
  });

  test('modelFallbackMessage yields a system chunk before the agent runs', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    mockCreateAgentSession.mockImplementationOnce(async () => ({
      session: mockSession,
      extensionsResult: { extensions: [], errors: [], runtime: {} },
      modelFallbackMessage: 'Requested sonnet-5 not available, using haiku.',
    }));
    resetScript(scriptedAgentEnd());

    const { chunks } = await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
      })
    );
    const systemChunks = chunks.filter(
      (c): c is { type: 'system'; content: string } =>
        typeof c === 'object' && c !== null && (c as { type?: string }).type === 'system'
    );
    expect(systemChunks.some(c => c.content.includes('sonnet-5 not available'))).toBe(true);
  });

  // ─── structured output (best-effort JSON via prompt engineering) ──────

  // Script an assistant text_delta followed by agent_end so the bridge has
  // buffered content to parse when outputFormat is set.
  function scriptedAssistantThenEnd(text: string): FakeEvent[] {
    return [
      {
        type: 'message_update',
        message: { role: 'assistant' } as never,
        assistantMessageEvent: {
          type: 'text_delta',
          contentIndex: 0,
          delta: text,
          partial: { role: 'assistant' } as never,
        },
      },
      ...scriptedAgentEnd(),
    ];
  }

  test('outputFormat: schema is appended to prompt as JSON instruction', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    await consume(
      new PiProvider().sendQuery('Summarize this bug.', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
        outputFormat: {
          type: 'json_schema',
          schema: { type: 'object', properties: { area: { type: 'string' } } },
        },
      })
    );

    // Prompt should now contain the original instruction + the schema hint.
    expect(mockPrompt).toHaveBeenCalled();
    const [sentPrompt] = mockPrompt.mock.calls[0] as [string];
    expect(sentPrompt).toContain('Summarize this bug.');
    expect(sentPrompt).toContain('Respond with ONLY a JSON object');
    expect(sentPrompt).toContain('"area"');
  });

  test('outputFormat: absent → prompt passed through unchanged', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    await consume(
      new PiProvider().sendQuery('do a thing', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
      })
    );

    const [sentPrompt] = mockPrompt.mock.calls[0] as [string];
    expect(sentPrompt).toBe('do a thing');
    expect(sentPrompt).not.toContain('JSON');
  });

  test('outputFormat: result chunk carries parsed structuredOutput on clean JSON', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAssistantThenEnd('{"area":"web","confidence":0.9}'));

    const { chunks } = await consume(
      new PiProvider().sendQuery('classify', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
        outputFormat: {
          type: 'json_schema',
          schema: { type: 'object' },
        },
      })
    );

    const result = chunks.find(
      (c): c is { type: 'result'; structuredOutput?: unknown } =>
        typeof c === 'object' && c !== null && (c as { type?: string }).type === 'result'
    );
    expect(result).toBeDefined();
    expect(result?.structuredOutput).toEqual({ area: 'web', confidence: 0.9 });
  });

  test('outputFormat: fenced JSON (```json ... ```) still parses', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAssistantThenEnd('```json\n{"ok":true}\n```'));

    const { chunks } = await consume(
      new PiProvider().sendQuery('x', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
        outputFormat: { type: 'json_schema', schema: {} },
      })
    );

    const result = chunks.find(
      (c): c is { type: 'result'; structuredOutput?: unknown } =>
        typeof c === 'object' && c !== null && (c as { type?: string }).type === 'result'
    );
    expect(result?.structuredOutput).toEqual({ ok: true });
  });

  test('outputFormat: prose-wrapped JSON → no structuredOutput, degrades cleanly', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAssistantThenEnd('Here is the JSON:\n{"ok":true}\nHope this helps!'));

    const { chunks, error } = await consume(
      new PiProvider().sendQuery('x', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
        outputFormat: { type: 'json_schema', schema: {} },
      })
    );

    // No crash — downstream degradation is the executor's job via its
    // existing dag.structured_output_missing warning path.
    expect(error).toBeUndefined();
    const result = chunks.find(
      (c): c is { type: 'result'; structuredOutput?: unknown } =>
        typeof c === 'object' && c !== null && (c as { type?: string }).type === 'result'
    );
    expect(result).toBeDefined();
    expect(result?.structuredOutput).toBeUndefined();
  });

  test('no outputFormat → structuredOutput never set even if assistant emits JSON', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAssistantThenEnd('{"accidental":"json"}'));

    const { chunks } = await consume(
      new PiProvider().sendQuery('x', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
      })
    );

    const result = chunks.find(
      (c): c is { type: 'result'; structuredOutput?: unknown } =>
        typeof c === 'object' && c !== null && (c as { type?: string }).type === 'result'
    );
    expect(result?.structuredOutput).toBeUndefined();
  });

  // ─── Interactive ExtensionUIContext binding ───────────────────────────

  test('interactive: true with enableExtensions binds a UIContext to the session', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
        assistantConfig: { enableExtensions: true, interactive: true },
      })
    );

    expect(mockBindExtensions).toHaveBeenCalledTimes(1);
    const [bindings] = mockBindExtensions.mock.calls[0] as [{ uiContext?: unknown }];
    expect(bindings.uiContext).toBeDefined();
  });

  test('enableExtensions: false disables binding even if interactive: true is set', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
        assistantConfig: { enableExtensions: false, interactive: true },
      })
    );

    expect(mockBindExtensions).not.toHaveBeenCalled();
  });

  test('interactive: false with extensions on binds empty (session_start fires, no UIContext)', async () => {
    // When extensions are loaded, session_start MUST fire so each extension's
    // startup handler runs (reads flags, registers tools, etc.). Binding with
    // no uiContext keeps Pi's internal noOpUIContext active so hasUI stays
    // false — extensions that gate UI flows (like plannotator) will auto-approve
    // in this mode.
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
        assistantConfig: { interactive: false },
      })
    );

    expect(mockBindExtensions).toHaveBeenCalledTimes(1);
    const [bindings] = mockBindExtensions.mock.calls[0] as [{ uiContext?: unknown }];
    expect(bindings.uiContext).toBeUndefined();
  });

  test('default (nothing set) binds with UIContext — extensions + interactive both on', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
      })
    );

    expect(mockBindExtensions).toHaveBeenCalledTimes(1);
    const [bindings] = mockBindExtensions.mock.calls[0] as [{ uiContext?: unknown }];
    expect(bindings.uiContext).toBeDefined();
  });

  // ─── extensionFlags pass-through ──────────────────────────────────────

  test('extensionFlags sets flag values before bindExtensions fires session_start', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    // Track call order: setFlagValue must run BEFORE bindExtensions, else
    // extensions reading flags in their session_start handler miss them.
    const callOrder: string[] = [];
    mockSetFlagValue.mockImplementationOnce(() => {
      callOrder.push('setFlagValue');
      return undefined;
    });
    mockSetFlagValue.mockImplementationOnce(() => {
      callOrder.push('setFlagValue');
      return undefined;
    });
    mockBindExtensions.mockImplementationOnce(async () => {
      callOrder.push('bindExtensions');
    });

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
        assistantConfig: {
          enableExtensions: true,
          interactive: true,
          extensionFlags: { plan: true, 'plan-file': 'PLAN.md' },
        },
      })
    );

    expect(mockSetFlagValue).toHaveBeenCalledTimes(2);
    expect(mockSetFlagValue).toHaveBeenCalledWith('plan', true);
    expect(mockSetFlagValue).toHaveBeenCalledWith('plan-file', 'PLAN.md');
    expect(callOrder).toEqual(['setFlagValue', 'setFlagValue', 'bindExtensions']);
  });

  test('extensionFlags is a no-op when enableExtensions is explicitly false', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
        assistantConfig: { enableExtensions: false, extensionFlags: { plan: true } },
      })
    );

    expect(mockSetFlagValue).not.toHaveBeenCalled();
    expect(mockBindExtensions).not.toHaveBeenCalled();
  });

  test('assistantConfig.env applies to process.env when not already set', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    delete process.env.PI_TEST_ONE;
    delete process.env.PI_TEST_TWO;
    resetScript(scriptedAgentEnd());

    try {
      await consume(
        new PiProvider().sendQuery('hi', '/tmp', undefined, {
          model: 'google/gemini-2.5-pro',
          assistantConfig: { env: { PI_TEST_ONE: 'one', PI_TEST_TWO: 'two' } },
        })
      );

      expect(process.env.PI_TEST_ONE).toBe('one');
      expect(process.env.PI_TEST_TWO).toBe('two');
    } finally {
      delete process.env.PI_TEST_ONE;
      delete process.env.PI_TEST_TWO;
    }
  });

  test('shell env wins over assistantConfig.env (no override)', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    process.env.PI_TEST_SHELL_WINS = 'shell-value';
    resetScript(scriptedAgentEnd());

    try {
      await consume(
        new PiProvider().sendQuery('hi', '/tmp', undefined, {
          model: 'google/gemini-2.5-pro',
          assistantConfig: { env: { PI_TEST_SHELL_WINS: 'config-value' } },
        })
      );

      expect(process.env.PI_TEST_SHELL_WINS).toBe('shell-value');
    } finally {
      delete process.env.PI_TEST_SHELL_WINS;
    }
  });
});
