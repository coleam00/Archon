/**
 * How large a completed run's change is at the commit its result holds at (#6261), measured
 * once when the run completes. Recording it then keeps an item read free of git, survives a
 * deleted worktree, and keeps an old run's size from changing when its base branch moves.
 */
import { createLogger } from '@archon/paths';
import { getDefaultRemote, toRepoPath } from '@archon/git';
import type { ExecutionContext } from '@archon/provider-contract';
import { runGit } from './checkout-observation';
import type { ChangeSize, ResultCommit } from './schemas/terminal-record';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('workflow.change-size');
  return cachedLog;
}

/**
 * The change at the result commit against its merge-base with the run's base branch, the
 * same diff a pull request from that commit shows. The base branch is read where a worktree
 * is cut from: `<remote>/<base>` when the repository has a remote, else the local branch.
 * Returns undefined, never zeros, when the result holds at no commit, the run has no base
 * branch, or git cannot resolve the base. Never throws.
 */
export async function measureChangeSize(
  cwd: string,
  execContext: ExecutionContext,
  resultCommit: ResultCommit,
  baseBranch: string,
  configuredRemote: string | undefined,
  workflowRunId: string
): Promise<ChangeSize | undefined> {
  if (!resultCommit.held || baseBranch === '' || execContext.kind === 'container') return undefined;
  const unavailable = (step: string, code?: number): undefined => {
    getLog().info({ workflowRunId, step, code }, 'workflow.change_size_unavailable');
    return undefined;
  };

  let remote: string | null;
  try {
    remote = configuredRemote?.trim() || (await getDefaultRemote(toRepoPath(cwd)));
  } catch {
    return unavailable('remote');
  }
  const baseRef = remote ? `refs/remotes/${remote}/${baseBranch}` : `refs/heads/${baseBranch}`;

  const mergeBase = await runGit(cwd, ['merge-base', baseRef, resultCommit.commit]);
  if (mergeBase.code !== 0) return unavailable('merge_base', mergeBase.code);
  const base = mergeBase.stdout.toString('utf8').trim();

  const diff = await runGit(cwd, [
    'diff',
    '--numstat',
    '-z',
    '--no-renames',
    '--no-ext-diff',
    '--no-textconv',
    base,
    resultCommit.commit,
  ]);
  if (diff.code !== 0) return unavailable('diff', diff.code);
  return { base, ...sumNumstat(diff.stdout.toString('utf8')) };
}

/**
 * Sum `git diff --numstat -z --no-renames` output: one `<added>\t<removed>\t<path>` entry per
 * file, each ended by NUL. A binary file reports `-` for both counts.
 */
function sumNumstat(output: string): Omit<ChangeSize, 'base'> {
  let files = 0;
  let added = 0;
  let removed = 0;
  for (const entry of output.split('\0')) {
    if (entry === '') continue;
    const [add, remove] = entry.split('\t');
    files++;
    if (add !== '-') added += Number(add);
    if (remove !== '-') removed += Number(remove);
  }
  return { files, added, removed };
}
