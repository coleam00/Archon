import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
  forgeReleaseAsset,
  PLUGIN_MANIFEST_FILE,
  pluginManifestSchema,
  pluginReceiptSchema,
} from './index';

const manifest = {
  schemaVersion: 1,
  kind: 'forge',
  name: 'forge-example',
  description: 'Example forge',
  executable: 'archon-forge-example',
};

describe('plugin manifest', () => {
  test('the GitHub forge plugin manifest in this repository is valid', async () => {
    const path = join(import.meta.dir, '../../../plugins/forge-github', PLUGIN_MANIFEST_FILE);
    const parsed = pluginManifestSchema.parse(await Bun.file(path).json());
    // release.yml names the release asset after this field.
    expect(parsed.executable).toBe('archon-forge-github');
  });

  test('rejects kinds without an install path, unknown keys and executable names outside discovery', () => {
    expect(pluginManifestSchema.safeParse(manifest).success).toBe(true);
    for (const invalid of [
      { ...manifest, kind: 'workflow-pack' },
      { ...manifest, install: 'curl | sh' },
      { ...manifest, executable: '../archon-forge-example' },
      { ...manifest, executable: 'archon-forge-example.exe' },
      { ...manifest, compatibility: { archon: '>=1.0.0', node: '>=20' } },
    ]) {
      expect(pluginManifestSchema.safeParse(invalid).success).toBe(false);
    }
  });
});

describe('compatibility.archon', () => {
  const withRange = (archon: string): boolean =>
    pluginManifestSchema.safeParse({ ...manifest, compatibility: { archon } }).success;

  test('accepts comparator ranges on full versions', () => {
    for (const range of [
      '>=0.11.0',
      '0.11.0',
      '^1.2.0 <2.0.0',
      '>=1.0.0 || ~2.1.0',
      '>=1.0.0-rc.1',
    ]) {
      expect(withRange(range)).toBe(true);
    }
  });

  // Bun.semver.satisfies returns true for every one of these, which would
  // silently disable the install-time compatibility check.
  test('refuses ranges Bun.semver cannot evaluate', () => {
    for (const range of ['', 'xyz', '>=', 'not-a-range']) {
      expect(withRange(range)).toBe(false);
    }
  });
});

describe('forge release asset', () => {
  test('names each asset from the executable and the Bun compile target', () => {
    expect(forgeReleaseAsset('archon-forge-github', 'bun-linux-x64')).toBe(
      'archon-forge-github-linux-x64'
    );
    expect(forgeReleaseAsset('archon-forge-github', 'bun-windows-x64')).toBe(
      'archon-forge-github-windows-x64.exe'
    );
    expect(() => forgeReleaseAsset('archon-forge-github', 'bun-freebsd-x64')).toThrow();
  });
});

describe('plugin receipt', () => {
  const receipt = {
    schemaVersion: 1,
    id: 'owner/repo/plugins/example',
    manifest,
    tag: 'v1.0.0',
    commit: 'a'.repeat(40),
    installedAt: new Date(0).toISOString(),
    files: [{ path: 'archon-forge-example', sha256: 'b'.repeat(64) }],
  };

  test('accepts a well-formed receipt', () => {
    expect(pluginReceiptSchema.safeParse(receipt).success).toBe(true);
  });

  test('refuses file entries that name anything outside the plugins directory', () => {
    for (const path of ['..', '.', '../archon-forge-example', 'nested/archon-forge-example']) {
      const parsed = pluginReceiptSchema.safeParse({
        ...receipt,
        files: [{ path, sha256: 'b'.repeat(64) }],
      });
      expect(parsed.success).toBe(false);
    }
  });
});
