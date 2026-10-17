import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import type { PluginReceipt } from './index';
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
