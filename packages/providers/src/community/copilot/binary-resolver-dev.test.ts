/**
 * Tests for the Copilot binary resolver in dev mode (BUNDLED_IS_BINARY=false).
 * Separate file because binary-mode tests mock BUNDLED_IS_BINARY=true.
 */
import { afterEach, beforeEach, describe, test, expect, mock, spyOn } from 'bun:test';
import { dirname, join } from 'node:path';
import { createMockLogger } from '../../test/mocks/logger';

mock.module('@archon/paths', () => ({
  createLogger: mock(() => createMockLogger()),
  BUNDLED_IS_BINARY: false,
  getArchonHome: mock(() => '/tmp/test-archon-home'),
}));

import * as resolver from './binary-resolver';
const { resolveCopilotBinaryPath } = resolver;

describe('resolveCopilotBinaryPath (dev mode)', () => {
  let savedPin: string | undefined;
  beforeEach(() => {
    savedPin = process.env.COPILOT_BIN_PATH;
    delete process.env.COPILOT_BIN_PATH;
  });
  afterEach(() => {
    if (savedPin === undefined) delete process.env.COPILOT_BIN_PATH;
    else process.env.COPILOT_BIN_PATH = savedPin;
  });

  test('leaves unpinned resolution to the SDK without probing compiled-mode candidates', async () => {
    const fileSpy = spyOn(resolver, 'isExecutableFile').mockReturnValue(true);
    const pathSpy = spyOn(resolver, 'resolveFromPath').mockReturnValue('/path/copilot');
    try {
      expect(await resolveCopilotBinaryPath()).toBeUndefined();
      expect(fileSpy).not.toHaveBeenCalled();
      expect(pathSpy).not.toHaveBeenCalled();
    } finally {
      fileSpy.mockRestore();
      pathSpy.mockRestore();
    }
  });

  test('honors a valid env executable', async () => {
    process.env.COPILOT_BIN_PATH = process.execPath;
    expect(await resolveCopilotBinaryPath()).toBe(process.execPath);
  });

  test('honors a valid config executable', async () => {
    expect(await resolveCopilotBinaryPath(process.execPath)).toBe(process.execPath);
  });

  test('env pin takes precedence over config', async () => {
    process.env.COPILOT_BIN_PATH = process.execPath;
    expect(await resolveCopilotBinaryPath('/missing/config/copilot')).toBe(process.execPath);
  });

  test('an invalid env pin refuses a valid config executable with repair advice', async () => {
    const missing = join(process.execPath, 'missing-copilot');
    process.env.COPILOT_BIN_PATH = missing;
    await expect(resolveCopilotBinaryPath(process.execPath)).rejects.toThrow(
      new Error(
        `COPILOT_BIN_PATH is set to "${missing}" but it is not an executable file.\n` +
          'Please verify the path points to the Copilot CLI executable (chmod +x if needed).'
      )
    );
  });

  test('an invalid config pin fails with repair advice instead of using the SDK', async () => {
    const missing = join(process.execPath, 'missing-copilot');
    await expect(resolveCopilotBinaryPath(missing)).rejects.toThrow(
      new Error(
        `assistants.copilot.copilotCliPath is set to "${missing}" but it is not an executable file.\n` +
          'Please verify the path in .archon/config.yaml points to the Copilot CLI executable (chmod +x if needed).'
      )
    );
  });

  test('rejects a directory supplied as an env pin', async () => {
    process.env.COPILOT_BIN_PATH = dirname(process.execPath);
    await expect(resolveCopilotBinaryPath()).rejects.toThrow('is not an executable file');
  });

  test('rejects a directory supplied as a config pin', async () => {
    await expect(resolveCopilotBinaryPath(dirname(process.execPath))).rejects.toThrow(
      'is not an executable file'
    );
  });

  test('an empty env pin keeps the SDK default', async () => {
    process.env.COPILOT_BIN_PATH = '';
    const result = await resolveCopilotBinaryPath();
    expect(result).toBeUndefined();
  });

  test('an empty env pin allows a valid config pin', async () => {
    process.env.COPILOT_BIN_PATH = '';
    expect(await resolveCopilotBinaryPath(process.execPath)).toBe(process.execPath);
  });
});
