// @archon-test-isolated
import { describe, test, expect, mock, beforeEach } from 'bun:test';

// Mock @archon/git before importing the module under test
const mockExecFileAsync = mock(
  async (_cmd: string, _args: string[]): Promise<{ stdout: string; stderr: string }> => ({
    stdout: '/usr/bin/bun\n',
    stderr: '',
  })
);

mock.module('@archon/git', () => ({
  execFileAsync: mockExecFileAsync,
}));

// Mock @archon/paths logger
mock.module('@archon/paths', () => ({
  createLogger: mock(() => ({
    fatal: mock(() => undefined),
    error: mock(() => undefined),
    warn: mock(() => undefined),
    info: mock(() => undefined),
    debug: mock(() => undefined),
    trace: mock(() => undefined),
  })),
  getCommandFolderSearchPaths: mock(() => ['.archon/commands']),
  findCommandFiles: mock(async () => []),
}));

// Mock defaults and command-validation used by the validator modules
mock.module('../defaults/bundled-defaults', () => ({
  BUNDLED_COMMANDS: {},
  isBinaryBuild: () => false,
}));

mock.module('../command-validation', () => ({
  isValidCommandName: () => true,
}));

import { checkRuntimeAvailable, clearRuntimeCache } from './scripts';

describe('checkRuntimeAvailable', () => {
  beforeEach(() => {
    mockExecFileAsync.mockClear();
    clearRuntimeCache();
  });

  test('returns true when binary is found (exit 0)', async () => {
    mockExecFileAsync.mockResolvedValueOnce({ stdout: '/usr/bin/bun\n', stderr: '' });
    const result = await checkRuntimeAvailable('bun');
    expect(result).toBe(true);
    expect(mockExecFileAsync).toHaveBeenCalledWith('which', ['bun']);
  });

  test('returns false when binary is not found (non-zero exit)', async () => {
    mockExecFileAsync.mockRejectedValueOnce(
      Object.assign(new Error('Command failed: which uv'), { code: 1 })
    );
    const result = await checkRuntimeAvailable('uv');
    expect(result).toBe(false);
    expect(mockExecFileAsync).toHaveBeenCalledWith('which', ['uv']);
  });
});
