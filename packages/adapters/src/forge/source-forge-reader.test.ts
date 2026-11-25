import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';
import { hostSourceForgeReader } from './source-forge-reader';

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.map(removeTempTree));
});

test('a forge plugin older than the opened-issue read names the operation and how to update it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'source-forge-reader-'));
  roots.push(root);
  const plugin = join(import.meta.dir, '../../../forge/src/fixtures/test-plugin.ts');
  writeFileSync(
    join(root, 'config.yaml'),
    `forge:\n  scanPath: false\n  plugins:\n    - plugin: test\n      command: ${JSON.stringify(process.execPath)}\n      args: ["--no-env-file", ${JSON.stringify(plugin)}, "--mode", "token"]\n`
  );
  const reader = hostSourceForgeReader({ HOME: root, ARCHON_HOME: root, PATH: '' });
  const read = reader.issuesOpened({
    repo: { host: 'forge.example', path: 'owner/repo' },
    since: '2026-11-24T00:00:00Z',
  });
  await expect(read).rejects.toMatchObject({ kind: 'unsupported_op' });
  await expect(read).rejects.toThrow('does not support workitem.opened');
  await expect(read).rejects.toThrow('archon plugin update');
});
