import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
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

mock.module('@archon/paths', () => ({
  BUNDLED_IS_BINARY: true,
  getArchonHome: () => '/tmp/.archon',
  createLogger: () => mockLogger,
}));

import * as resolver from './binary-resolver';

describe('resolveCopilotCliPath', () => {
  beforeEach(() => {
    delete process.env.COPILOT_CLI_PATH;
  });

  test('uses env override when present', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'copilot-bin-'));
    const binaryPath = join(dir, 'copilot');
    writeFileSync(binaryPath, '#!/bin/sh\n');
    process.env.COPILOT_CLI_PATH = binaryPath;

    await expect(resolver.resolveCopilotCliPath()).resolves.toBe(binaryPath);
  });

  test('throws when env override path is missing', async () => {
    process.env.COPILOT_CLI_PATH = '/missing/copilot';

    await expect(resolver.resolveCopilotCliPath()).rejects.toThrow('COPILOT_CLI_PATH');
  });

  test('uses config override when present', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'copilot-bin-'));
    const binaryPath = join(dir, 'copilot');
    writeFileSync(binaryPath, '#!/bin/sh\n');

    await expect(resolver.resolveCopilotCliPath(binaryPath)).resolves.toBe(binaryPath);
  });

  test('uses vendor path in binary mode when available', async () => {
    const vendorDir = '/tmp/.archon/vendor/copilot';
    mkdirSync(vendorDir, { recursive: true });
    const vendorPath = join(vendorDir, 'copilot');
    writeFileSync(vendorPath, '#!/bin/sh\n');

    await expect(resolver.resolveCopilotCliPath()).resolves.toBe(vendorPath);
  });
});
