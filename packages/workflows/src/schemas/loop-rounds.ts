import { z } from 'zod';
import { nodeArtifactLoopFrameSchema } from './node-artifact';
import { runNodeStateSchema } from './terminal-record';

/**
 * One body node's invocation in one loop round: its state as the terminal record folds
 * it, plus that invocation's timing and output. `started_at` is when the invocation's
 * first attempt started; `duration_ms` sums every attempt's recorded duration (retries
 * included, the waits between them not), and is absent until the last attempt ends. `output` and `output_truncated` are the
 * stored `node_output` as the event log bounds it at write: a completed node's output, or
 * the stdout a failed `bash:` or `script:` node recorded. `structured_output` is present
 * only on a completed node.
 */
export const loopRoundNodeSchema = runNodeStateSchema.extend({
  started_at: z.string().datetime({ offset: true }).optional(),
  duration_ms: z.number().optional(),
  output: z.string().optional(),
  output_truncated: z.boolean().optional(),
  structured_output: z.unknown().optional(),
});
export type LoopRoundNode = z.infer<typeof loopRoundNodeSchema>;

/**
 * One iteration of the innermost loop in `loop_group_path` (frames outermost first,
 * iterations 1-based). A nested loop's rounds are separate entries whose path extends the
 * outer round's path; the inner group node itself lists under the outer round. Body nodes
 * a running round has not reached yet are absent.
 */
export const loopRoundSchema = z.object({
  loop_group_path: z.array(nodeArtifactLoopFrameSchema).min(1),
  nodes: z.array(loopRoundNodeSchema),
});
export type LoopRound = z.infer<typeof loopRoundSchema>;
