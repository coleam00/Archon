// @archon-test-isolated
// @archon-test-windows
/**
 * The Codex binary resolver's Windows probe: the npm global install under %APPDATA%. Mocks
 * @archon/paths in binary mode like binary-resolver.test.ts, so it runs in its own process.
 */
import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { createMockLogger } from '../test/mocks/logger';

const mockLogger = createMockLogger();

const realPaths = await import('@archon/paths');
mock.module('@archon/paths', () => ({
  ...realPaths,
  createLogger: mock(() => mockLogger),
  BUNDLED_IS_BINARY: true,
  getArchonHome: mock(() => '/tmp/test-archon-home'),
}));

import * as resolver from './binary-resolver';

describe('resolveCodexBinaryPath on Windows (binary mode)', () => {
  const originalEnv = process.env.CODEX_BIN_PATH;
  const originalAppData = process.env.APPDATA;
  let pathKindSpy: ReturnType<typeof spyOn> | undefined;

  afterEach(() => {
    pathKindSpy?.mockRestore();
    if (originalEnv !== undefined) process.env.CODEX_BIN_PATH = originalEnv;
    else delete process.env.CODEX_BIN_PATH;
    if (originalAppData !== undefined) process.env.APPDATA = originalAppData;
    else delete process.env.APPDATA;
  });

  test.skipIf(process.platform !== 'win32')(
    'autodetects npm global install at %APPDATA%\\npm\\codex.cmd',
    async () => {
      delete process.env.CODEX_BIN_PATH;
      // The resolver probes %APPDATA% only when it is set, so the test sets its own.
      const appData = 'C:\\Users\\test\\AppData\\Roaming';
      process.env.APPDATA = appData;
      const expected = `${appData}\\npm\\codex.cmd`;
      pathKindSpy = spyOn(resolver, 'pathKind').mockImplementation((path: string) =>
        path === expected ? 'file' : 'missing'
      );

      const result = await resolver.resolveCodexBinaryPath();
      expect(result).toBe(expected);
      expect(mockLogger.info).toHaveBeenCalledWith(
        { binaryPath: expected, source: 'autodetect' },
        'codex.binary_resolved'
      );
    }
  );
});
