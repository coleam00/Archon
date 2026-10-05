/**
 * Remove the scratch worktrees reviewers created under this run.
 *
 * Read-only reviewers try mutations in scratch worktrees under
 * `$ARTIFACTS_DIR/scratch/<lens>/`. Cleanup is a workflow step, not a prompt
 * instruction, so a lens that died still has its tree removed. It touches only
 * registered worktrees whose real path is under the given scratch directory: never
 * the run's own checkout, another run's worktree, or a user's. It never runs a bare
 * `git worktree prune`, which would also drop unrelated missing registrations.
 */

import { existsSync, realpathSync, rmSync } from 'node:fs';
import { join, sep } from 'node:path';

/** Remove every registered worktree under `scratch`, then the directory itself. */
export function pruneScratch(scratch: string): string[] {
  if (!existsSync(scratch)) return [];
  const root = realpathSync(scratch);
  const listed = Bun.spawnSync(['git', 'worktree', 'list', '--porcelain'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (listed.exitCode !== 0) {
    throw new Error(`git worktree list failed: ${listed.stderr.toString().trim()}`);
  }
  const removed: string[] = [];
  for (const line of listed.stdout.toString().split('\n')) {
    if (!line.startsWith('worktree ')) continue;
    const path = line.slice('worktree '.length);
    let real: string;
    try {
      real = realpathSync(path);
    } catch {
      real = path;
    }
    if (real !== root && !real.startsWith(root + sep)) continue;
    const result = Bun.spawnSync(['git', 'worktree', 'remove', '--force', path], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (result.exitCode !== 0) {
      throw new Error(`git worktree remove ${path} failed: ${result.stderr.toString().trim()}`);
    }
    removed.push(path);
  }
  rmSync(root, { recursive: true, force: true });
  return removed;
}

/** `$ARTIFACTS_DIR/scratch`, or one lens's directory under it. */
export function scratchDir(artifacts: string, lens: string): string {
  return lens === '' ? join(artifacts, 'scratch') : join(artifacts, 'scratch', lens);
}
