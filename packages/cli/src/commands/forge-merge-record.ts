/**
 * A `pr.merge` from a run records itself on the run's item when the forge applied it, or
 * refused it because the pull request was already merged: the merge, as `workflow merged`
 * records it, and the landing branch, as `workflow landing` does. The facts come from the
 * forge's answer, never from the request: the merge result, or the refusal's evidence of
 * the earlier merge. The store keeps the first merge, and the landing is written with it,
 * or later for that same change when the item has none. A repeat, a pack that still calls
 * `recordMerge` afterwards, or a merge of another pull request changes no record.
 */
import { closeDatabase } from '@archon/core/db/connection';
import { readCallingNode } from '../utils/calling-node';
import { createCliWorkflowHost } from '../utils/workflow-host';
import type { WorkflowItem } from '@archon/workflows/schemas/workflow-run';
import { NoRunItemError, resolveRunItem } from './item-target';

export interface RunMergeFacts {
  /** The merged pull request's URL. */
  change: string;
  commit: string | null;
  /** When the forge says the change merged; absent from a plugin released before it. */
  at: string | undefined;
  /** The base branch the change landed on. */
  branch: string;
}

/**
 * `no_merge_time`: the run is on an item, but the plugin reported no merge time, so
 * nothing is recorded rather than a time the forge did not give. `already_recorded`: the
 * item already has its merge and landing, or a merge of another change, so nothing is
 * written. A file-store run is never on an item, so it resolves to `no_item`.
 */
export async function recordRunMerge(
  runId: string,
  facts: RunMergeFacts,
  env: NodeJS.ProcessEnv
): Promise<'recorded' | 'already_recorded' | 'no_item' | 'no_merge_time'> {
  try {
    const host = await createCliWorkflowHost();
    let item: WorkflowItem;
    try {
      item = await resolveRunItem(host, runId);
    } catch (error) {
      if (error instanceof NoRunItemError) return 'no_item';
      throw error;
    }
    const { at, branch, change, commit } = facts;
    if (at === undefined) return 'no_merge_time';
    const fromRun = readCallingNode(runId, env);
    const { store } = host.deps;
    const target = { projectKey: item.projectKey, key: item.key };
    const recorded = await store.recordItemMerge({
      ...target,
      change,
      commit,
      at,
      via: 'forge',
      fromRun,
    });
    if (recorded === null) throw new Error(`No item '${target.key}' in this project.`);
    // The item already has a merge. Its landing is filled only when that merge is this
    // change and records no branch: `workflow merged` writes none, and a run can stop
    // between the two writes. A landing already there, perhaps corrected, is kept.
    if (
      !recorded.recorded &&
      (recorded.merge.change !== change || (await store.getItemLanding(item.id)) !== null)
    )
      return 'already_recorded';
    await store.recordItemLanding({ ...target, branch, fromRun });
    return 'recorded';
  } finally {
    await closeDatabase();
  }
}
