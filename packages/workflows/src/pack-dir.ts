import { readComposedMeta } from './compiled-command';
import type { DagNode } from './schemas';
import type { WorkflowPack } from './schemas/pack-settings';
import { packDirectory, type WorkflowSourceRoots } from './workflow-source';

/**
 * The directory `$PACK_DIR` names for `node`: the pack of the workflow file that authored
 * it, under `roots`. A composed node carries its own block's pack (or none, for a block
 * outside a pack); any other node belongs to the run's workflow. Resolved against the
 * roots the run reads at the moment it runs, never a path recorded at discovery: a run's
 * capture is moved into place after discovery reads it.
 */
export async function nodePackDir(
  roots: WorkflowSourceRoots,
  workflowPack: Pick<WorkflowPack, 'source' | 'key'> | undefined,
  node: DagNode
): Promise<string | undefined> {
  const composed = readComposedMeta(node);
  const pack = composed === undefined ? workflowPack : composed.pack;
  if (pack === undefined) return undefined;
  return (await packDirectory(roots, pack)) ?? undefined;
}
