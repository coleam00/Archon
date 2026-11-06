import { join } from 'path';
import { readComposedMeta } from './compiled-command';
import type { DagNode } from './schemas';
import type { WorkflowPack } from './schemas/pack-settings';
import { packDirectory, type WorkflowSourceRoots } from './workflow-source';
import { INSTALLED_SCOPE_DIR } from './workflow-source/roots';

/**
 * What `$PACK_DIR` is for one node. `none` is a node whose workflow is not in a pack;
 * `unlocated` is a pack the run's source roots do not hold, which is a broken source
 * rather than a workflow outside a pack, so it gets its own error.
 */
export type PackDirScope =
  | { readonly kind: 'none' }
  | { readonly kind: 'dir'; readonly dir: string }
  | { readonly kind: 'unlocated'; readonly pack: Pick<WorkflowPack, 'source' | 'key'> };

/**
 * The `$PACK_DIR` scope for `node`: the pack of the workflow file that authored it, under
 * `roots`. A composed node carries its own block's pack (or none, for a block outside a
 * pack); any other node belongs to the run's workflow. Resolved against the roots the run
 * reads at the moment it runs, never a path recorded at discovery: a run's capture is
 * moved into place after discovery reads it.
 *
 * A captured run's pack directory is a path join with no I/O, so resolving it for every
 * dispatch costs nothing and no manifest read can fail a node that never reads the value.
 * Only an installed pack read live (a run with no captured source) scans the receipts.
 */
export async function nodePackDir(
  roots: WorkflowSourceRoots,
  workflowPack: Pick<WorkflowPack, 'source' | 'key'> | undefined,
  node: DagNode
): Promise<PackDirScope> {
  const composed = readComposedMeta(node);
  const pack = composed === undefined ? workflowPack : composed.pack;
  if (pack === undefined) return { kind: 'none' };
  const dir =
    pack.source === 'installed' && roots.installed.kind === 'captured'
      ? join(roots.installed.captureRoot, INSTALLED_SCOPE_DIR, pack.key)
      : await packDirectory(roots, pack);
  return dir === null ? { kind: 'unlocated', pack } : { kind: 'dir', dir };
}

/** The scope's directory, or the error that explains why a node cannot have one. */
export function packDirOrThrow(scope: PackDirScope | undefined): string {
  if (scope?.kind === 'dir') return scope.dir;
  if (scope?.kind === 'unlocated') {
    throw new Error(
      `$PACK_DIR is referenced but pack '${scope.pack.key}' (${scope.pack.source}) is not in this run's workflow source.`
    );
  }
  throw new Error(
    "$PACK_DIR is referenced but this node's workflow was not loaded from a pack. " +
      '$PACK_DIR names the pack folder of a packaged workflow ' +
      '(.archon/workflows/<pack>/<workflow>/).'
  );
}
