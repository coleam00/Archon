/**
 * How large an item run's change is at the clean commit its checkout ended on (#6261),
 * measured once when the run completes or fails. Recording it then keeps an item read free of git,
 * survives a deleted worktree, and keeps an old run's size from changing when a branch moves.
 */
import { createLogger } from '@archon/paths';
import type { ExecutionContext } from '@archon/provider-contract';
import { runGit, sampleCheckout } from './checkout-observation';
import { resultCommitFromSample } from './run-result';
import { readCheckoutHandoff } from './schemas/resource-start';
import { type ChangeSize, recordedChangeSize } from './schemas/change-size';
import { continuationInheritsEstate, readContinuationMode } from './schemas/run-metadata';
import type { WorkflowRun } from './schemas/workflow-run';
import type { IWorkflowStore } from './store';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('workflow.change-size');
  return cachedLog;
}

type RunReader = Pick<IWorkflowStore, 'getWorkflowRun'>;
type SizedRun = Pick<WorkflowRun, 'id' | 'checkout_baseline' | 'metadata' | 'adopted_from_run_id'>;

/**
 * The change at `endCommit` against the commit the run's work was cut from. Only a run of
 * an item is measured: nothing else reads the size. Returns null, never zeros, when the
 * run has no item, its checkout ended on no clean commit, or no cut-from is known for its
 * work. Never throws.
 */
export async function measureChangeSize(
  store: RunReader,
  run: SizedRun & Pick<WorkflowRun, 'item_id'>,
  cwd: string,
  endCommit: string | null
): Promise<ChangeSize | null> {
  if (run.item_id === null || endCommit === null) return null;
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
    return null;
  }
}

/**
 * The size of a failing run's change. A build can commit before a later node fails: the
 * failed run still ended at that commit. Only an item run pays for the checkout sample.
 */
export async function measureFailedChangeSize(
  store: RunReader,
  run: SizedRun & Pick<WorkflowRun, 'item_id'>,
  cwd: string,
  execContext: ExecutionContext
): Promise<ChangeSize | null> {
  if (run.item_id === null) return null;
  const ended = resultCommitFromSample(await sampleCheckout(cwd, execContext));
  return measureChangeSize(store, run, cwd, ended.held ? ended.commit : null);
}

/** The size a run's row recorded when it ended, for a reader: an unreadable one reads as none. */
export function readChangeSize(run: WorkflowRun): ChangeSize | null {
  try {
    return recordedChangeSize(run);
  } catch (error) {
    getLog().warn({ err: error, workflowRunId: run.id }, 'workflow.change_size_unreadable');
    return null;
  }
}

function unavailable(workflowRunId: string, step: string, code?: number): null {
  getLog().info({ workflowRunId, step, code }, 'workflow.change_size_unavailable');
  return null;
}

/**
 * The commit the run's work was cut from. A run on a checkout another run left takes that
 * run's base: one started on a hand-off (`checkout_handoff`, which names the run whose
 * estate holds the branch, so a read-only check on its own copy cut at the build's commit
 * still measures from the build's base), and one that adopted a run's estate (`--adopt`, or a
 * restart of a hand-off), through `adopted_from_run_id`. Otherwise it is the cut-from the run
 * recorded when it created its checkout. A branch reused with `--branch` has neither.
 */
async function workBase(store: RunReader, run: SizedRun): Promise<string | undefined> {
  const sourceId = readCheckoutHandoff(run)?.runId ?? adoptedEstate(run);
  if (sourceId === undefined)
    return run.checkout_baseline?.kind === 'git' ? run.checkout_baseline.cutFromCommit : undefined;
  const source = await store.getWorkflowRun(sourceId);
  if (source === null) return undefined;
  return recordedChangeSize(source)?.base ?? workBase(store, source);
}

/** The run whose estate this run adopted; a supersession takes no estate. Legacy unstamped runs adopt. */
function adoptedEstate(run: SizedRun): string | undefined {
  if (run.adopted_from_run_id === null) return undefined;
  const mode = readContinuationMode(run.metadata);
  return mode === undefined || continuationInheritsEstate(mode)
    ? run.adopted_from_run_id
    : undefined;
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
