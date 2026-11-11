// @archon-test-isolated
import { afterEach, expect, it } from 'bun:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';
import { liveSourceRoots } from '../workflow-source';
import { formatPackagedResourceReference } from '../packaged-workflow';
import { resolveCommandContentForScan, resolveCommandSourceForScan } from './command-scan';

let root: string | undefined;
afterEach(async () => {
  if (root) await removeTempTree(root);
});

it('retains physical source and precedence for flat, custom, packaged and global commands', async () => {
  root = await mkdtemp(join(tmpdir(), 'command-source-'));
  const roots = { ...liveSourceRoots(root), globalCommands: join(root, 'global') };
  const put = async (path: string, content: string) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  };
  await put(join(root, '.archon/commands/check.md'), 'project');
  await put(join(roots.globalCommands, 'check.md'), 'global shadowed');
  await put(join(root, 'custom/extra.md'), 'custom');
  await put(join(roots.globalCommands, 'fallback.md'), 'global');
  await put(join(root, '.archon/workflows/pack/entry/commands/check.md'), 'pack');
  const packaged = formatPackagedResourceReference(
    { source: 'project', pack: 'pack', workflow: 'entry' },
    'check'
  );
  for (const [name, path, content, source] of [
    ['check', '.archon/commands/check.md', 'project', 'project'],
    ['extra', 'custom/extra.md', 'custom', 'project'],
    ['fallback', 'global/fallback.md', 'global', 'global'],
    [packaged, '.archon/workflows/pack/entry/commands/check.md', 'pack', 'project'],
  ] as const) {
    const config = { commandFolder: 'custom' };
    expect(await resolveCommandSourceForScan(roots, name, config)).toEqual({
      content,
      file: { path: join(root, path), source },
    });
    expect(await resolveCommandContentForScan(roots, name, config)).toBe(content);
  }
  expect(await resolveCommandSourceForScan(roots, 'missing', {})).toEqual({ content: null });
});
