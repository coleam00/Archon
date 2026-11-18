/**
 * A lock name that is a dangling symlink. Git-Bash on Windows cannot create one reliably, so
 * this case lives outside lock.integration.test.ts, which runs in the Windows set.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';
import { FileStoreLockHeldError, probeFileStoreFilesystem, withFileStoreLock } from './lock';

let root: string | undefined;
afterEach(async () => {
  if (root !== undefined) await removeTempTree(root);
  root = undefined;
});

test.skipIf(process.platform === 'win32')(
  'a lock name that never reads as an owner still times out',
  async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'archon-file-lock-')));
    await probeFileStoreFilesystem(root);
    // A dangling symlink exists for link (EEXIST) but reads as ENOENT every time.
    await symlink(join(root, 'missing'), join(root, 'lock'));
    const error = await withFileStoreLock(root, async () => {}, 50).then(
      () => undefined,
      (caught: unknown) => caught
    );
    expect(error).toBeInstanceOf(FileStoreLockHeldError);
    expect((error as FileStoreLockHeldError).owner).toBeNull();
  }
);
