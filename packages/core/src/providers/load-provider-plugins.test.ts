// @archon-test-isolated
import * as paths from '@archon/paths';
import { clearRegistry, providerRegistry } from '@archon/providers';
import { requireProvider } from '@archon/provider-contract';
import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { readReceipts, receiptPath } from '@archon/plugin-manifest/store';
import { parseProviderRunModel } from '@archon/provider-contract';
import { descriptor } from './fixtures/process-provider-data';
import { loadProviderPlugins } from './load-provider-plugins';

const tempRoot = trackTempRoots();
const id = 'owner/process-fixture';
const receipt = {
  schemaVersion: 1,
  id,
  manifest: {
    schemaVersion: 1,
    kind: 'provider',
    name: 'process-fixture',
    description: 'test',
    executable: 'archon-provider-process-fixture',
  },
  tag: 'v1',
  commit: 'a'.repeat(40),
  installedAt: new Date(0).toISOString(),
  files: [{ path: 'archon-provider-process-fixture', sha256: 'b'.repeat(64) }],
  descriptor,
};

test('receipt loading builds registrations without spawning and leaves an empty install unchanged', async () => {
  const dir = tempRoot(await mkdtemp(join(tmpdir(), 'provider-receipts-')));
  expect(await loadProviderPlugins(dir)).toEqual([]);
  const file = receiptPath(dir, id);
  await mkdir(dirname(file), { recursive: true });
  const supported = {
    ...descriptor,
    capabilities: { ...descriptor.capabilities, nativeTools: true },
  };
  await writeFile(file, JSON.stringify({ ...receipt, descriptor: supported }));
  const [registration] = await loadProviderPlugins(dir);
  expect(registration.id).toBe(descriptor.id);
  expect(registration.capabilities).toEqual(supported.capabilities);
  expect(parseProviderRunModel(registration, 'test-model')).toBe('test-model');
  expect(() => registration.parseConfig({ model: 42 }, 'run')).toThrow();
});

test('invalid descriptors, executable identities and delivery rules name the receipt and repair commands', async () => {
  const dir = tempRoot(await mkdtemp(join(tmpdir(), 'provider-receipts-invalid-')));
  const file = receiptPath(dir, id);
  await mkdir(dirname(file), { recursive: true });
  for (const value of [
    { ...receipt, descriptor: { id: descriptor.id } },
    { ...receipt, descriptor: { ...descriptor, protocol: 2 } },
    { ...receipt, descriptor: { ...descriptor, id: 'other' } },
    { ...receipt, files: [{ path: 'unowned', sha256: 'b'.repeat(64) }] },
    {
      ...receipt,
      descriptor: {
        ...descriptor,
        credentials: {
          kind: 'static',
          specs: [{ vendor: 'unknown', displayName: 'Unknown', kinds: ['api_key'] }],
        },
      },
    },
  ]) {
    await writeFile(file, JSON.stringify(value));
    await expect(loadProviderPlugins(dir)).rejects.toThrow(file);
    await expect(loadProviderPlugins(dir)).rejects.toThrow('archon plugin update');
    await expect(loadProviderPlugins(dir)).rejects.toThrow('archon plugin remove');
    if (!('protocol' in value.descriptor) || value.descriptor.protocol !== 1) {
      await expect(readReceipts(dir)).rejects.toThrow(`Invalid plugin receipt ${file}`);
    }
  }
});

afterEach(() => clearRegistry());

test('stale first-party providers are unavailable with the versioned install command', async () => {
  const dir = tempRoot(await mkdtemp(join(tmpdir(), 'provider-stale-')));
  const firstPartyId = 'coleam00/Archon/plugins/provider-claude';
  const file = receiptPath(dir, firstPartyId);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(
    file,
    JSON.stringify({
      ...receipt,
      id: firstPartyId,
      manifest: { ...receipt.manifest, executable: 'archon-provider-claude' },
      files: [{ path: 'archon-provider-claude', sha256: 'b'.repeat(64) }],
      descriptor: { ...descriptor, id: 'claude', version: '0.12.0' },
    })
  );
  expect(await loadProviderPlugins(dir, { version: '0.13.0' })).toEqual([]);
  expect(() => requireProvider(providerRegistry, 'claude')).toThrow(
    "Provider 'claude' is installed at 0.12.0 but this CLI is 0.13.0. Run: archon provider install claude"
  );
});

test('source registration skips maintained receipts and warns with the receipt path', async () => {
  const dir = tempRoot(await mkdtemp(join(tmpdir(), 'provider-source-')));
  const file = receiptPath(dir, id);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(
    file,
    JSON.stringify({
      ...receipt,
      manifest: { ...receipt.manifest, executable: 'archon-provider-claude' },
      descriptor: { ...descriptor, id: 'claude' },
    })
  );
  const logger = paths.createLogger('test');
  const warning = spyOn(logger, 'warn').mockImplementation(() => undefined);
  const loggerFactory = spyOn(paths, 'createLogger').mockReturnValue(logger);
  try {
    expect(await loadProviderPlugins(dir, { maintained: 'source' })).toEqual([]);
    expect(warning).toHaveBeenCalledWith({ receipt: file }, 'provider.receipt_skipped_source');
  } finally {
    loggerFactory.mockRestore();
    warning.mockRestore();
  }
});
