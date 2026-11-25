/**
 * How large an item run's change is at the clean commit its checkout ended on (#6261),
 * measured once when the run completes. Recording it then keeps an item read free of git,
 * survives a deleted worktree, and keeps an old run's size from changing when a branch moves.
 */
import { createLogger } from '@archon/paths';
import { runGit } from './checkout-observation';
import { isAttentionDegraded } from './schemas/attention-degraded';
import type { ChangeSize } from './schemas/terminal-record';
import type { WorkflowRun } from './schemas/workflow-run';
import type { IWorkflowStore } from './store';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('workflow.change-size');
  return cachedLog;
}

type ItemRunsStore = Pick<IWorkflowStore, 'getItem' | 'getItemRuns'>;

/**
 * The change at `endCommit` against the commit the run's checkout was cut from. Only a run
 * of an item is measured: nothing else reads the size. Returns undefined, never zeros, when
 * the run has no item, its checkout ended on no clean commit, or no cut-from is recorded
 * for its checkout. Never throws.
 */
export async function measureChangeSize(
  store: ItemRunsStore,
  run: Pick<WorkflowRun, 'id' | 'item_id' | 'working_path' | 'checkout_baseline'>,
  cwd: string,
  endCommit: string | null
): Promise<ChangeSize | undefined> {
  if (run.item_id === null || endCommit === null) return undefined;
  try {
    const base = await cutFromOf(store, run, run.item_id);
    if (base === undefined) return unavailable(run.id, 'no_cut_from');
    const diff = await runGit(cwd, [
      'diff',
      '--numstat',
      '-z',
      '--find-renames',
      '--no-ext-diff',
      '--no-textconv',
      base,
      endCommit,
    ]);
    if (diff.code !== 0) return unavailable(run.id, 'diff', diff.code);
    return { base, commit: endCommit, ...sumNumstat(diff.stdout.toString('utf8')) };
  } catch (error) {
    getLog().warn({ err: error, workflowRunId: run.id }, 'workflow.change_size_failed');
    return undefined;
  }
}

function unavailable(workflowRunId: string, step: string, code?: number): undefined {
  getLog().info({ workflowRunId, step, code }, 'workflow.change_size_unavailable');
  return undefined;
}

/**
 * The commit the run's checkout was cut from. Only the run that created a worktree records
 * it, so a later run of the item on the same checkout takes it from the latest run of the
 * item at that path that did: the size of a reused checkout keeps one base across rounds.
 */
async function cutFromOf(
  store: ItemRunsStore,
  run: Pick<WorkflowRun, 'id' | 'working_path' | 'checkout_baseline'>,
  itemId: string
): Promise<string | undefined> {
  const own = cutFromCommit(run);
  if (own !== undefined || run.working_path === null) return own;
  const item = await store.getItem(itemId);
  if (item === null) return undefined;
  const read = await store.getItemRuns(item.projectKey, item.key);
  const runs = (read?.runs ?? []).filter(
    (other): other is WorkflowRun =>
      !isAttentionDegraded(other) && other.id !== run.id && other.working_path === run.working_path
  );
  for (const other of runs.reverse()) {
    const cutFrom = cutFromCommit(other);
    if (cutFrom !== undefined) return cutFrom;
  }
  return undefined;
}

function cutFromCommit(run: Pick<WorkflowRun, 'checkout_baseline'>): string | undefined {
  return run.checkout_baseline?.kind === 'git' ? run.checkout_baseline.cutFromCommit : undefined;
}

/**
 * Sum `git diff --numstat -z --find-renames` output. A file is `<added>\t<removed>\t<path>`
 * ended by NUL; a rename leaves the path empty and its old and new paths follow as two more
 * NUL-ended fields. A binary file reports `-` for both counts.
 */
function sumNumstat(output: string): Pick<ChangeSize, 'files' | 'added' | 'removed'> {
  const fields = output.split('\0');
  let files = 0;
  let added = 0;
  let removed = 0;
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index];
    if (field === undefined || field === '') continue;
    const parts = field.split('\t');
    const [add, remove] = parts;
    if (parts.length === 3 && parts[2] === '') index += 2;
    files++;
    if (add !== '-') added += Number(add);
    if (remove !== '-') removed += Number(remove);
  }
  return { files, added, removed };
}
