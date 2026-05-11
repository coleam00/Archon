import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';

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
  const validHash = 'a'.repeat(64);

  it('should extract hash for matching filename', () => {
    const checksums = [
      `${'b'.repeat(64)}  archon-linux-x64`,
      `${validHash}  archon-web.tar.gz`,
      `${'c'.repeat(64)}  archon-darwin-arm64`,
    ].join('\n');

    expect(parseChecksum(checksums, 'archon-web.tar.gz')).toBe(validHash);
  });

  it('should handle single-space separator', () => {
    const checksums = `${validHash} archon-web.tar.gz\n`;
    expect(parseChecksum(checksums, 'archon-web.tar.gz')).toBe(validHash);
  });

  it('should throw for missing filename', () => {
    const checksums = `${validHash}  archon-linux-x64\n`;
    expect(() => parseChecksum(checksums, 'archon-web.tar.gz')).toThrow(
      'Checksum not found for archon-web.tar.gz'
    );
  });

  it('should throw for empty checksums text', () => {
    expect(() => parseChecksum('', 'archon-web.tar.gz')).toThrow('Checksum not found');
  });

  it('should skip blank lines', () => {
    const checksums = `\n${validHash}  archon-web.tar.gz\n\n`;
    expect(parseChecksum(checksums, 'archon-web.tar.gz')).toBe(validHash);
  });

  it('should throw for malformed hash (not 64 hex chars)', () => {
    const checksums = 'short_hash  archon-web.tar.gz\n';
    expect(() => parseChecksum(checksums, 'archon-web.tar.gz')).toThrow(
      'Malformed checksum entry for archon-web.tar.gz'
    );
  });

  it('should throw for uppercase hex hash', () => {
    const checksums = `${'A'.repeat(64)}  archon-web.tar.gz\n`;
    expect(() => parseChecksum(checksums, 'archon-web.tar.gz')).toThrow(
      'Malformed checksum entry for archon-web.tar.gz'
    );
  });
});

describe('serveCommand', () => {
  let consoleErrorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('should reject in dev mode (non-binary)', async () => {
    const exitCode = await serveCommand({});
    expect(exitCode).toBe(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      'Error: `archon serve` is for compiled binaries only.'
    );
  });

  it('should reject with downloadOnly in dev mode', async () => {
    const exitCode = await serveCommand({ downloadOnly: true });
    expect(exitCode).toBe(1);
  });

  it('should reject invalid port (NaN)', async () => {
    const exitCode = await serveCommand({ port: NaN });
    expect(exitCode).toBe(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('--port must be an integer between 1 and 65535')
    );
  });

  it('should reject port out of range', async () => {
    const exitCode = await serveCommand({ port: 99999 });
    expect(exitCode).toBe(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('--port must be an integer between 1 and 65535')
    );
  });

  it('should reject port 0', async () => {
    const exitCode = await serveCommand({ port: 0 });
    expect(exitCode).toBe(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('--port must be an integer between 1 and 65535')
    );
  });
});
