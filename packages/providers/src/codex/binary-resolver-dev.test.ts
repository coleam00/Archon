/**
 * Tests for the Codex binary resolver in dev mode (BUNDLED_IS_BINARY=false).
 * Separate file because binary-mode tests mock BUNDLED_IS_BINARY=true.
 */
import { afterEach, beforeEach, describe, test, expect, mock, spyOn } from 'bun:test';
import { createMockLogger } from '../test/mocks/logger';

mock.module('@archon/paths', () => ({
  createLogger: mock(() => createMockLogger()),
  BUNDLED_IS_BINARY: false,
  getArchonHome: mock(() => '/tmp/test-archon-home'),
}));

import * as resolver from './binary-resolver';
const { resolveCodexBinaryPath, resolveCodexBinaryWithSource } = resolver;

async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('Expected promise to reject');
}

describe('resolveCodexBinaryPath (dev mode)', () => {
  let savedPin: string | undefined;
  beforeEach(() => {
    savedPin = process.env.CODEX_BIN_PATH;
    delete process.env.CODEX_BIN_PATH;
  });
  afterEach(() => {
    if (savedPin === undefined) delete process.env.CODEX_BIN_PATH;
    else process.env.CODEX_BIN_PATH = savedPin;
  });
  test('returns undefined when BUNDLED_IS_BINARY is false', async () => {
    const result = await resolveCodexBinaryPath();
    expect(result).toBeUndefined();
  });

  test('honors a configured executable and reports its source', async () => {
    expect(await resolveCodexBinaryWithSource(process.execPath)).toEqual({
      path: process.execPath,
      source: 'config',
    });
  });

  test('environment pin takes precedence over config', async () => {
    process.env.CODEX_BIN_PATH = process.execPath;
    expect(await resolveCodexBinaryWithSource('/missing/config/codex')).toEqual({
      path: process.execPath,
      source: 'env',
    });
  });

  test('an invalid config pin fails instead of using the SDK binary', async () => {
    await expect(resolveCodexBinaryPath('/missing/config/codex')).rejects.toThrow(
      'assistants.codex.codexBinaryPath'
    );
  });

  test('an invalid env pin fails instead of using the SDK binary, taking precedence over a valid config path', async () => {
    process.env.CODEX_BIN_PATH = '/missing/env/codex';
    await expect(resolveCodexBinaryPath(process.execPath)).rejects.toThrow('CODEX_BIN_PATH');
  });

  test('an invalid pin omits the fallback hint even when a lower-tier candidate exists on disk', async () => {
    process.env.CODEX_BIN_PATH = '/missing/env/codex';
    const pathKindSpy = spyOn(resolver, 'pathKind').mockImplementation((path: string) =>
      path === '/missing/env/codex' ? 'missing' : 'file'
    );
    try {
      const message = await rejectionMessage(resolveCodexBinaryPath());
      expect(message).not.toContain('A Codex binary was found');
    } finally {
      pathKindSpy.mockRestore();
    }
  });
});
