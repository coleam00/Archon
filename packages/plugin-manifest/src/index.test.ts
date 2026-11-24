import { PROVIDER_PLUGIN_PROTOCOL } from '@archon/provider-contract/plugin/wire';
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { providerCapabilitiesSchema } from '@archon/provider-contract';
import { providerPluginDescriptorSchema } from '@archon/provider-contract/plugin/wire';
import {
  maintainedProviderPluginId,
  isMaintainedProviderPlugin,
  forgeManifestSchema,
  type ChatManifest,
  type ChatReceipt,
  pluginReleaseAsset,
  PLUGIN_MANIFEST_FILE,
  pluginManifestSchema,
  pluginReceiptSchema,
  describeIssues,
  unknownManifestKeys,
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
    const parsed = forgeManifestSchema.parse(await Bun.file(path).json());
    // release.yml names the release asset after this field.
    expect(parsed.executable).toBe('archon-forge-github');
  });

  test('rejects kinds without an install path and executable names outside discovery', () => {
    expect(pluginManifestSchema.safeParse(manifest).success).toBe(true);
    for (const invalid of [
      { ...manifest, kind: 'provider' },
      { ...manifest, kind: 'workflow-pack' },
      { ...manifest, executable: '../archon-forge-example' },
      { ...manifest, executable: 'archon-forge-example.exe' },
    ]) {
      expect(pluginManifestSchema.safeParse(invalid).success).toBe(false);
    }
  });
});

// A newer Archon may add a manifest field; an older binary reading that
// manifest must still install and load it.
describe('keys this Archon does not know', () => {
  const pack = {
    schemaVersion: 1,
    kind: 'workflow-pack',
    name: 'review-kit',
    description: 'Review workflows',
    entrypoints: { review: 'review/review.yaml' },
  };

  test('are ignored on read, top-level and nested', () => {
    for (const known of [manifest, pack]) {
      const parsed = pluginManifestSchema.parse({
        ...known,
        skills: ['review'],
        compatibility: { archon: '>=0.1.0', min: '0.1.0' },
      });
      expect(parsed).toEqual({ ...known, compatibility: { archon: '>=0.1.0' } } as never);
    }
  });

  test('do not loosen known keys or an unknown schemaVersion', () => {
    const failure = (value: object): string => {
      const result = pluginManifestSchema.safeParse({ ...value, skills: [] });
      return result.success ? 'parsed' : describeIssues(result.error);
    };
    expect(failure({ ...pack, description: 5 })).toBe(
      'description: Invalid input: expected string, received number'
    );
    expect(failure({ ...pack, compatibility: { archon: 5 } })).toBe(
      'compatibility.archon: Invalid input: expected string, received number'
    );
    expect(failure({ ...pack, entrypoints: { review: '../x/y.yaml' } })).toBe(
      'entrypoints.review: must be <workflow folder>/<file>.yaml; entrypoints.review: must stay inside its workflow folder'
    );
    expect(failure({ ...pack, schemaVersion: 2 })).toBe('schemaVersion: Invalid input: expected 1');
  });

  test('are listed by unknownManifestKeys as dotted paths', () => {
    expect(
      unknownManifestKeys({
        ...pack,
        skills: [],
        compatibility: { archon: '>=0.1.0', min: 1 },
        entrypoints: { review: 'review/review.yaml', extra: 'extra/extra.yaml' },
      })
    ).toEqual(['skills', 'compatibility.min']);
    expect(unknownManifestKeys(pack)).toEqual([]);
    expect(unknownManifestKeys({ ...manifest, install: 'x' })).toEqual(['install']);
    expect(unknownManifestKeys({ ...pack, kind: 'theme', extra: 1 })).toEqual([]);
    expect(unknownManifestKeys(null)).toEqual([]);
  });
});

describe('workflow-pack manifest', () => {
  const pack = {
    schemaVersion: 1,
    kind: 'workflow-pack',
    name: 'review-kit',
    description: 'Review workflows',
    entrypoints: { review: 'review/review.yaml', triage: 'triage/triage.yml' },
  };

  test('accepts entrypoints that each name one workflow folder YAML', () => {
    expect(pluginManifestSchema.safeParse(pack).success).toBe(true);
  });

  test('refuses entrypoints discovery could not load as one packaged workflow', () => {
    for (const entrypoints of [
      {},
      { review: 'review.yaml' },
      { review: 'review/nested/review.yaml' },
      { review: '../review/review.yaml' },
      { review: 'review/../x.yaml' },
      { review: '.shared/review.yaml' },
      { review: 'review/review.md' },
      { Review: 'review/review.yaml' },
      { 'owner/x': 'review/review.yaml' },
      { review: 'review/review.yaml', again: 'review/review.yaml' },
    ]) {
      expect(pluginManifestSchema.safeParse({ ...pack, entrypoints }).success).toBe(false);
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
    expect(pluginReleaseAsset('archon-forge-github', 'bun-linux-x64')).toBe(
      'archon-forge-github-linux-x64'
    );
    expect(pluginReleaseAsset('archon-forge-github', 'bun-windows-x64')).toBe(
      'archon-forge-github-windows-x64.exe'
    );
    expect(() => pluginReleaseAsset('archon-forge-github', 'bun-freebsd-x64')).toThrow();
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

  test('a workflow-pack receipt needs no tag or file list, and a forge receipt still needs both', () => {
    const packReceipt = {
      schemaVersion: 1,
      id: 'owner/repo',
      manifest: {
        schemaVersion: 1,
        kind: 'workflow-pack',
        name: 'review-kit',
        description: 'Review workflows',
        entrypoints: { review: 'review/review.yaml' },
      },
      commit: 'a'.repeat(40),
      installedAt: new Date(0).toISOString(),
    };
    expect(pluginReceiptSchema.safeParse(packReceipt).success).toBe(true);
    const { tag: _tag, ...untagged } = receipt;
    const { files: _files, ...listless } = receipt;
    expect(pluginReceiptSchema.safeParse(untagged).success).toBe(false);
    expect(pluginReceiptSchema.safeParse(listless).success).toBe(false);
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

const providerManifest = {
  ...manifest,
  schemaVersion: 1 as const,
  kind: 'provider' as const,
  executable: 'archon-provider-example',
};
test('provider receipts validate the owned descriptor contract', () => {
  expect(pluginManifestSchema.parse(providerManifest)).toEqual(providerManifest);
  for (const executable of [
    'archon-forge-example',
    '../archon-provider-example',
    'archon-provider-example.exe',
  ]) {
    expect(pluginManifestSchema.safeParse({ ...providerManifest, executable }).success).toBe(false);
  }
  const receipt = {
    schemaVersion: 1 as const,
    id: 'owner/provider',
    manifest: providerManifest,
    tag: 'v1',
    commit: 'a'.repeat(40),
    installedAt: new Date(0).toISOString(),
    files: [{ path: 'archon-provider-example', sha256: 'b'.repeat(64) }],
    descriptor: providerPluginDescriptorSchema.parse({
      protocol: PROVIDER_PLUGIN_PROTOCOL,
      id: 'example',
      displayName: 'Example',
      version: '1',
      credentials: { kind: 'static', specs: [] },
      configSchema: { type: 'object' },
      capabilities: {
        ...Object.fromEntries(
          Object.keys(providerCapabilitiesSchema.shape).map(key => [key, false])
        ),
        backgroundWork: 'none',
        sessionFork: undefined,
        structuredOutputCorrection: undefined,
        knownToolNames: undefined,
        renamedTools: undefined,
      },
    }),
  };
  expect(pluginReceiptSchema.parse(JSON.parse(JSON.stringify(receipt)))).toEqual(receipt);
  expect(
    pluginReceiptSchema.safeParse({
      ...receipt,
      descriptor: {
        ...receipt.descriptor,
        capabilities: { ...receipt.descriptor.capabilities, nativeTools: true },
      },
    }).success
  ).toBe(true);
  for (const descriptor of [
    { id: 'example' },
    { ...receipt.descriptor, protocol: 1 },
    { ...receipt.descriptor, credentials: { kind: 'dynamic' } },
  ]) {
    expect(pluginReceiptSchema.safeParse({ ...receipt, descriptor }).success).toBe(false);
  }
});

describe('chat manifests and receipts', () => {
  const chat: ChatManifest = {
    schemaVersion: 1,
    kind: 'chat',
    name: 'example-chat',
    description: 'Example chat',
    executable: 'archon-chat-example',
  };
  const descriptor: ChatReceipt['descriptor'] = {
    protocol: 'archon-chat/1',
    id: 'slack',
    displayName: 'Example',
    version: '1',
    capabilities: { defaultWorkflowDispatch: 'background', resultFooter: true, runEvents: true },
    policy: { workspaceRetention: 'retain', streaming: { defaultMode: 'batch', envVar: 'STREAM' } },
    allowlist: { envVar: 'ALLOWED' },
    workflowCommand: { prefix: '/workflow ' },
  };
  const receipt: ChatReceipt = {
    schemaVersion: 1,
    id: 'owner/repo',
    manifest: chat,
    descriptor,
    tag: 'v1',
    commit: 'a'.repeat(40),
    installedAt: '2026-10-07T00:00:00.000Z',
    files: [{ path: 'archon-chat-example.exe', sha256: 'a'.repeat(64) }],
  };

  test('accepts chat executables and rejects wrong prefixes, traversal and manifest exe suffixes', () => {
    expect(pluginManifestSchema.parse(chat)).toEqual(chat);
    for (const executable of [
      'archon-forge-example',
      '../archon-chat-example',
      'archon-chat-example.exe',
      'archon-chat-Example',
    ]) {
      expect(pluginManifestSchema.safeParse({ ...chat, executable }).success).toBe(false);
    }
  });

  test('receipts round-trip and narrow as chat and binary receipts', async () => {
    const { isChatReceipt, isBinaryReceipt, isProviderReceipt } = await import('./index');
    const parsed = pluginReceiptSchema.parse(JSON.parse(JSON.stringify(receipt)));
    expect(parsed).toEqual(receipt);
    expect(isChatReceipt(parsed)).toBe(true);
    expect(isBinaryReceipt(parsed)).toBe(true);
    expect(isProviderReceipt(parsed)).toBe(false);
  });

  test('rejects missing or invalid owned descriptors', () => {
    for (const invalid of [
      undefined,
      {},
      { ...descriptor, id: '../slack' },
      { ...descriptor, protocol: 'archon-chat/2' },
      { ...descriptor, policy: { workspaceRetention: 'delete' } },
    ]) {
      expect(pluginReceiptSchema.safeParse({ ...receipt, descriptor: invalid }).success).toBe(
        false
      );
    }
  });
});

test.each(['claude', 'codex', 'pi'] as const)(
  'maintained %s install refs and receipt identity share one resolver',
  id => {
    const pluginId = maintainedProviderPluginId(id);
    expect(pluginId).toBe(`coleam00/Archon/plugins/provider-${id}`);
    expect(isMaintainedProviderPlugin(pluginId.toUpperCase(), id)).toBe(true);
    expect(isMaintainedProviderPlugin(`other/Archon/plugins/provider-${id}`, id)).toBe(false);
    expect(isMaintainedProviderPlugin(`${pluginId}/extra`, id)).toBe(false);
  }
);
