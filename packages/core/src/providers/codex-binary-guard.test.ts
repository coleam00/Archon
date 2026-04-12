/**
 * Tests for Codex binary resolution in compiled binary mode.
 *
 * Separate file because mock.module('@archon/paths') with BUNDLED_IS_BINARY=true
 * conflicts with codex.test.ts which mocks it without BUNDLED_IS_BINARY.
 * Must run in its own bun test invocation (see package.json test script).
 */
import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { createMockLogger } from '../test/mocks/logger';

const mockLogger = createMockLogger();

// Mock @archon/paths with BUNDLED_IS_BINARY = true (simulates compiled binary)
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
  BUNDLED_IS_BINARY: true,
  getArchonHome: mock(() => '/tmp/test-archon'),
}));

// Track what path override is passed to the Codex constructor
let capturedOptions: { codexPathOverride?: string } | undefined;

const mockStartThread = mock(() => ({
  id: 'test-thread',
  runStreamed: mock(() =>
    Promise.resolve({
      events: (async function* () {
        yield {
          type: 'turn.completed',
          usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 },
        };
      })(),
    })
  ),
}));

const MockCodex = mock((opts?: { codexPathOverride?: string }) => {
  capturedOptions = opts;
  return {
    startThread: mockStartThread,
    resumeThread: mock(() => ({})),
  };
});
mock.module('@openai/codex-sdk', () => ({
  Codex: MockCodex,
}));

// Mock resolver — controls binary resolution behavior per test
const mockResolveCodexBinaryPath = mock(
  (_configPath?: string): Promise<string | undefined> =>
    Promise.resolve('/tmp/test-archon/vendor/codex/codex')
);
mock.module('../utils/codex-binary-resolver', () => ({
  resolveCodexBinaryPath: mockResolveCodexBinaryPath,
}));

// Config mock with configurable return value
const mockLoadConfig = mock(() =>
  Promise.resolve({
    allowTargetRepoKeys: false,
    assistants: { codex: {} },
  })
);

// Mock db and config dependencies to prevent real DB access
mock.module('../db/codebases', () => ({
  findCodebaseByDefaultCwd: mock(() => Promise.resolve(null)),
  findCodebaseByPathPrefix: mock(() => Promise.resolve(null)),
}));
mock.module('../config/config-loader', () => ({
  loadConfig: mockLoadConfig,
}));
mock.module('../utils/env-leak-scanner', () => ({
  scanPathForSensitiveKeys: mock(() => ({ findings: [] })),
  EnvLeakError: class extends Error {},
}));

import { CodexProvider, resetCodexSingleton } from './codex';

describe('CodexProvider binary mode resolution', () => {
  beforeEach(() => {
    resetCodexSingleton();
    MockCodex.mockClear();
    mockStartThread.mockClear();
    mockResolveCodexBinaryPath.mockClear();
    mockLoadConfig.mockClear();
    capturedOptions = undefined;

    // Restore default mock implementations
    mockResolveCodexBinaryPath.mockImplementation(() =>
      Promise.resolve('/tmp/test-archon/vendor/codex/codex')
    );
    mockLoadConfig.mockImplementation(() =>
      Promise.resolve({
        allowTargetRepoKeys: false,
        assistants: { codex: {} },
      })
    );
  });

  test('passes resolved binary path to Codex constructor via codexPathOverride', async () => {
    mockResolveCodexBinaryPath.mockResolvedValueOnce('/custom/path/to/codex');

    const client = new CodexProvider();
    const generator = client.sendQuery('test prompt', '/tmp/test');

    // Consume events to trigger initialization
    for await (const _chunk of generator) {
      // drain
    }

    expect(mockResolveCodexBinaryPath).toHaveBeenCalledTimes(1);
    expect(capturedOptions?.codexPathOverride).toBe('/custom/path/to/codex');
  });

  test('propagates resolver errors as clear failures', async () => {
    mockResolveCodexBinaryPath.mockRejectedValueOnce(
      new Error('Codex native binary not found at /tmp/test-archon/vendor/codex/codex')
    );

    const client = new CodexProvider();
    const generator = client.sendQuery('test prompt', '/tmp/test');

    await expect(generator.next()).rejects.toThrow('Codex native binary not found');
  });

  test('retries initialization after first failure (rejected promise not cached)', async () => {
    mockResolveCodexBinaryPath
      .mockRejectedValueOnce(new Error('Codex CLI binary not found'))
      .mockResolvedValueOnce('/tmp/test-archon/vendor/codex/codex');

    const client = new CodexProvider();

    // First call fails
    await expect(client.sendQuery('test prompt', '/tmp/test').next()).rejects.toThrow(
      'Codex CLI binary not found'
    );

    // Reset singleton so second call can retry
    resetCodexSingleton();

    // Second call succeeds (promise was cleared on failure)
    const generator = client.sendQuery('test prompt', '/tmp/test');
    for await (const _chunk of generator) {
      // drain
    }
    expect(mockResolveCodexBinaryPath).toHaveBeenCalledTimes(2);
  });

  test('does not pass codexPathOverride when resolver returns undefined', async () => {
    mockResolveCodexBinaryPath.mockResolvedValueOnce(undefined);

    const client = new CodexProvider();
    const generator = client.sendQuery('test prompt', '/tmp/test');

    for await (const _chunk of generator) {
      // drain
    }

    expect(capturedOptions).toBeDefined();
    expect(capturedOptions?.codexPathOverride).toBeUndefined();
  });

  test('passes config codexBinaryPath to resolver', async () => {
    mockLoadConfig.mockResolvedValueOnce({
      allowTargetRepoKeys: false,
      assistants: { codex: { codexBinaryPath: '/user/custom/codex' } },
    });

    const client = new CodexProvider();
    const generator = client.sendQuery('test prompt', '/tmp/test');

    for await (const _chunk of generator) {
      // drain
    }

    expect(mockResolveCodexBinaryPath).toHaveBeenCalledWith('/user/custom/codex');
  });
});
