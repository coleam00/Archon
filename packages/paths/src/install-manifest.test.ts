import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { isAbsolute, join, resolve } from 'path';
import { refreshCompiledInstallManifest, type InstallManifest } from './install-manifest';

describe('compiled install manifest', () => {
  const envKeys = ['ARCHON_HOME', 'WORKSPACE_PATH', 'ARCHON_DOCKER'] as const;
  const originalEnv: Partial<Record<(typeof envKeys)[number], string>> = {};
  let testDir: string;

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

  function manifestPath(): string {
    return join(testDir, 'install.json');
  }

  function readManifest(): InstallManifest {
    return JSON.parse(readFileSync(manifestPath(), 'utf8')) as InstallManifest;
  }

  function createBinary(name: string): string {
    const binary = join(testDir, 'bin', name);
    mkdirSync(join(testDir, 'bin'), { recursive: true });
    writeFileSync(binary, '#!/bin/sh\n');
    chmodSync(binary, 0o755);
    return binary;
  }

  test('writes exactly the canonical binary path and version', () => {
    const binary = createBinary('archon');

    refreshCompiledInstallManifest(true, binary, '1.2.3');

    const manifest = readManifest();
    expect(manifest).toEqual({ binary: realpathSync(binary), version: '1.2.3' });
    expect(Object.keys(manifest)).toEqual(['binary', 'version']);
    expect(isAbsolute(manifest.binary)).toBe(true);
  });

  test('does not write for a source-mode invocation', () => {
    refreshCompiledInstallManifest(false, process.execPath, 'dev');
    expect(() => readManifest()).toThrow();
  });

  test('does not rewrite an unchanged manifest', () => {
    const binary = createBinary('archon');
    const manifest: InstallManifest = { binary: realpathSync(binary), version: '1.2.3' };
    const original = JSON.stringify(manifest);
    writeFileSync(manifestPath(), original);

    refreshCompiledInstallManifest(true, binary, '1.2.3');

    expect(readFileSync(manifestPath(), 'utf8')).toBe(original);
  });

  test('replaces the manifest when the binary or version changes', () => {
    const first = createBinary('archon-first');
    const second = createBinary('archon-second');
    refreshCompiledInstallManifest(true, first, '1.0.0');

    refreshCompiledInstallManifest(true, second, '2.0.0');

    expect(readManifest()).toEqual({ binary: realpathSync(second), version: '2.0.0' });
  });

  test('repairs malformed discovery metadata', () => {
    writeFileSync(manifestPath(), '{"binary":42,"version":"old"}');

    refreshCompiledInstallManifest(true, 'missing/archon', '1.0.0');

    expect(readManifest()).toEqual({
      binary: resolve('missing/archon'),
      version: '1.0.0',
    });
  });

  test('does not throw or leave a temporary file when persistence fails', () => {
    mkdirSync(manifestPath());

    expect(() => refreshCompiledInstallManifest(true, process.execPath, '1.2.3')).not.toThrow();
    expect(readdirSync(testDir).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });
});
