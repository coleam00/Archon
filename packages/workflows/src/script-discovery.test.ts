import { describe, test, expect, mock, beforeEach } from 'bun:test';

// Mock fs/promises before importing the module under test
const mockReaddir = mock(async (_path: string): Promise<string[]> => []);
const mockStat = mock(async (_path: string) => ({ isDirectory: () => false }));

mock.module('fs/promises', () => ({
  readdir: mockReaddir,
  stat: mockStat,
}));

// Mock logger
const mockLogger = {
  fatal: mock(() => undefined),
  error: mock(() => undefined),
  warn: mock(() => undefined),
  info: mock(() => undefined),
  debug: mock(() => undefined),
  trace: mock(() => undefined),
};
mock.module('@archon/paths', () => ({ createLogger: mock(() => mockLogger) }));

import { discoverScripts, getDefaultScripts } from './script-discovery';

describe('discoverScripts', () => {
  beforeEach(() => {
    mockReaddir.mockClear();
    mockStat.mockClear();
    mockLogger.info.mockClear();
    mockLogger.debug.mockClear();
    mockLogger.warn.mockClear();
  });

  test('returns empty map when directory does not exist', async () => {
    mockReaddir.mockRejectedValueOnce(
      Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' })
    );
    const result = await discoverScripts('/some/nonexistent/dir');
    expect(result.size).toBe(0);
  });

  test('returns empty map when directory is empty', async () => {
    mockReaddir.mockResolvedValueOnce([]);
    const result = await discoverScripts('/scripts');
    expect(result.size).toBe(0);
  });

  test('discovers a TypeScript file as bun runtime', async () => {
    mockReaddir.mockResolvedValueOnce(['fetch-prices.ts']);
    mockStat.mockResolvedValueOnce({ isDirectory: () => false });

    const result = await discoverScripts('/scripts');

    expect(result.size).toBe(1);
    const script = result.get('fetch-prices');
    expect(script).toBeDefined();
    expect(script!.name).toBe('fetch-prices');
    expect(script!.runtime).toBe('bun');
    expect(script!.path).toBe('/scripts/fetch-prices.ts');
  });

  test('discovers a JavaScript file as bun runtime', async () => {
    mockReaddir.mockResolvedValueOnce(['compute.js']);
    mockStat.mockResolvedValueOnce({ isDirectory: () => false });

    const result = await discoverScripts('/scripts');

    const script = result.get('compute');
    expect(script).toBeDefined();
    expect(script!.runtime).toBe('bun');
  });

  test('discovers a Python file as uv runtime', async () => {
    mockReaddir.mockResolvedValueOnce(['analyze.py']);
    mockStat.mockResolvedValueOnce({ isDirectory: () => false });

    const result = await discoverScripts('/scripts');

    const script = result.get('analyze');
    expect(script).toBeDefined();
    expect(script!.runtime).toBe('uv');
    expect(script!.path).toBe('/scripts/analyze.py');
  });

  test('skips files with unknown extensions', async () => {
    mockReaddir.mockResolvedValueOnce(['script.rb', 'notes.txt', 'run.sh']);
    mockStat.mockResolvedValueOnce({ isDirectory: () => false });
    mockStat.mockResolvedValueOnce({ isDirectory: () => false });
    mockStat.mockResolvedValueOnce({ isDirectory: () => false });

    const result = await discoverScripts('/scripts');

    expect(result.size).toBe(0);
  });

  test('keys scripts by filename without extension', async () => {
    mockReaddir.mockResolvedValueOnce(['my-cool-script.ts']);
    mockStat.mockResolvedValueOnce({ isDirectory: () => false });

    const result = await discoverScripts('/scripts');

    expect(result.has('my-cool-script')).toBe(true);
    expect(result.has('my-cool-script.ts')).toBe(false);
  });

  test('throws on duplicate script names across extensions', async () => {
    mockReaddir.mockResolvedValueOnce(['fetch.ts', 'fetch.py']);
    mockStat.mockResolvedValueOnce({ isDirectory: () => false });
    mockStat.mockResolvedValueOnce({ isDirectory: () => false });

    await expect(discoverScripts('/scripts')).rejects.toThrow(/Duplicate script name "fetch"/);
  });

  test('includes both paths in duplicate error message', async () => {
    mockReaddir.mockResolvedValueOnce(['run.js', 'run.py']);
    mockStat.mockResolvedValueOnce({ isDirectory: () => false });
    mockStat.mockResolvedValueOnce({ isDirectory: () => false });

    try {
      await discoverScripts('/scripts');
      expect(true).toBe(false); // should not reach here
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain('run.js');
      expect(message).toContain('run.py');
      expect(message).toContain('unique across extensions');
    }
  });

  test('recursively scans subdirectories', async () => {
    // Top-level readdir returns one directory and one file
    mockReaddir.mockResolvedValueOnce(['subdir', 'top.ts']);
    // stat for 'subdir' - is a directory
    mockStat.mockResolvedValueOnce({ isDirectory: () => true });
    // readdir for subdir
    mockReaddir.mockResolvedValueOnce(['nested.py']);
    // stat for nested.py
    mockStat.mockResolvedValueOnce({ isDirectory: () => false });
    // stat for top.ts
    mockStat.mockResolvedValueOnce({ isDirectory: () => false });

    const result = await discoverScripts('/scripts');

    expect(result.size).toBe(2);
    expect(result.has('nested')).toBe(true);
    expect(result.get('nested')!.runtime).toBe('uv');
    expect(result.has('top')).toBe(true);
    expect(result.get('top')!.runtime).toBe('bun');
  });

  test('stores the full path in the script definition', async () => {
    mockReaddir.mockResolvedValueOnce(['prices.ts']);
    mockStat.mockResolvedValueOnce({ isDirectory: () => false });

    const result = await discoverScripts('/my/scripts');

    const script = result.get('prices');
    expect(script!.path).toBe('/my/scripts/prices.ts');
  });
});

describe('getDefaultScripts', () => {
  test('returns an empty Map', () => {
    const defaults = getDefaultScripts();
    expect(defaults).toBeInstanceOf(Map);
    expect(defaults.size).toBe(0);
  });

  test('returns a new Map each call', () => {
    const a = getDefaultScripts();
    const b = getDefaultScripts();
    expect(a).not.toBe(b);
  });
});
