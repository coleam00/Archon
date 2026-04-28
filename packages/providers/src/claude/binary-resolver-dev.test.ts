/**
 * Regression tests for the Claude binary resolver in dev mode (BUNDLED_IS_BINARY=false).
 *
 * Before SDK 0.2.121 this resolver short-circuited in dev mode and returned
 * undefined so the SDK auto-resolved its own bundled cli.js. The SDK then
 * dropped cli.js for a native binary, and the dev short-circuit caused
 * `shouldPassNoEnvFile` to misclassify the spawned binary and forward
 * `--no-env-file` to a native binary that rejects it.
 *
 * The fix is for dev mode to follow the exact same env → config → autodetect
 * chain as binary mode. These tests pin that equivalence so a future "let's
 * skip resolution in dev" change fails loudly.
 *
 * Separate file because binary-mode tests mock BUNDLED_IS_BINARY=true.
 */
import { describe, test, expect, mock, beforeEach, afterAll, spyOn } from 'bun:test';
import { createMockLogger } from '../test/mocks/logger';

const mockLogger = createMockLogger();

mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
  BUNDLED_IS_BINARY: false,
}));

import * as resolver from './binary-resolver';

describe('resolveClaudeBinaryPath (dev mode honors the same chain as binary mode)', () => {
  const originalEnv = process.env.CLAUDE_BIN_PATH;
  let fileExistsSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    delete process.env.CLAUDE_BIN_PATH;
    fileExistsSpy?.mockRestore();
    mockLogger.info.mockClear();
  });

  afterAll(() => {
    if (originalEnv !== undefined) {
      process.env.CLAUDE_BIN_PATH = originalEnv;
    } else {
      delete process.env.CLAUDE_BIN_PATH;
    }
    fileExistsSpy?.mockRestore();
  });

  test('uses CLAUDE_BIN_PATH env var when set and file exists (no dev short-circuit)', async () => {
    process.env.CLAUDE_BIN_PATH = '/dev/path/claude';
    fileExistsSpy = spyOn(resolver, 'fileExists').mockReturnValue(true);

    const result = await resolver.resolveClaudeBinaryPath();
    expect(result).toBe('/dev/path/claude');
  });

  test('uses config claudeBinaryPath when file exists (no dev short-circuit)', async () => {
    fileExistsSpy = spyOn(resolver, 'fileExists').mockReturnValue(true);

    const result = await resolver.resolveClaudeBinaryPath('/dev/config/claude');
    expect(result).toBe('/dev/config/claude');
  });
});
