import { expect, test } from 'bun:test';
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
