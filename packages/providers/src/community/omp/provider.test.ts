import { beforeEach, describe, expect, mock, test } from 'bun:test';

import { createMockLogger } from '../../test/mocks/logger';

const mockLogger = createMockLogger();
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
}));

type FakeEvent = {
  type: string;
  messages?: unknown[];
  assistantMessageEvent?: { type: string; delta: string };
};

let capturedListener: ((event: FakeEvent) => void) | undefined;
const scriptedEvents: FakeEvent[] = [];

const mockPrompt = mock(async () => {
  for (const ev of scriptedEvents) capturedListener?.(ev);
});
const mockDispose = mock(async () => undefined);
const mockSubscribe = mock((listener: (event: FakeEvent) => void) => {
  capturedListener = listener;
  return () => {
    capturedListener = undefined;
  };
});

const mockSession = {
  subscribe: mockSubscribe,
  prompt: mockPrompt,
  abort: mock(async () => undefined),
  dispose: mockDispose,
  extensionRunner: undefined as { setFlagValue: ReturnType<typeof mock> } | undefined,
};

const mockCreateAgentSession = mock(async () => ({
  session: mockSession,
  modelFallbackMessage: undefined as string | undefined,
}));

const mockDiscoverAuthStorage = mock(async () => ({
  setRuntimeApiKey: mock(() => undefined),
  getApiKey: mock(async () => 'sk-test'),
}));

const mockRefresh = mock(async () => undefined);
const mockRefreshProvider = mock(async () => undefined);
const mockFind = mock(() => ({
  provider: 'google',
  id: 'gemini-2.5-pro',
  api: 'google',
}));
const mockGetError = mock(() => undefined);

class MockModelRegistry {
  constructor(_auth: unknown) {}
  refresh = mockRefresh;
  refreshProvider = mockRefreshProvider;
  find = mockFind;
  getError = mockGetError;
}

const mockSessionCreate = mock(async () => ({ __smKind: 'created' }));
const mockSessionOpen = mock(async () => ({ __smKind: 'opened' }));
const mockSessionList = mock(async () => [] as { id: string; path: string; cwd: string }[]);

const mockReadOmpAgentDefaultModel = mock(async () => undefined as string | undefined);
mock.module('./omp-agent-config', () => ({
  readOmpAgentDefaultModel: mockReadOmpAgentDefaultModel,
}));

mock.module('@oh-my-pi/pi-coding-agent', () => ({
  discoverAuthStorage: mockDiscoverAuthStorage,
  ModelRegistry: MockModelRegistry,
  createAgentSession: mockCreateAgentSession,
  discoverSkills: mock(async () => ({ skills: [] })),
  SessionManager: {
    create: mockSessionCreate,
    open: mockSessionOpen,
    list: mockSessionList,
  },
}));

import { OmpProvider } from './provider';
import { OMP_CAPABILITIES } from './capabilities';

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

function agentEnd(text = 'hello'): FakeEvent {
  return {
    type: 'agent_end',
    messages: [
      {
        role: 'assistant',
        stopReason: 'stop',
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        content: [{ type: 'text', text }],
      },
    ],
  };
}

describe('OmpProvider metadata', () => {
  test('getType and capabilities', () => {
    const p = new OmpProvider();
    expect(p.getType()).toBe('omp');
    expect(p.getCapabilities()).toEqual(OMP_CAPABILITIES);
  });
});

describe('OmpProvider.sendQuery', () => {
  beforeEach(() => {
    mockLogger.warn.mockClear();
    mockLogger.error.mockClear();
    mockPrompt.mockClear();
    mockRefresh.mockClear();
    mockRefreshProvider.mockClear();
    mockFind.mockClear();
    mockDiscoverAuthStorage.mockClear();
    mockDiscoverAuthStorage.mockImplementation(async () => ({
      setRuntimeApiKey: mock(() => undefined),
      getApiKey: mock(async () => 'sk-test'),
    }));
    mockCreateAgentSession.mockClear();
    scriptedEvents.length = 0;
    scriptedEvents.push(agentEnd());
    mockFind.mockImplementation(() => ({
      provider: 'google',
      id: 'gemini-2.5-pro',
      api: 'google',
    }));
    mockGetError.mockImplementation(() => undefined);
    delete process.env.GEMINI_API_KEY;
  });

  test('requires model when unset', async () => {
    mockReadOmpAgentDefaultModel.mockResolvedValueOnce(undefined);
    const { error } = await consume(new OmpProvider().sendQuery('hi', '/tmp'));
    expect(error?.message).toContain('OMP provider requires a model');
    expect(error?.message).toContain('assistants.omp.model');
    expect(mockDiscoverAuthStorage).not.toHaveBeenCalled();
  });

  test('rejects invalid model ref', async () => {
    const { error } = await consume(
      new OmpProvider().sendQuery('hi', '/tmp', undefined, { model: 'minimax_m3/foo' })
    );
    expect(error?.message).toContain('Invalid OMP model ref');
    expect(error?.message).toContain('hyphens');
  });

  test('uses discoverAuthStorage and ModelRegistry.refresh', async () => {
    const { error, chunks } = await consume(
      new OmpProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
      })
    );
    expect(error).toBeUndefined();
    expect(mockDiscoverAuthStorage).toHaveBeenCalledTimes(1);
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    expect(
      chunks.some(
        c =>
          typeof c === 'object' &&
          c !== null &&
          'type' in c &&
          (c as { type: string }).type === 'result'
      )
    ).toBe(true);
  });

  test('model not found mentions models.yml and models.db not models.json', async () => {
    mockFind.mockImplementation(() => undefined);
    const { error } = await consume(
      new OmpProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/unknown-model',
      })
    );
    expect(error?.message).toContain('OMP model not found');
    expect(error?.message).toContain('models.yml');
    expect(error?.message).toContain('models.db');
    expect(error?.message).toContain('models.json is legacy');
  });

  test('model not found with config load error references models.yml', async () => {
    mockFind.mockImplementation(() => undefined);
    mockGetError.mockImplementation(
      () => 'Provider lm-studio: "baseUrl" is required when defining custom models.'
    );
    const { error } = await consume(
      new OmpProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'lm-studio/some-model',
      })
    );
    expect(error?.message).toContain('models.yml failed to load');
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ ompProvider: 'lm-studio' }),
      'omp.model_registry_load_error'
    );
  });

  test('refreshProvider called for cursor when find misses first', async () => {
    mockFind
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => ({
        provider: 'cursor',
        id: 'composer-2.5',
        api: 'cursor-agent',
      }));
    const { error } = await consume(
      new OmpProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'cursor/composer-2.5',
      })
    );
    expect(error).toBeUndefined();
    expect(mockRefreshProvider).toHaveBeenCalledWith('cursor', 'online');
    expect(mockFind).toHaveBeenCalledTimes(2);
  });

  test('auth init failure references agent.db', async () => {
    mockDiscoverAuthStorage.mockImplementationOnce(async () => {
      throw new Error('database disk image is malformed');
    });
    const { error } = await consume(
      new OmpProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
      })
    );
    expect(error?.message).toContain('OMP auth storage init failed');
    expect(error?.message).toContain('agent.db');
    expect(error?.message).not.toContain('auth.json');
  });

  test('throws when env var missing for mapped provider', async () => {
    mockDiscoverAuthStorage.mockImplementation(async () => ({
      setRuntimeApiKey: mock(() => undefined),
      getApiKey: mock(async () => undefined),
    }));
    const { error } = await consume(
      new OmpProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
      })
    );
    expect(error?.message).toContain('no credentials');
    expect(error?.message).toContain('GEMINI_API_KEY');
  });

  test('env-var hint names MINIMAX_TOKEN_PLAN_API_KEY for minimax-token-plan provider (F6)', async () => {
    mockDiscoverAuthStorage.mockImplementation(async () => ({
      setRuntimeApiKey: mock(() => undefined),
      getApiKey: mock(async () => undefined),
    }));
    // Override the model-resolution mock for this provider only.
    mockFind.mockImplementationOnce(() => ({
      provider: 'minimax-token-plan',
      id: 'MiniMax-M3',
      api: 'openai-completions',
    }));
    const { error } = await consume(
      new OmpProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'minimax-token-plan/MiniMax-M3',
      })
    );
    expect(error?.message).toContain('no credentials');
    expect(error?.message).toContain('MINIMAX_TOKEN_PLAN_API_KEY');
  });

  test('env-var hint names ALIBABA_CODING_PLAN_API_KEY for alibaba-coding-plan provider (F6)', async () => {
    mockDiscoverAuthStorage.mockImplementation(async () => ({
      setRuntimeApiKey: mock(() => undefined),
      getApiKey: mock(async () => undefined),
    }));
    mockFind.mockImplementationOnce(() => ({
      provider: 'alibaba-coding-plan',
      id: 'qwen3.7-plus',
      api: 'openai-completions',
    }));
    const { error } = await consume(
      new OmpProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'alibaba-coding-plan/qwen3.7-plus',
      })
    );
    expect(error?.message).toContain('no credentials');
    expect(error?.message).toContain('ALIBABA_CODING_PLAN_API_KEY');
  });

  test('prompt failure throws enriched error with recovery note, diagnostics, and cause', async () => {
    mockPrompt.mockImplementationOnce(async () => {
      throw new Error('boom failure'); // UNKNOWN classification → no retry
    });

    const { error } = await consume(
      new OmpProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
      })
    );

    expect(error).toBeDefined();
    expect(error?.message).toContain('OMP prompt failed (google/gemini-2.5-pro)');
    expect(error?.message).toContain('boom failure');
    expect(error?.message).toContain('Recovery:');
    expect(error?.message).toContain('/workflow resume');
    expect(error?.message).toContain('[omp diagnostics:');
    expect(error?.cause).toBeDefined();
    // original error preserved through the enrichment chain
    let root: unknown = error?.cause;
    while (root instanceof Error && root.cause !== undefined) root = root.cause;
    expect(root).toBeInstanceOf(Error);
    expect((root as Error).message).toBe('boom failure');
  });

  test('omp.prompt_failed log includes provider, modelId, cwd, and bounded ledger summary', async () => {
    mockPrompt.mockImplementationOnce(async () => {
      throw new Error('boom failure');
    });

    await consume(
      new OmpProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
      })
    );

    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        ompProvider: 'google',
        modelId: 'gemini-2.5-pro',
        cwd: '/tmp',
        toolAttempts: expect.any(Array),
        toolAttemptCount: 0,
      }),
      'omp.prompt_failed'
    );
  });

  test('transient pre-stream failure recreates the session via the factory (fresh session per attempt)', async () => {
    mockPrompt.mockImplementationOnce(async () => {
      throw new Error('socket hang up'); // TRANSIENT, zero chunks yielded
    });

    const { chunks, error } = await consume(
      new OmpProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
      })
    );

    expect(error).toBeUndefined();
    expect(mockCreateAgentSession).toHaveBeenCalledTimes(2);
    expect(
      chunks.some(
        c =>
          typeof c === 'object' &&
          c !== null &&
          (c as { type: string }).type === 'system' &&
          (c as { content: string }).content.includes('OMP transient error')
      )
    ).toBe(true);
    expect(
      chunks.some(
        c => typeof c === 'object' && c !== null && (c as { type: string }).type === 'result'
      )
    ).toBe(true);
  }, 15_000);

  test('model fallback warning is yielded only once even when retry recreates the session', async () => {
    mockCreateAgentSession
      .mockImplementationOnce(async () => ({
        session: mockSession,
        modelFallbackMessage: 'model fell back to gemini-2.5-flash' as string | undefined,
      }))
      .mockImplementationOnce(async () => ({
        session: mockSession,
        modelFallbackMessage: 'model fell back to gemini-2.5-flash' as string | undefined,
      }));
    mockPrompt.mockImplementationOnce(async () => {
      throw new Error('socket hang up'); // force one retry → second creation
    });

    const { chunks, error } = await consume(
      new OmpProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
      })
    );

    expect(error).toBeUndefined();
    expect(mockCreateAgentSession).toHaveBeenCalledTimes(2);
    const fallbackWarnings = chunks.filter(
      c =>
        typeof c === 'object' &&
        c !== null &&
        (c as { type: string }).type === 'system' &&
        (c as { content: string }).content.includes('fell back to gemini-2.5-flash')
    );
    expect(fallbackWarnings).toHaveLength(1);
  }, 15_000);
});

describe('OmpProvider assistants.omp.env application', () => {
  beforeEach(() => {
    mockLogger.debug.mockClear();
    scriptedEvents.length = 0;
    scriptedEvents.push(agentEnd());
    mockFind.mockImplementation(() => ({
      provider: 'google',
      id: 'gemini-2.5-pro',
      api: 'google',
    }));
    mockDiscoverAuthStorage.mockImplementation(async () => ({
      setRuntimeApiKey: mock(() => undefined),
      getApiKey: mock(async () => 'sk-test'),
    }));
    delete process.env.OMP_ENV_TEST_UNSET;
    delete process.env.OMP_ENV_TEST_SHELL;
    delete process.env.GEMINI_API_KEY;
  });

  test('applies config env for keys not present in the shell env', async () => {
    const { error } = await consume(
      new OmpProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
        assistantConfig: { env: { OMP_ENV_TEST_UNSET: 'from-config' } },
      })
    );
    expect(error).toBeUndefined();
    expect(process.env.OMP_ENV_TEST_UNSET).toBe('from-config');
    delete process.env.OMP_ENV_TEST_UNSET;
  });

  test('shell env wins — existing keys are never overwritten', async () => {
    process.env.OMP_ENV_TEST_SHELL = 'from-shell';
    const { error } = await consume(
      new OmpProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
        assistantConfig: { env: { OMP_ENV_TEST_SHELL: 'from-config' } },
      })
    );
    expect(error).toBeUndefined();
    expect(process.env.OMP_ENV_TEST_SHELL).toBe('from-shell');
    delete process.env.OMP_ENV_TEST_SHELL;
  });

  test('logs applied key NAMES only — never values', async () => {
    await consume(
      new OmpProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
        assistantConfig: { env: { OMP_ENV_TEST_UNSET: 'secret-value-xyz' } },
      })
    );
    const envLogCalls = mockLogger.debug.mock.calls.filter(
      call => call[1] === 'omp.config_env_applied'
    );
    expect(envLogCalls).toHaveLength(1);
    expect(envLogCalls[0][0]).toEqual({ keys: ['OMP_ENV_TEST_UNSET'] });
    const serialized = JSON.stringify(mockLogger.debug.mock.calls);
    expect(serialized).not.toContain('secret-value-xyz');
    delete process.env.OMP_ENV_TEST_UNSET;
  });
});
