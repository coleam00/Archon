import { beforeEach, describe, expect, mock, test } from 'bun:test';

import { createMockLogger } from '../../test/mocks/logger';

const mockLogger = createMockLogger();
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
}));

// ─── Fake OMP SDK ────────────────────────────────────────────────────────────

const mockSetRuntimeApiKey = mock(() => undefined);
const mockGetApiKey = mock(async (): Promise<string | undefined> => 'sk-test');
const mockDiscoverAuthStorage = mock(async () => ({
  setRuntimeApiKey: mockSetRuntimeApiKey,
  getApiKey: mockGetApiKey,
}));

const mockRefresh = mock(async () => undefined);
const mockRefreshProvider = mock(async () => undefined);
const mockFind = mock((): { provider: string; id: string } | undefined => ({
  provider: 'google',
  id: 'gemini-2.5-pro',
}));

class MockModelRegistry {
  constructor(_auth: unknown) {}
  refresh = mockRefresh;
  refreshProvider = mockRefreshProvider;
  find = mockFind;
  getError = mock(() => undefined);
}

mock.module('@oh-my-pi/pi-coding-agent', () => ({
  discoverAuthStorage: mockDiscoverAuthStorage,
  ModelRegistry: MockModelRegistry,
}));

// ─── Fake OmpProvider (live prompt probe path) ───────────────────────────────

/** Records every live sendQuery invocation; coordinates the concurrency test. */
const sendQueryCalls: string[] = [];
let sendQueryBarrier: (() => Promise<void>) | undefined;

class FakeOmpProvider {
  async *sendQuery(
    _prompt: string,
    _cwd: string,
    _resume?: string,
    options?: { model?: string }
  ): AsyncGenerator<{ type: string; content: string }> {
    sendQueryCalls.push(options?.model ?? '<none>');
    if (sendQueryBarrier) await sendQueryBarrier();
    yield { type: 'assistant', content: 'OK' };
  }
}

mock.module('./provider', () => ({
  OmpProvider: FakeOmpProvider,
  OMP_PROVIDER_ENV_VARS: {
    google: 'GEMINI_API_KEY',
    anthropic: 'ANTHROPIC_API_KEY',
  },
}));

import {
  checkModelRegistryResolution,
  checkModelResolution,
  checkModelResolutionAll,
} from './model-preflight';

beforeEach(() => {
  mockSetRuntimeApiKey.mockClear();
  mockGetApiKey.mockClear();
  mockGetApiKey.mockImplementation(async () => 'sk-test');
  mockDiscoverAuthStorage.mockClear();
  mockRefresh.mockClear();
  mockRefreshProvider.mockClear();
  mockFind.mockClear();
  mockFind.mockImplementation(() => ({ provider: 'google', id: 'gemini-2.5-pro' }));
  sendQueryCalls.length = 0;
  sendQueryBarrier = undefined;
  delete process.env.GEMINI_API_KEY;
});

// ─── checkModelRegistryResolution (cheap check) ──────────────────────────────

describe('checkModelRegistryResolution', () => {
  test('ok when model resolves and credentials exist — no prompt sent', async () => {
    const result = await checkModelRegistryResolution('google/gemini-2.5-pro');
    expect(result.ok).toBe(true);
    expect(result.modelPath).toBe('google/gemini-2.5-pro');
    expect(typeof result.latencyMs).toBe('number');
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    // The cheap check must never invoke the provider's sendQuery
    expect(sendQueryCalls).toEqual([]);
  });

  test('fails on invalid model path without touching the SDK', async () => {
    const result = await checkModelRegistryResolution('not-a-model-path');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Invalid model path');
    expect(mockDiscoverAuthStorage).not.toHaveBeenCalled();
  });

  test('fails when model not found in registry', async () => {
    mockFind.mockImplementation(() => undefined);
    const result = await checkModelRegistryResolution('google/unknown-model');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('not found in registry');
    // google is not a runtime-discovered provider — no online refresh
    expect(mockRefreshProvider).not.toHaveBeenCalled();
  });

  test('retries via runtime-discovery refresh for runtime-discovered providers', async () => {
    let calls = 0;
    mockFind.mockImplementation(() => {
      calls += 1;
      return calls > 1 ? { provider: 'ollama', id: 'llama3' } : undefined;
    });
    const result = await checkModelRegistryResolution('ollama/llama3');
    expect(result.ok).toBe(true);
    expect(mockRefreshProvider).toHaveBeenCalledTimes(1);
  });

  test('fails when no credentials are resolvable for the provider', async () => {
    mockGetApiKey.mockImplementation(async () => undefined);
    const result = await checkModelRegistryResolution('google/gemini-2.5-pro');
    expect(result.ok).toBe(false);
    expect(result.error).toContain("No credentials for provider 'google'");
    expect(result.error).toContain('GEMINI_API_KEY');
  });

  test('env override is applied as runtime API key (env wins)', async () => {
    await checkModelRegistryResolution('google/gemini-2.5-pro', {
      GEMINI_API_KEY: 'sk-from-env',
    });
    expect(mockSetRuntimeApiKey).toHaveBeenCalledWith('google', 'sk-from-env');
  });
});

// ─── checkModelResolutionAll (gating + concurrency) ──────────────────────────

describe('checkModelResolutionAll', () => {
  test('default (no live option) uses the cheap check — zero prompts sent', async () => {
    const results = await checkModelResolutionAll(
      ['google/gemini-2.5-pro', 'anthropic/claude-opus-4-5'],
      '/tmp'
    );
    expect(results).toHaveLength(2);
    expect(results.every(r => r.ok)).toBe(true);
    expect(sendQueryCalls).toEqual([]);
  });

  test('live: true runs the prompt probe per model', async () => {
    const results = await checkModelResolutionAll(['google/gemini-2.5-pro'], '/tmp', undefined, {
      live: true,
    });
    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(true);
    expect(sendQueryCalls).toEqual(['google/gemini-2.5-pro']);
  });

  test('deduplicates and drops blank model paths', async () => {
    const results = await checkModelResolutionAll(
      ['google/gemini-2.5-pro', 'google/gemini-2.5-pro', '  '],
      '/tmp'
    );
    expect(results).toHaveLength(1);
  });

  test('live probes run concurrently, not sequentially', async () => {
    // Barrier: each sendQuery blocks until BOTH probes have started.
    // If probes ran sequentially this would deadlock (caught by test timeout).
    let started = 0;
    let release: () => void = () => undefined;
    const allStarted = new Promise<void>(resolve => {
      release = resolve;
    });
    sendQueryBarrier = () => {
      started += 1;
      if (started >= 2) release();
      return allStarted;
    };

    const results = await checkModelResolutionAll(
      ['google/gemini-2.5-pro', 'anthropic/claude-opus-4-5'],
      '/tmp',
      undefined,
      { live: true }
    );
    expect(results).toHaveLength(2);
    expect(results.every(r => r.ok)).toBe(true);
    expect(sendQueryCalls).toHaveLength(2);
  });
});

// ─── checkModelResolution (live probe internals) ─────────────────────────────

describe('checkModelResolution', () => {
  test('passes env through to the provider and reports ok on assistant output', async () => {
    const result = await checkModelResolution('google/gemini-2.5-pro', '/tmp', {
      GEMINI_API_KEY: 'sk-env',
    });
    expect(result.ok).toBe(true);
    expect(sendQueryCalls).toEqual(['google/gemini-2.5-pro']);
  });
});
