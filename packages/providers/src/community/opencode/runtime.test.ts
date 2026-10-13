import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';

const createOpencode = mock(() => {
  throw new Error('Doctor must not start the server');
});
mock.module('@opencode-ai/sdk', () => ({ createOpencode }));
const { probeOpencodeRuntime } = await import('./runtime');

describe('probeOpencodeRuntime', () => {
  let root: string;
  let originalPath: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'archon-opencode-probe-'));
    originalPath = process.env.PATH;
    process.env.PATH = root;
    createOpencode.mockClear();
  });

  afterEach(async () => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    await removeTempTree(root);
    expect(createOpencode).not.toHaveBeenCalled();
  });

  it('reports the missing executable even when the SDK is present', async () => {
    expect(await probeOpencodeRuntime()).toBe('executable-missing');
  });

  it('finds an executable on PATH without running it', async () => {
    writeFileSync(join(root, process.platform === 'win32' ? 'opencode.exe' : 'opencode'), '', {
      mode: 0o755,
    });
    expect(await probeOpencodeRuntime()).toBe('ready');
  });

  it.skipIf(process.platform === 'win32')('rejects a non-executable file on PATH', async () => {
    const binary = join(root, 'opencode');
    writeFileSync(binary, '');
    chmodSync(binary, 0o644);
    expect(await probeOpencodeRuntime()).toBe('executable-missing');
  });
});
