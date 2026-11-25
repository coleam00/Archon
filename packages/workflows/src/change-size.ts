/**
 * How large an item run's change is at the clean commit its checkout ended on (#6261),
 * measured once when the run completes or fails. Recording it then keeps an item read free of git,
 * survives a deleted worktree, and keeps an old run's size from changing when a branch moves.
 */
import { createLogger } from '@archon/paths';
import { runGit } from './checkout-observation';
import { readCheckoutHandoff } from './schemas/resource-start';
import {
  CHANGE_SIZE_METADATA_KEY,
  type ChangeSize,
  changeSizeSchema,
} from './schemas/terminal-record';
import type { WorkflowRun } from './schemas/workflow-run';
import type { IWorkflowStore } from './store';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('workflow.change-size');
  return cachedLog;
}

type RunReader = Pick<IWorkflowStore, 'getWorkflowRun'>;
type SizedRun = Pick<WorkflowRun, 'id' | 'checkout_baseline' | 'metadata'>;

/**
 * The change at `endCommit` against the commit the run's work was cut from. Only a run of
 * an item is measured: nothing else reads the size. Returns undefined, never zeros, when the
 * run has no item, its checkout ended on no clean commit, or no cut-from is known for its
 * work. Never throws.
 */
export async function measureChangeSize(
  store: RunReader,
  run: SizedRun & Pick<WorkflowRun, 'item_id'>,
  cwd: string,
  endCommit: string | null
): Promise<ChangeSize | undefined> {
  if (run.item_id === null || endCommit === null) return undefined;
  try {
    const base = await workBase(store, run);
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
 * The commit the run's work was cut from. A run started on another run's checkout
 * (`checkout_handoff`) measures from the base of the run whose estate holds that branch,
 * so a read-only check on its own copy, cut at the build's commit, and a later build on the
 * build's branch both measure from where the first build's branch was cut. Otherwise it is
 * the cut-from this run recorded when it created its checkout; a run that reused or adopted
 * a checkout outside a hand-off has none.
 */
async function workBase(store: RunReader, run: SizedRun): Promise<string | undefined> {
  const handoff = readCheckoutHandoff(run);
  if (handoff === undefined)
    return run.checkout_baseline?.kind === 'git' ? run.checkout_baseline.cutFromCommit : undefined;
  const source = await store.getWorkflowRun(handoff.runId);
  if (source === null) return undefined;
  const recorded = changeSizeSchema.safeParse(source.metadata[CHANGE_SIZE_METADATA_KEY]);
  return recorded.success ? recorded.data.base : workBase(store, source);
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
