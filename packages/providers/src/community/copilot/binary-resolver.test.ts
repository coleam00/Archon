import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mockLogger = {
  fatal: mock(() => undefined),
  error: mock(() => undefined),
  warn: mock(() => undefined),
  info: mock(() => undefined),
  debug: mock(() => undefined),
  trace: mock(() => undefined),
  child: mock(function (this: unknown) {
    return this;
  }),
  bindings: mock(() => ({ module: 'test' })),
  isLevelEnabled: mock(() => true),
  level: 'info',
};

// Per-test Archon home — mutated from beforeEach so each test run is isolated
// and never writes to a shared `/tmp/.archon`.
let archonHome = '';

mock.module('@archon/paths', () => ({
  BUNDLED_IS_BINARY: true,
  getArchonHome: () => archonHome,
  createLogger: () => mockLogger,
}));

import * as resolver from './binary-resolver';

function writeExecutable(path: string): void {
  writeFileSync(path, '#!/bin/sh\n');
  chmodSync(path, 0o755);
}

let tmpRoot = '';
let originalCopilotCliPath: string | undefined;

describe('resolveCopilotCliPath', () => {
  beforeEach(() => {
    originalCopilotCliPath = process.env.COPILOT_CLI_PATH;
    delete process.env.COPILOT_CLI_PATH;
    tmpRoot = mkdtempSync(join(tmpdir(), 'copilot-bin-'));
    archonHome = join(tmpRoot, 'archon-home');
    mkdirSync(archonHome, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
    if (originalCopilotCliPath === undefined) {
      delete process.env.COPILOT_CLI_PATH;
    } else {
      process.env.COPILOT_CLI_PATH = originalCopilotCliPath;
    }
  });

  test('uses env override when present', async () => {
    const binaryPath = join(tmpRoot, 'copilot');
    writeExecutable(binaryPath);
    process.env.COPILOT_CLI_PATH = binaryPath;

    await expect(resolver.resolveCopilotCliPath()).resolves.toBe(binaryPath);
  });

  test('throws when env override path is missing', async () => {
    process.env.COPILOT_CLI_PATH = '/missing/copilot';

    await expect(resolver.resolveCopilotCliPath()).rejects.toThrow('COPILOT_CLI_PATH');
  });

  test('throws when env override path is a directory, not a file', async () => {
    const dirPath = join(tmpRoot, 'copilot-dir');
    mkdirSync(dirPath, { recursive: true });
    process.env.COPILOT_CLI_PATH = dirPath;

    await expect(resolver.resolveCopilotCliPath()).rejects.toThrow('not an executable file');
  });

  test('throws when env override path is not executable', async () => {
    const nonExec = join(tmpRoot, 'copilot-noexec');
    writeFileSync(nonExec, '#!/bin/sh\n');
    chmodSync(nonExec, 0o644);
    process.env.COPILOT_CLI_PATH = nonExec;

    // win32 skips the exec-bit check — skip assertion there.
    if (process.platform === 'win32') {
      await expect(resolver.resolveCopilotCliPath()).resolves.toBe(nonExec);
      return;
    }
    await expect(resolver.resolveCopilotCliPath()).rejects.toThrow('not an executable file');
  });

  test('uses config override when present', async () => {
    const binaryPath = join(tmpRoot, 'copilot');
    writeExecutable(binaryPath);

    await expect(resolver.resolveCopilotCliPath(binaryPath)).resolves.toBe(binaryPath);
  });

  test('uses vendor path in binary mode when available', async () => {
    // Hermetic: stub the executable probe so the test does not depend on
    // the real filesystem, the platform-specific binary name (`copilot.exe`
    // on win32), or a system-installed Copilot CLI leaking in via PATH.
    // Mirrors the sibling Codex resolver test.
    const spy = spyOn(resolver, 'isExecutableFile').mockImplementation((path: string) =>
      path.replace(/\\/g, '/').includes('/vendor/copilot/')
    );
    try {
      const result = await resolver.resolveCopilotCliPath();
      expect(result).toBeDefined();
      expect(result!.replace(/\\/g, '/')).toContain('/vendor/copilot/');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('isExecutableFile', () => {
  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'copilot-exec-'));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test('returns true for an executable file', () => {
    const path = join(tmpRoot, 'copilot');
    writeExecutable(path);
    expect(resolver.isExecutableFile(path)).toBe(true);
  });

  test('returns false for a missing path', () => {
    expect(resolver.isExecutableFile(join(tmpRoot, 'nope'))).toBe(false);
  });

  test('returns false for a directory', () => {
    const path = join(tmpRoot, 'a-dir');
    mkdirSync(path, { recursive: true });
    expect(resolver.isExecutableFile(path)).toBe(false);
  });

  test('returns false for a non-executable file on posix', () => {
    if (process.platform === 'win32') return;
    const path = join(tmpRoot, 'noexec');
    writeFileSync(path, '#!/bin/sh\n');
    chmodSync(path, 0o644);
    expect(resolver.isExecutableFile(path)).toBe(false);
  });
});
