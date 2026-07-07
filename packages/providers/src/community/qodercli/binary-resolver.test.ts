import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveQoderCliBinaryPath } from './binary-resolver';

const originalEnvPath = process.env.QODERCLI_BIN_PATH;

async function makeExecutable(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'archon-qodercli-'));
  const path = join(dir, process.platform === 'win32' ? 'qodercli.exe' : 'qodercli');
  await writeFile(path, '#!/usr/bin/env sh\nexit 0\n');
  await chmod(path, 0o755);
  return path;
}

describe('resolveQoderCliBinaryPath', () => {
  afterEach(() => {
    if (originalEnvPath === undefined) {
      delete process.env.QODERCLI_BIN_PATH;
    } else {
      process.env.QODERCLI_BIN_PATH = originalEnvPath;
    }
  });

  test('uses QODERCLI_BIN_PATH when set', async () => {
    const path = await makeExecutable();
    process.env.QODERCLI_BIN_PATH = path;
    try {
      await expect(resolveQoderCliBinaryPath('/different/qodercli')).resolves.toBe(path);
    } finally {
      await rm(join(path, '..'), { recursive: true, force: true });
    }
  });

  test('uses provided env QODERCLI_BIN_PATH before config path', async () => {
    delete process.env.QODERCLI_BIN_PATH;
    const path = await makeExecutable();
    try {
      await expect(
        resolveQoderCliBinaryPath('/different/qodercli', { QODERCLI_BIN_PATH: path })
      ).resolves.toBe(path);
    } finally {
      await rm(join(path, '..'), { recursive: true, force: true });
    }
  });

  test('throws a clear error for invalid QODERCLI_BIN_PATH', async () => {
    process.env.QODERCLI_BIN_PATH = '/definitely/missing/qodercli';
    await expect(resolveQoderCliBinaryPath()).rejects.toThrow('QODERCLI_BIN_PATH');
  });

  test('uses config path when env override is absent', async () => {
    delete process.env.QODERCLI_BIN_PATH;
    const path = await makeExecutable();
    try {
      await expect(resolveQoderCliBinaryPath(path)).resolves.toBe(path);
    } finally {
      await rm(join(path, '..'), { recursive: true, force: true });
    }
  });
});
