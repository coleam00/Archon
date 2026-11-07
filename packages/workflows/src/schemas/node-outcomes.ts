import { z } from 'zod';
import { nodeArtifactLoopFrameSchema } from './node-artifact';
import { runNodeStateSchema, terminalRecordSchema } from './terminal-record';

/**
 * One node invocation's outcome as a running node observes it: the terminal record's
 * per-node state, one entry per loop iteration. `node_id` is the step path the run's
 * events and terminal record use, so a loop body node reads `<group>.<body id>`.
 */
export const nodeOutcomeSchema = runNodeStateSchema.extend({
  /** Outermost-to-innermost loop frames; absent outside a `loop_group` body. */
  loop_group_path: z.array(nodeArtifactLoopFrameSchema).min(1).optional(),
  /**
   * A completed node's certified structured output (`output_format`). Never present
   * on a failed node: its output cannot be trusted, so only its `error` is reported.
   */
  output: z.unknown().optional(),
});
export type NodeOutcome = z.infer<typeof nodeOutcomeSchema>;

/**
 * The on-disk observation delivered as `$NODE_OUTCOMES_FILE`. `run_id` lets a consumer
 * reject a listing handed to it out of scope; `first_failed_node` is the step path of the
 * earliest recorded failure, as in the terminal record.
 */
export const nodeOutcomesListingSchema = z.object({
  run_id: terminalRecordSchema.shape.run_id,
  first_failed_node: terminalRecordSchema.shape.first_failed_node,
  nodes: z.array(nodeOutcomeSchema),
});
export type NodeOutcomesListing = z.infer<typeof nodeOutcomesListingSchema>;
