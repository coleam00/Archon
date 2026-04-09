/**
 * Tests for the BUNDLED_IS_BINARY guard in CodexClient.
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
}));

// Mock Codex SDK so it doesn't try to resolve the native binary
const MockCodex = mock(() => ({
  startThread: mock(() => ({})),
  resumeThread: mock(() => ({})),
}));
mock.module('@openai/codex-sdk', () => ({
  Codex: MockCodex,
}));

// Mock db and config dependencies to prevent real DB access
mock.module('../db/codebases', () => ({
  findCodebaseByDefaultCwd: mock(() => Promise.resolve(null)),
  findCodebaseByPathPrefix: mock(() => Promise.resolve(null)),
}));
mock.module('../config/config-loader', () => ({
  loadConfig: mock(() => Promise.resolve({ allowTargetRepoKeys: false })),
}));
mock.module('../utils/env-leak-scanner', () => ({
  scanPathForSensitiveKeys: mock(() => ({ findings: [] })),
  EnvLeakError: class extends Error {},
}));

import { CodexClient } from './codex';

describe('CodexClient binary mode guard', () => {
  beforeEach(() => {
    MockCodex.mockClear();
  });

  test('throws a clear error when BUNDLED_IS_BINARY is true', async () => {
    const client = new CodexClient();
    const generator = client.sendQuery('test prompt', '/tmp/test');

    await expect(generator.next()).rejects.toThrow('not supported in the archon binary');
  });

  test('error message includes remediation steps', async () => {
    const client = new CodexClient();
    const generator = client.sendQuery('test prompt', '/tmp/test');

    try {
      await generator.next();
      expect.unreachable('should have thrown');
    } catch (error) {
      const msg = (error as Error).message;
      expect(msg).toContain('bun link');
      expect(msg).toContain('assistant: claude');
      expect(msg).toContain('provider: codex');
    }
  });

  test('Codex SDK constructor is never called', async () => {
    const client = new CodexClient();
    const generator = client.sendQuery('test prompt', '/tmp/test');

    try {
      await generator.next();
    } catch {
      // Expected
    }

    // The guard throws at the top of sendQuery, before getCodex() is reached
    expect(MockCodex).not.toHaveBeenCalled();
  });
});
