import type { WorkflowRun } from './schemas/workflow-run';
import type { IWorkflowStore } from './store';

/**
 * The item a run belongs to through its root, or null when its ancestry or root item is
 * unavailable. A `workflow:` child carries no direct item id.
 */
export async function readRunItemId(
  store: Pick<IWorkflowStore, 'getWorkflowRun'>,
  runOrId: WorkflowRun | string
): Promise<string | null> {
  let root = typeof runOrId === 'string' ? await store.getWorkflowRun(runOrId) : runOrId;
  if (root === null) return null;
  while (root.parent_run_id !== null) {
    const parent = await store.getWorkflowRun(root.parent_run_id);
    if (parent === null) return null;
    root = parent;
  }
  return root.item_id;
}
