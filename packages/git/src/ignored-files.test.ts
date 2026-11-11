import { afterEach, expect, it, spyOn } from 'bun:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';
import * as exec from './exec';
import { execFileAsync } from './exec';
import { findIgnoredFiles } from './ignored-files';
import { GitFailure } from './errors';

let root: string | undefined;
afterEach(async () => {
  if (root) await removeTempTree(root);
});

it('uses Git rules, negations and the index, preserving NUL-delimited paths', async () => {
  root = await mkdtemp(join(tmpdir(), 'ignored-files-'));
  await execFileAsync('git', ['init', root]);
  await writeFile(join(root, '.gitignore'), '*.yaml\n!visible.yaml\n');
  await writeFile(join(root, 'tracked.yaml'), 'tracked');
  await execFileAsync('git', ['-C', root, 'add', '-f', 'tracked.yaml']);
  const ignored = ['ignored.yaml', 'space name.yaml', 'line\nbreak.yaml'];
  expect(
    await findIgnoredFiles(root, [...ignored, 'visible.yaml', 'tracked.yaml', 'plain.txt'])
  ).toEqual(ignored);
  expect(await findIgnoredFiles(root, ['visible.yaml', 'plain.txt'])).toEqual([]);
  expect(await findIgnoredFiles('/does-not-exist', [])).toEqual([]);
});

it('silently skips a non-repository but preserves unexpected Git failures', async () => {
  root = await mkdtemp(join(tmpdir(), 'ignored-files-'));
  expect(await findIgnoredFiles(root, ['file'])).toEqual([]);
  await execFileAsync('git', ['init', root]);
  await writeFile(join(root, '.git', 'config'), '[invalid');
  await expect(findIgnoredFiles(root, ['file'])).rejects.toBeInstanceOf(GitFailure);
});

it('does not launch Git for an empty candidate list', async () => {
  const probe = spyOn(exec, 'execFileAsync');
  try {
    expect(await findIgnoredFiles('/unused', [])).toEqual([]);
    expect(probe).not.toHaveBeenCalled();
  } finally {
    probe.mockRestore();
  }
});
