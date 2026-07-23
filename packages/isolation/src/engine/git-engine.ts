/**
 * Git Worktree Engine (default)
 *
 * The historical raw-`git worktree` plumbing moved behind the `WorktreeEngine`
 * interface. Zero behavior change: every method issues exactly the argv the
 * pre-engine `WorktreeProvider` issued inline, through the same `@archon/git`
 * bindings (`execFileAsync`, `listWorktrees`) the provider tests spy on.
 */

import { execFileAsync, listWorktrees } from '@archon/git';
import type { RepoPath, WorktreeInfo } from '@archon/git';
import type { AddWorktreeOptions, RemoveWorktreeOptions, WorktreeEngine } from './types';

/**
 * Ceiling for a single git subprocess in worktree operations. Generous enough
 * for repos with heavy post-checkout hooks while still catching genuine hangs
 * (e.g. credential prompts in non-TTY, stalled network fetches). See #1119, #1029.
 */
const GIT_OPERATION_TIMEOUT_MS = 5 * 60 * 1000;

const PRUNE_TIMEOUT_MS = 15000;

export class GitWorktreeEngine implements WorktreeEngine {
  readonly id = 'git' as const;

  async add(options: AddWorktreeOptions): Promise<void> {
    const { repoPath, worktreePath, branch, startPoint, track } = options;
    let args: string[];
    if (startPoint === undefined) {
      // Check out an already-existing local branch.
      args = ['-C', repoPath, 'worktree', 'add', worktreePath, branch];
    } else if (track) {
      // New branch tracking its start point (same-repo PR checkout).
      args = ['-C', repoPath, 'worktree', 'add', worktreePath, '-b', branch, startPoint];
    } else {
      // `--no-track` keeps `branch.<name>.merge` unset; otherwise `gh pr view`
      // (no PR number) resolves to the base branch's PR via upstream config.
      args = [
        '-C',
        repoPath,
        'worktree',
        'add',
        '--no-track',
        worktreePath,
        '-b',
        branch,
        startPoint,
      ];
    }
    await execFileAsync('git', args, { timeout: GIT_OPERATION_TIMEOUT_MS });
  }

  async remove(options: RemoveWorktreeOptions): Promise<void> {
    const { repoPath, worktreePath, force } = options;
    const args = ['-C', repoPath, 'worktree', 'remove'];
    if (force) {
      args.push('--force');
    }
    args.push(worktreePath);
    await execFileAsync('git', args, { timeout: GIT_OPERATION_TIMEOUT_MS });
  }

  async list(repoPath: RepoPath): Promise<WorktreeInfo[]> {
    return listWorktrees(repoPath);
  }

  async prune(repoPath: RepoPath): Promise<void> {
    await execFileAsync('git', ['-C', repoPath, 'worktree', 'prune'], {
      timeout: PRUNE_TIMEOUT_MS,
    });
  }
}
