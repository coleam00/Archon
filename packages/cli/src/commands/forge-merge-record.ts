/**
 * A `pr.merge` the forge applied for a run records itself on the run's item: the merge, as
 * `workflow merged` records it, and the landing branch, as `workflow landing` does. The
 * facts come from the forge's answers, never from the request. A pack that still calls
 * `recordMerge` afterwards keeps this record: the store keeps the first merge.
 */
import { closeDatabase } from '@archon/core/db/connection';
import { readCallingNode } from '../utils/calling-node';
import { createCliWorkflowHost } from '../utils/workflow-host';
import { NoRunItemError, resolveItemTarget } from './item-target';

export interface RunMergeFacts {
  /** The merged pull request's URL. */
  change: string;
  commit: string | null;
  /** When the forge says the change merged. */
  at: string;
  /** The base branch the change landed on. */
  branch: string;
}

/**
 * `readFacts` runs only once the run is known to be on an item, so a run on no item costs
 * no forge read. A file-store run is never on an item, so it resolves to `no_item` too.
 */
export async function recordRunMerge(
  runId: string,
  readFacts: () => Promise<RunMergeFacts>,
  env: NodeJS.ProcessEnv
): Promise<'recorded' | 'no_item'> {
  try {
    const host = await createCliWorkflowHost();
    let target: { projectKey: string; key: string };
    try {
      target = await resolveItemTarget(host, process.cwd(), { itemOf: runId });
    } catch (error) {
      if (error instanceof NoRunItemError) return 'no_item';
      throw error;
    }
    const facts = await readFacts();
    const fromRun = readCallingNode(runId, env);
    const { store } = host.deps;
    const { branch, ...merge } = facts;
    const recorded = await store.recordItemMerge({ ...target, ...merge, via: 'forge', fromRun });
    if (recorded === null) throw new Error(`No item '${target.key}' in this project.`);
    await store.recordItemLanding({ ...target, branch, fromRun });
    return 'recorded';
  } finally {
    await closeDatabase();
  }
}
