// @archon-test-isolated
import { expect, mock, test } from 'bun:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as paths from '@archon/paths';
import { trackTempRoots } from '@archon/paths/test-utils';
import { MAINTAINED_PROVIDER_IDS, providerCapabilitiesSchema } from '@archon/provider-contract';
import { maintainedProviderPluginId } from './index';

mock.module('@archon/paths', () => ({ ...paths, BUNDLED_IS_BINARY: true }));
const { receiptPath, scanReceipts } = await import('./store');
const tempRoot = trackTempRoots();

test.each([...MAINTAINED_PROVIDER_IDS])(
  'release receipt notice repairs %s with provider add',
  async provider => {
    const pluginsDir = tempRoot(await mkdtemp(join(tmpdir(), 'binary-receipt-')));
    const id = maintainedProviderPluginId(provider);
    const executable = `archon-provider-${provider}`;
    const file = receiptPath(pluginsDir, id);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(
      file,
      JSON.stringify({
        schemaVersion: 1,
        id,
        manifest: {
          schemaVersion: 1,
          kind: 'provider',
          name: `provider-${provider}`,
          description: provider,
          executable,
        },
        tag: 'v0.13.0',
        commit: 'a'.repeat(40),
        installedAt: new Date(0).toISOString(),
        files: [
          {
            path: executable + (process.platform === 'win32' ? '.exe' : ''),
            sha256: 'b'.repeat(64),
          },
        ],
        descriptor: {
          protocol: 2,
          id: provider,
          displayName: provider,
          version: '0.13.0',
          credentials: { kind: 'static', specs: [] },
          configSchema: {},
          capabilities: {
            ...Object.fromEntries(
              Object.keys(providerCapabilitiesSchema.shape).map(key => [key, false])
            ),
            backgroundWork: 'none',
            sessionFork: undefined,
            knownToolNames: undefined,
            renamedTools: undefined,
          },
        },
      })
    );
    const scan = await scanReceipts(pluginsDir);
    expect(scan.receipts).toEqual([]);
    expect(scan.broken).toHaveLength(1);
    expect(scan.broken[0].unavailableReason).toBe('provider-protocol');
    const notice = scan.broken[0].message;
    expect(notice).toContain(`Plugin unavailable: ${id}`);
    expect(notice).toContain('uses protocol 2, but this Archon requires protocol 3');
    expect(notice).toContain(`Run: archon provider add ${provider}`);
    expect(notice).not.toContain('archon plugin remove');
    expect(notice).toContain('Validated older receipts allow direct replacement');
    expect(notice).toContain('ambiguous file ownership');
    expect(notice).not.toContain('move it aside before retrying');

    const receipt = JSON.parse(await Bun.file(file).text());
    for (const value of [
      { ...receipt, descriptor: { ...receipt.descriptor, protocol: 4 } },
      { ...receipt, files: [{ ...receipt.files[0], path: 'another-file' }] },
      { ...receipt, manifest: { ...receipt.manifest, executable: 'archon-provider-other' } },
    ]) {
      await writeFile(file, JSON.stringify(value));
      const conservative = (await scanReceipts(pluginsDir)).broken[0].message;
      expect(conservative).toContain('move it aside before retrying');
      expect(conservative).not.toContain('allow direct replacement');
    }
  }
);
