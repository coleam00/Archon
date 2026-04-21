/**
 * Tests for the Claude binary resolver in dev mode (BUNDLED_IS_BINARY=false).
 * Separate file because binary-mode tests mock BUNDLED_IS_BINARY=true.
 */
import { describe, test, expect, mock } from 'bun:test';
import { createMockLogger } from '../test/mocks/logger';

mock.module('@harneeslab/paths', () => ({
  createLogger: mock(() => createMockLogger()),
  BUNDLED_IS_BINARY: false,
}));

import { resolveClaudeBinaryPath } from './binary-resolver';

describe('resolveClaudeBinaryPath (dev mode)', () => {
  test('returns undefined when BUNDLED_IS_BINARY is false', async () => {
    const result = await resolveClaudeBinaryPath();
    expect(result).toBeUndefined();
  });

  test('returns undefined even with config path set', async () => {
    const result = await resolveClaudeBinaryPath('/some/custom/path');
    expect(result).toBeUndefined();
  });

  test('returns undefined even with env var set', async () => {
    const original = process.env.CLAUDE_BIN_PATH;
    process.env.CLAUDE_BIN_PATH = '/some/env/path';
    try {
      const result = await resolveClaudeBinaryPath();
      expect(result).toBeUndefined();
    } finally {
      if (original !== undefined) {
        process.env.CLAUDE_BIN_PATH = original;
      } else {
        delete process.env.CLAUDE_BIN_PATH;
      }
    }
  });
});
