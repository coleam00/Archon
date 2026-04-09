import { describe, it, expect, mock, beforeEach, spyOn } from 'bun:test';

// Mock @archon/paths BEFORE importing the module under test.
// This sets BUNDLED_IS_BINARY = false (dev mode) so serveCommand rejects.
const mockLogger = {
  fatal: mock(() => undefined),
  error: mock(() => undefined),
  warn: mock(() => undefined),
  info: mock(() => undefined),
  debug: mock(() => undefined),
  trace: mock(() => undefined),
};
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
  getWebDistDir: mock((version: string) => `/tmp/test-archon/web-dist/${version}`),
  BUNDLED_IS_BINARY: false,
  BUNDLED_VERSION: 'dev',
}));

import { serveCommand, parseChecksum } from './serve';

describe('parseChecksum', () => {
  it('should extract hash for matching filename', () => {
    const checksums = [
      'abc123def456  archon-linux-x64',
      'deadbeef1234  archon-web.tar.gz',
      'cafe0000babe  archon-darwin-arm64',
    ].join('\n');

    expect(parseChecksum(checksums, 'archon-web.tar.gz')).toBe('deadbeef1234');
  });

  it('should handle single-space separator', () => {
    const checksums = 'abc123 archon-web.tar.gz\n';
    expect(parseChecksum(checksums, 'archon-web.tar.gz')).toBe('abc123');
  });

  it('should throw for missing filename', () => {
    const checksums = 'abc123  archon-linux-x64\n';
    expect(() => parseChecksum(checksums, 'archon-web.tar.gz')).toThrow(
      'Checksum not found for archon-web.tar.gz'
    );
  });

  it('should throw for empty checksums text', () => {
    expect(() => parseChecksum('', 'archon-web.tar.gz')).toThrow('Checksum not found');
  });

  it('should skip blank lines', () => {
    const checksums = '\nabc123  archon-web.tar.gz\n\n';
    expect(parseChecksum(checksums, 'archon-web.tar.gz')).toBe('abc123');
  });
});

describe('serveCommand', () => {
  let consoleErrorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});
  });

  it('should reject in dev mode (non-binary)', async () => {
    const exitCode = await serveCommand({});
    expect(exitCode).toBe(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      'Error: `archon serve` is for compiled binaries only.'
    );
    consoleErrorSpy.mockRestore();
  });

  it('should reject with downloadOnly in dev mode', async () => {
    const exitCode = await serveCommand({ downloadOnly: true });
    expect(exitCode).toBe(1);
    consoleErrorSpy.mockRestore();
  });
});
