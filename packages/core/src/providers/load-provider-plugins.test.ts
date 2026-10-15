// @archon-test-isolated
import * as paths from '@archon/paths';
import { clearRegistry, providerRegistry } from '@archon/providers';
import { requireProvider } from '@archon/provider-contract';
import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
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

test('unusable receipts warn without blocking a healthy provider', async () => {
  const dir = tempRoot(await mkdtemp(join(tmpdir(), 'provider-receipts-invalid-')));
  const file = receiptPath(dir, 'owner/broken');
  const healthy = receiptPath(dir, id);
  await mkdir(dirname(file), { recursive: true });
  await mkdir(dirname(healthy), { recursive: true });
  await writeFile(healthy, JSON.stringify(receipt));
  const logger = paths.createLogger('test');
  const warning = spyOn(logger, 'warn').mockImplementation(() => undefined);
  const loggerFactory = spyOn(paths, 'createLogger').mockReturnValue(logger);
  try {
    for (const [value, reason] of [
      [{ ...receipt, descriptor: { ...descriptor, id: 'other' } }, 'descriptor id does not match'],
      [
        { ...receipt, files: [{ path: 'unowned', sha256: 'b'.repeat(64) }] },
        'receipt does not own its executable',
      ],
      [
        { ...receipt, descriptor: { ...descriptor, id: 'claude' } },
        'maintained provider receipt is not first-party',
      ],
      [
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
        'no credential delivery rule for unknown',
      ],
      [
        {
          ...receipt,
          descriptor: {
            ...descriptor,
            config: {
              ...descriptor.config,
              run: {
                type: 'object',
                $defs: { model: ['SECRET_TOKEN_AND_MESSAGE'] },
                allOf: [{ $ref: '#/$defs/model' }],
              },
            },
          },
        },
        'provider descriptor failed schema validation',
      ],
    ] as const) {
      const contents = JSON.stringify({
        ...value,
        id: 'owner/broken',
        tag: 'SECRET_TOKEN_AND_MESSAGE',
      });
      await writeFile(file, contents);
      warning.mockClear();
      expect(await readReceipts(dir)).toHaveLength(2);
      expect((await loadProviderPlugins(dir)).map(provider => provider.id)).toEqual([
        descriptor.id,
      ]);
      expect(warning.mock.calls).toContainEqual([
        { receipt: file, reason: expect.stringContaining(reason) },
        'Plugin unavailable. Run archon plugin update owner/broken or archon plugin remove owner/broken',
      ]);
      expect(JSON.stringify(warning.mock.calls)).not.toContain('SECRET_TOKEN_AND_MESSAGE');
      expect(await readFile(file, 'utf8')).toBe(contents);
    }
  } finally {
    loggerFactory.mockRestore();
    warning.mockRestore();
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
    "Provider 'claude' is installed at 0.12.0 but this CLI is 0.13.0. Run: archon provider add claude"
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

test('incompatible receipts are reported and retained while valid providers still load', async () => {
  const dir = tempRoot(await mkdtemp(join(tmpdir(), 'provider-protocol-recovery-')));
  const stale = receiptPath(dir, 'owner/stale');
  const good = receiptPath(dir, id);
  await mkdir(dirname(stale), { recursive: true });
  await mkdir(dirname(good), { recursive: true });
  const contents = JSON.stringify({
    ...receipt,
    id: 'owner/stale',
    descriptor: { ...descriptor, protocol: 1 },
  });
  await writeFile(stale, contents);
  await writeFile(good, JSON.stringify(receipt));
  const logger = paths.createLogger('test');
  const warning = spyOn(logger, 'warn').mockImplementation(() => undefined);
  const loggerFactory = spyOn(paths, 'createLogger').mockReturnValue(logger);
  try {
    expect((await loadProviderPlugins(dir)).map(registration => registration.id)).toEqual([
      descriptor.id,
    ]);
    expect(warning.mock.calls.flat().join(' ')).toContain('archon plugin update owner/stale');
    expect(warning.mock.calls.flat().join(' ')).toContain('archon plugin remove owner/stale');
    expect(warning.mock.calls[0][0]).toMatchObject({ receipt: stale });
    expect(await readFile(stale, 'utf8')).toBe(contents);
    await expect(readReceipts(dir)).rejects.toThrow(stale);
  } finally {
    loggerFactory.mockRestore();
    warning.mockRestore();
  }
});
