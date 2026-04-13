/**
 * Tests for the Codex binary resolver in dev mode (BUNDLED_IS_BINARY=false).
 * Separate file because binary-mode tests mock BUNDLED_IS_BINARY=true.
 */
import { describe, test, expect, mock } from 'bun:test';
import { createMockLogger } from '../test/mocks/logger';

mock.module('@archon/paths', () => ({
  createLogger: mock(() => createMockLogger()),
  BUNDLED_IS_BINARY: false,
  getArchonHome: mock(() => '/tmp/test-archon-home'),
}));

import { resolveCodexBinaryPath } from './binary-resolver';

describe('resolveCodexBinaryPath (dev mode)', () => {
  test('returns undefined when BUNDLED_IS_BINARY is false', async () => {
    const result = await resolveCodexBinaryPath();
    expect(result).toBeUndefined();
  });

  test('returns undefined even with config path set', async () => {
    const result = await resolveCodexBinaryPath('/some/custom/path');
    expect(result).toBeUndefined();
  });
});
