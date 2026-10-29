import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { BUNDLED_IS_BINARY } from '@archon/paths';
import { trackTempRoots } from '@archon/paths/test-utils';
import { providerCapabilitiesSchema, MAINTAINED_PROVIDER_IDS } from '@archon/provider-contract';
import { PROVIDER_PLUGIN_PROTOCOL } from '@archon/provider-contract/plugin/wire';
import { maintainedProviderPluginId, pluginReceiptSchema, type PluginReceipt } from './index';
import { readReceipts, receiptPath, scanReceipts } from './store';

const tempRoot = trackTempRoots();

async function writeReceipt(pluginsDir: string, id: string, contents: string): Promise<string> {
  const file = receiptPath(pluginsDir, id);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, contents);
  return file;
}

describe('scanReceipts', () => {
  test('returns valid receipts beside the broken ones; readReceipts throws the first', async () => {
    const pluginsDir = tempRoot(await mkdtemp(join(tmpdir(), 'plugin-store-')));
    const valid: PluginReceipt = {
      schemaVersion: 1,
      id: 'acme/other',
      manifest: {
        schemaVersion: 1,
        kind: 'forge',
        name: 'forge-other',
        description: 'x',
        executable: 'archon-forge-other',
      },
      tag: 'v1.0.0',
      commit: 'a'.repeat(40),
      installedAt: new Date().toISOString(),
      files: [{ path: 'archon-forge-other', sha256: 'b'.repeat(64) }],
    };
    await writeReceipt(pluginsDir, 'acme/other', JSON.stringify(valid));
    const badJson = await writeReceipt(pluginsDir, 'acme/broken', '{not json');
    const badShape = await writeReceipt(pluginsDir, 'acme/invalid/plugins/x', '{"id":1}');

    const { receipts, broken } = await scanReceipts(pluginsDir);
    expect(receipts).toEqual([valid]);
    expect(broken).toEqual([
      { id: 'acme/broken', file: badJson, message: `Invalid JSON in plugin receipt ${badJson}` },
      {
        id: 'acme/invalid/plugins/x',
        file: badShape,
        message: expect.stringContaining(`Invalid plugin receipt ${badShape}: `),
      },
    ]);
    await expect(readReceipts(pluginsDir)).rejects.toThrow(
      `Invalid JSON in plugin receipt ${badJson}`
    );
  });
});

const providerReceipt = {
  schemaVersion: 1,
  id: 'acme/provider',
  manifest: {
    schemaVersion: 1,
    kind: 'provider',
    name: 'example',
    description: 'test',
    executable: 'archon-provider-example',
  },
  tag: 'v0.13.0',
  commit: 'a'.repeat(40),
  installedAt: new Date(0).toISOString(),
  files: [{ path: 'archon-provider-example', sha256: 'b'.repeat(64) }],
  descriptor: {
    protocol: 2,
    id: 'example',
    displayName: 'Example',
    version: '0.13.0',
    credentials: { kind: 'static', specs: [] },
    configSchema: {},
    capabilities: {
      ...Object.fromEntries(Object.keys(providerCapabilitiesSchema.shape).map(key => [key, false])),
      backgroundWork: 'none',
      sessionFork: undefined,
      knownToolNames: undefined,
      renamedTools: undefined,
    },
  },
};

test.each([
  ...MAINTAINED_PROVIDER_IDS.map(id => ({
    id: maintainedProviderPluginId(id),
    provider: id,
    command: `archon provider add ${id}`,
  })),
  { id: 'acme/provider', provider: 'example', command: 'archon plugin update acme/provider' },
  { id: 'acme/claude', provider: 'claude', command: 'archon plugin update acme/claude' },
])(
  'protocol mismatch for $id names both protocols and the appropriate command',
  async ({ id, provider, command }) => {
    const dir = tempRoot(await mkdtemp(join(tmpdir(), 'plugin-protocol-')));
    const receipt = {
      ...providerReceipt,
      id,
      manifest: { ...providerReceipt.manifest, executable: `archon-provider-${provider}` },
      files: [{ path: `archon-provider-${provider}`, sha256: 'b'.repeat(64) }],
      descriptor: { ...providerReceipt.descriptor, id: provider },
    };
    await writeReceipt(dir, id, JSON.stringify(receipt));
    expect(pluginReceiptSchema.safeParse(receipt).success).toBe(false);
    const { receipts, broken } = await scanReceipts(dir);
    expect(receipts).toEqual([]);
    expect(broken).toHaveLength(1);
    const sourceRemoval =
      MAINTAINED_PROVIDER_IDS.some(value => id === maintainedProviderPluginId(value)) &&
      !BUNDLED_IS_BINARY;
    const repair = sourceRemoval
      ? `Source checkouts run maintained providers from source. Remove this obsolete receipt: archon plugin remove ${id}`
      : `If ${join(dir, 'archon-provider-' + provider + (process.platform === 'win32' ? '.exe' : ''))} exists, move it aside before retrying. Run: ${command}`;
    expect(broken[0]).toMatchObject({
      unavailableReason: 'provider-protocol',
      message: `Plugin unavailable: ${id} (provider '${provider}') uses protocol 2, but this Archon requires protocol ${PROVIDER_PLUGIN_PROTOCOL}. ${repair}`,
    });
    await expect(readReceipts(dir)).rejects.toThrow(
      sourceRemoval ? `archon plugin remove ${id}` : command
    );
  }
);

test('only a well-formed receipt with a different numeric protocol is classified as unavailable', async () => {
  const dir = tempRoot(await mkdtemp(join(tmpdir(), 'plugin-malformed-')));
  for (const receipt of [
    { ...providerReceipt, files: [{ path: '../escape', sha256: 'b'.repeat(64) }] },
    { ...providerReceipt, descriptor: { ...providerReceipt.descriptor, protocol: '2' } },
    {
      ...providerReceipt,
      descriptor: {
        ...providerReceipt.descriptor,
        protocol: PROVIDER_PLUGIN_PROTOCOL,
        credentials: null,
      },
    },
    { ...providerReceipt, descriptor: { ...providerReceipt.descriptor, credentials: null } },
  ]) {
    await writeReceipt(dir, providerReceipt.id, JSON.stringify(receipt));
    const { receipts, broken } = await scanReceipts(dir);
    expect(receipts).toEqual([]);
    expect(broken[0].unavailableReason).toBeUndefined();
    expect(broken[0].message).toContain('Invalid plugin receipt');
  }
  await writeReceipt(
    dir,
    providerReceipt.id,
    JSON.stringify({
      ...providerReceipt,
      descriptor: { ...providerReceipt.descriptor, protocol: PROVIDER_PLUGIN_PROTOCOL },
    })
  );
  expect((await scanReceipts(dir)).broken).toEqual([]);
  expect(await readReceipts(dir)).toHaveLength(1);
});
