import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';

const createOpencode = mock(() => {
  throw new Error('Doctor must not start the server');
});
mock.module('@opencode-ai/sdk', () => ({ createOpencode }));
const { probeOpencodeRuntime } = await import('./runtime');

function sdkResolvesWindowsExecutable(): boolean {
  const requireSdk = createRequire(createRequire(import.meta.url).resolve('@opencode-ai/sdk'));
  const crossSpawn: unknown = requireSdk('cross-spawn');
  if (
    typeof crossSpawn !== 'function' ||
    !('_parse' in crossSpawn) ||
    typeof crossSpawn._parse !== 'function'
  ) {
    throw new Error('SDK cross-spawn parser unavailable');
  }
  const parsed: unknown = crossSpawn._parse('opencode', [], { env: { ...process.env } });
  if (typeof parsed !== 'object' || parsed === null || !('file' in parsed)) {
    throw new Error('SDK cross-spawn parser result unavailable');
  }
  return typeof parsed.file === 'string';
}

describe('probeOpencodeRuntime', () => {
  let root: string;
  let originalPath: string | undefined;
  let originalPathExt: string | undefined;
  const originalCwd = process.cwd();

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'archon-opencode-probe-'));
    originalPath = process.env.PATH;
    originalPathExt = process.env.PATHEXT;
    process.env.PATH = root;
    process.env.PATHEXT = '.EXE;.CMD;.BAT;.COM';
    createOpencode.mockClear();
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalPathExt === undefined) delete process.env.PATHEXT;
    else process.env.PATHEXT = originalPathExt;
    await removeTempTree(root);
    expect(createOpencode).not.toHaveBeenCalled();
  });

  it('reports the missing executable even when the SDK is present', async () => {
    expect(await probeOpencodeRuntime()).toBe('executable-missing');
  });

  it('finds an executable on the current inherited PATH without running it', async () => {
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

  it.skipIf(process.platform === 'win32')(
    'matches SDK spawn lookup when PATH is empty or absent',
    async () => {
      process.chdir(root);
      writeFileSync(join(root, 'opencode'), '', { mode: 0o755 });
      for (const path of ['', undefined]) {
        if (path === undefined) delete process.env.PATH;
        else process.env.PATH = path;
        const spawned = spawnSync('opencode', ['--version'], {
          env: { ...process.env },
          timeout: 1000,
        });
        const unresolved =
          spawned.error && 'code' in spawned.error && spawned.error.code === 'ENOENT';
        expect(await probeOpencodeRuntime()).toBe(unresolved ? 'executable-missing' : 'ready');
      }
    }
  );

  it.skipIf(process.platform !== 'win32')(
    'matches SDK lookup with custom PATHEXT and quoted PATH',
    async () => {
      process.env.PATHEXT = '.CUSTOM';
      process.env.PATH = `"${root}"`;
      writeFileSync(join(root, 'opencode.CUSTOM'), '');
      expect(sdkResolvesWindowsExecutable()).toBe(true);
      expect(await probeOpencodeRuntime()).toBe('ready');
      process.env.PATHEXT = '.EXE';
      expect(sdkResolvesWindowsExecutable()).toBe(false);
      expect(await probeOpencodeRuntime()).toBe('executable-missing');
    }
  );

  it.skipIf(process.platform !== 'win32')(
    'matches SDK lookup in cwd and for extensionless files',
    async () => {
      process.chdir(root);
      process.env.PATH = join(root, 'missing');
      writeFileSync(join(root, 'opencode'), '');
      expect(sdkResolvesWindowsExecutable()).toBe(true);
      expect(await probeOpencodeRuntime()).toBe('ready');
    }
  );
});
