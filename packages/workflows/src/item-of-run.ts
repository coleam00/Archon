import type { WorkflowRun } from './schemas/workflow-run';
import type { IWorkflowStore } from './store';

/**
 * The item a run belongs to through its root, or null when its ancestry or root item is
 * unavailable. Cyclic ancestry rejects the read. A `workflow:` child carries no direct item id.
 */
export async function readRunItemId(
  store: Pick<IWorkflowStore, 'getWorkflowRun'>,
  runOrId: WorkflowRun | string
): Promise<string | null> {
  let root = typeof runOrId === 'string' ? await store.getWorkflowRun(runOrId) : runOrId;
  if (root === null) return null;
  const seen = new Set<string>([root.id]);
  while (root.parent_run_id !== null) {
    if (seen.has(root.parent_run_id))
      throw new Error(`Cyclic workflow run ancestry at ${root.parent_run_id}`);
    seen.add(root.parent_run_id);
    const parent = await store.getWorkflowRun(root.parent_run_id);
    if (parent === null) return null;
    root = parent;
  }
  return root.item_id;
}
