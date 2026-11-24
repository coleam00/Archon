/**
 * The item an item write names: `--item <key>` in the project of the checkout (or the
 * selected chat project), or `--item-of <run-id>`, the item the run's root is on, in its
 * own project. `archon:script` writes through `--item-of`, so a script that changes
 * directory still writes on its own run's item and on no other project's.
 */
import type { WorkflowHost } from '@archon/core/workflows/host-store';
import type { WorkflowItem } from '@archon/workflows/schemas/workflow-run';
import { projectRefForCodebase } from '@archon/core/operations/attention-queue';
import { findCodebaseForCheckoutPath } from '@archon/core/services/codebase-checkout-resolver';
import { inheritedWorkflowCodebase } from './workflow-shared';

export type ItemTarget = { readonly item: string } | { readonly itemOf: string };

/** `--item-of` named a run that is on no item, or no run at all; refused before any write. */
export class NoRunItemError extends Error {
  constructor(readonly runId: string) {
    super(`Run '${runId}' is not on an item.`);
    this.name = 'NoRunItemError';
  }
}

export async function resolveItemTarget(
  host: WorkflowHost,
  cwd: string,
  target: ItemTarget
): Promise<{ projectKey: string; key: string }> {
  if ('itemOf' in target) {
    const item = await resolveRunItem(host, target.itemOf);
    return { projectKey: item.projectKey, key: item.key };
  }
  const selected = await inheritedWorkflowCodebase(host);
  const codebase = selected ?? (await findCodebaseForCheckoutPath(cwd, host.records.codebases));
  if (!codebase) throw new Error('--item names an item in one registered project.');
  return { projectKey: projectRefForCodebase(codebase).key, key: target.item };
}

/** The item the run's root is on, as `--item-of` names it. */
export async function resolveRunItem(host: WorkflowHost, runId: string): Promise<WorkflowItem> {
  const { store } = host.deps;
  // The root's item, as `workflow runs --item-of` reads it: a `workflow:` child has none.
  let run = await store.getWorkflowRun(runId);
  while (run?.parent_run_id) run = await store.getWorkflowRun(run.parent_run_id);
  const item = run?.item_id ? await store.getItem(run.item_id) : null;
  if (!item) throw new NoRunItemError(runId);
  const selected = await inheritedWorkflowCodebase(host);
  if (selected && projectRefForCodebase(selected).key !== item.projectKey)
    throw new Error(
      'This operation is outside the selected chat project. Use /setproject to change projects.'
    );
  return item;
}
