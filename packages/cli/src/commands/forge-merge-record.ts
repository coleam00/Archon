/**
 * A `pr.merge` from a run records itself on the run's item when the forge applied it, or
 * refused it because the pull request was already merged: the merge, as `workflow merged`
 * records it, and the landing branch, as `workflow landing` does. The facts come from the
 * forge, never from the request: from the merge result, or for an already-merged refusal
 * from `pr.view` and `pr.merge-state`. A pack that still calls `recordMerge` afterwards
 * keeps this record: the store keeps the first merge.
 */
import { closeDatabase } from '@archon/core/db/connection';
import { readCallingNode } from '../utils/calling-node';
import { createCliWorkflowHost } from '../utils/workflow-host';
import { NoRunItemError, resolveItemTarget } from './item-target';

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
 * nothing is recorded rather than a time the forge did not give. A file-store run is
 * never on an item, so it resolves to `no_item`.
 */
export async function recordRunMerge(
  runId: string,
  facts: RunMergeFacts,
  env: NodeJS.ProcessEnv
): Promise<'recorded' | 'no_item' | 'no_merge_time'> {
  try {
    const host = await createCliWorkflowHost();
    let target: { projectKey: string; key: string };
    try {
      target = await resolveItemTarget(host, process.cwd(), { itemOf: runId });
    } catch (error) {
      if (error instanceof NoRunItemError) return 'no_item';
      throw error;
    }
    const { at, branch, change, commit } = facts;
    if (at === undefined) return 'no_merge_time';
    const fromRun = readCallingNode(runId, env);
    const { store } = host.deps;
    const recorded = await store.recordItemMerge({
      ...target,
      change,
      commit,
      at,
      via: 'forge',
      fromRun,
    });
    if (recorded === null) throw new Error(`No item '${target.key}' in this project.`);
    await store.recordItemLanding({ ...target, branch, fromRun });
    return 'recorded';
  } finally {
    await closeDatabase();
  }
}
