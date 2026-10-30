/**
 * Remove the scratch worktrees reviewers created under this run.
 *
 * Read-only reviewers try mutations in scratch worktrees under
 * `$ARTIFACTS_DIR/.archon/scratch/<lens>/`. Cleanup is a workflow step, not a prompt
 * instruction, so a lens that died still has its tree removed, and its git
 * registration with it; the engine deletes the same directory's files once the run ends. It touches only
 * registered worktrees whose real path is under the given scratch directory: never
 * the run's own checkout, another run's worktree, or a user's. It never runs a bare
 * `git worktree prune`, which would also drop unrelated missing registrations.
 */

import { existsSync, realpathSync, rmSync } from 'node:fs';
import { join, sep } from 'node:path';

/** Remove every registered worktree under `scratch`, then the directory itself. */
export function pruneScratch(scratch: string): string[] {
  if (!existsSync(scratch)) return [];
  // The native resolver: on Windows it expands 8.3 short names (RUNNER~1), which git
  // never prints, so both sides of the comparison name a directory the same way.
  const root = realpathSync.native(scratch);
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
      real = realpathSync.native(path);
    } catch {
      real = path;
    }
    if (real !== root && !real.startsWith(root + sep)) continue;
    // core.longpaths: a scratch tree with dependencies installed holds paths past Windows'
    // 260-character limit, which plain git cannot delete (Filename too long).
    const result = Bun.spawnSync(['git', '-c', 'core.longpaths=true', 'worktree', 'remove', '--force', path], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (result.exitCode !== 0) {
      throw new Error(`git worktree remove ${path} failed: ${result.stderr.toString().trim()}`);
    }
    removed.push(path);
  }
  // The directory as named, never its resolved target: a symlink there loses only the link.
  rmSync(scratch, { recursive: true, force: true });
  return removed;
}

/** `$ARTIFACTS_DIR/.archon/scratch`, the engine's run scratch directory, or one lens's directory under it. */
export function scratchDir(artifacts: string, lens: string): string {
  const scratch = join(artifacts, '.archon', 'scratch');
  return lens === '' ? scratch : join(scratch, lens);
}
