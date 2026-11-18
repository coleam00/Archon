/**
 * Removal failures that need a chmod-based access denial, which Windows does not have and root
 * ignores. The other run-scratch tests are in run-scratch.test.ts, which runs in the Windows set.
 */
import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  getArchonWorkspacesPath,
  getRunArtifactsDirForRoot,
  getRunScratchDir,
} from '@archon/paths/archon-paths';
import { captureLogLines, trackTempRoots } from '@archon/paths/test-utils';
import { removeRunScratch } from './run-scratch';

const trackTempRoot = trackTempRoots();

function runStorage(): { id: string; root: string; artifactsDir: string } {
  const id = crypto.randomUUID();
  const root = trackTempRoot(join(getArchonWorkspacesPath(), '_cwd', `run-scratch-${id}`));
  return { id, root, artifactsDir: getRunArtifactsDirForRoot(root, id) };
}

const signature = 'Signature: 8a477f597d28d172789f06886806bc55';

async function tagged(path: string, content = signature): Promise<void> {
  await mkdir(path, { recursive: true });
  await writeFile(join(path, 'CACHEDIR.TAG'), content);
}

// The terminal status write is authoritative, so a scratch entry that cannot be deleted
// must not fail the executor exit, an operator's cancel or a container teardown.
test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
  'a removal that fails resolves instead of throwing',
  async () => {
    const { artifactsDir } = runStorage();
    const locked = join(getRunScratchDir(artifactsDir), 'locked');
    await mkdir(join(locked, 'checkout'), { recursive: true });
    await chmod(locked, 0o500);
    try {
      await removeRunScratch(artifactsDir, {});
      expect(existsSync(join(locked, 'checkout'))).toBe(true);
    } finally {
      await chmod(locked, 0o700);
    }
  }
);

test.skipIf(process.platform === 'win32' || process.getuid?.() === 0).each([0o500, 0o300])(
  'failed cache deletion (%i permissions) is logged, independent siblings and scratch still clean',
  async mode => {
    const { artifactsDir } = runStorage();
    const blocked = join(artifactsDir, 'blocked');
    await tagged(blocked);
    await mkdir(join(blocked, 'child'));
    await tagged(join(artifactsDir, 'independent'));
    await mkdir(getRunScratchDir(artifactsDir), { recursive: true });
    await chmod(blocked, mode);
    const capture = captureLogLines();
    try {
      await removeRunScratch(artifactsDir, { workflowRunId: 'blocked-run' });
      expect(existsSync(blocked)).toBe(true);
      if (mode === 0o300)
        expect(capture.lines.some(line => line.msg === 'run_scratch.cache_measure_failed')).toBe(
          true
        );
      expect(existsSync(join(artifactsDir, 'independent'))).toBe(false);
      expect(existsSync(getRunScratchDir(artifactsDir))).toBe(false);
      expect(
        capture.lines.some(
          line => line.msg === 'run_scratch.cache_remove_failed' && line.path === blocked
        )
      ).toBe(true);
      expect(
        capture.lines.some(
          line => line.msg === 'run_scratch.cache_removed' && line.path === 'blocked'
        )
      ).toBe(false);
    } finally {
      capture.restore();
      await chmod(blocked, 0o700);
    }
  }
);
