import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { isAbsolute, join, resolve } from 'path';
import {
  refreshCompiledInstallManifest,
  writeInstallManifest,
  type InstallManifest,
} from './install-manifest';

describe('install manifest', () => {
  const envKeys = ['ARCHON_HOME', 'WORKSPACE_PATH', 'ARCHON_DOCKER'] as const;
  let testDir: string;
  const originalEnv: Partial<Record<(typeof envKeys)[number], string>> = {};

  beforeEach(() => {
    for (const key of envKeys) originalEnv[key] = process.env[key];
    testDir = mkdtempSync(join(tmpdir(), 'archon-install-manifest-'));
    delete process.env.WORKSPACE_PATH;
    delete process.env.ARCHON_DOCKER;
    process.env.ARCHON_HOME = testDir;
  });

  afterEach(() => {
    for (const key of envKeys) {
      const value = originalEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(testDir, { recursive: true, force: true });
  });

  function readManifest(): InstallManifest {
    return JSON.parse(readFileSync(join(testDir, 'install.json'), 'utf8')) as InstallManifest;
  }

  test('writes a complete manifest under ARCHON_HOME with a canonical binary path', () => {
    const binary = join(testDir, 'bin', 'archon');
    mkdirSync(join(testDir, 'bin'));
    writeFileSync(binary, '#!/bin/sh\n');
    chmodSync(binary, 0o755);

    writeInstallManifest({ binary, version: '1.2.3', method: 'curl' });

    const manifest = readManifest();
    expect(manifest.binary).toBe(realpathSync(binary));
    expect(isAbsolute(manifest.binary)).toBe(true);
    expect(manifest.version).toBe('1.2.3');
    expect(manifest.method).toBe('curl');
    expect(Number.isNaN(Date.parse(manifest.installedAt))).toBe(false);
  });

  test('refreshes an existing manifest', () => {
    writeInstallManifest({ binary: '/first/archon', version: '1.0.0', method: 'curl' });
    writeInstallManifest({ binary: '/second/archon', version: '2.0.0', method: 'manual' });

    expect(readManifest()).toMatchObject({
      binary: resolve('/second/archon'),
      version: '2.0.0',
      method: 'manual',
    });
  });

  test('falls back to an absolute input when the binary cannot be resolved', () => {
    writeInstallManifest({ binary: 'missing/archon', version: '1.0.0', method: 'manual' });
    expect(readManifest().binary).toBe(resolve('missing/archon'));
  });

  test('does not write for a source-mode startup', () => {
    refreshCompiledInstallManifest(false, process.execPath, 'dev');
    expect(() => readManifest()).toThrow();
  });

  test('writes for a compiled-mode startup', () => {
    refreshCompiledInstallManifest(true, process.execPath, '1.2.3');
    expect(readManifest()).toMatchObject({
      binary: process.execPath,
      version: '1.2.3',
      method: 'manual',
    });
  });

  test('does not throw when ARCHON_HOME is unusable', () => {
    const unusableHome = join(testDir, 'not-a-directory');
    writeFileSync(unusableHome, 'file');
    process.env.ARCHON_HOME = unusableHome;

    expect(() =>
      writeInstallManifest({ binary: process.execPath, version: '1.2.3', method: 'manual' })
    ).not.toThrow();
  });
});
