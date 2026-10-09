/**
 * Which lenses this round enabled and which did not complete, computed from the
 * engine's records instead of asked of the deciding agent.
 *
 * A lens that completed left a typed artifact (`review-lens`, or `structure-review`
 * for simplify): the engine publishes one only after the producer succeeds, so a
 * lens that wrote a report and then failed certification counts as not completed.
 * The enabled set comes from the same rule the lenses gate on
 * (../../.shared/review-lenses.ts). Only artifacts of this review's own lens nodes
 * count: the node id is this node's include prefix plus the lens name, in this
 * node's loop iteration, so another review in the same run never vouches for this one. The deciding agent reports
 * what is missing, and publish refuses a ready verdict while anything is.
 *
 * Bound inputs (`with:` bindings, canonical text in env):
 * - INPUTS_CONTINUATION, INPUTS_TIER, INPUTS_ERRORS, INPUTS_DOCS, INPUTS_SCOPE_DOCS:
 *   as for the coverage node.
 */

import { artifactsDir, emit, refuse } from '../../.shared/io.ts';
import { enabledLenses, type Lens } from '../../.shared/review-lenses.ts';
import { readTyped, type ListedArtifact } from '../../.shared/typed.ts';

interface LoopFrame {
  readonly groupId: string;
  readonly iteration: number;
}

/** This node's include prefix and loop position, as the engine identifies it. */
function ownPosition(): { readonly prefix: string; readonly loop: string } {
  const execution = JSON.parse(process.env.ARCHON_NODE_EXECUTION ?? '') as {
    path?: string;
    invocation?: { loopPath?: readonly LoopFrame[] };
  };
  const path = execution.path ?? '';
  if (!path.endsWith('lens-status')) throw new Error(`unexpected node path '${path}'`);
  return {
    prefix: path.slice(0, -'lens-status'.length),
    loop: JSON.stringify(execution.invocation?.loopPath ?? []),
  };
}

try {
  const { prefix, loop } = ownPosition();
  const listingFile = process.env.TYPED_ARTIFACTS_FILE;
  const coverage = readTyped<{ full: boolean }>(listingFile, artifactsDir(), 'review-coverage');
  const tier = process.env.INPUTS_TIER ?? '';
  const required = enabledLenses({
    continuation: process.env.INPUTS_CONTINUATION === 'true',
    tier,
    // Without a coverage record the focused reviewer never reported: only seams and
    // focused itself are known to be required.
    focusedFull: coverage.values.at(-1)?.full ?? null,
    errors: process.env.INPUTS_ERRORS ?? '',
    docs: process.env.INPUTS_DOCS ?? '',
    scopeDocs: process.env.INPUTS_SCOPE_DOCS === 'true',
  });
  const listed = (type: string): readonly ListedArtifact[] =>
    readTyped(listingFile, artifactsDir(), type).entries ?? [];
  const done = new Set(
    [...listed('review-lens'), ...listed('structure-review')]
      // The same include and the same loop iteration: an earlier round's lens in the
      // same loop never vouches for this one.
      .filter(entry => JSON.stringify(entry.loopGroupPath ?? []) === loop)
      .map(entry => entry.nodeId ?? '')
      .filter(id => id.startsWith(prefix))
      .map(id => id.slice(prefix.length).split('__')[0])
  );
  const completed: Lens[] = required.filter(lens => done.has(lens));
  const missing: Lens[] = required.filter(lens => !done.has(lens));
  emit({ required, completed, missing });
} catch (error) {
  refuse(`lens-status: ${error instanceof Error ? error.message : String(error)}`);
}
