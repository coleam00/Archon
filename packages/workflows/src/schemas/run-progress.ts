import { z } from 'zod';
import { nodeStateSchema } from './node-state';

/**
 * One top-level node of a run, as a run list shows its progress. `model` is the model the
 * node's latest start requested, absent when it requested none. `started_at` is when the
 * node's first attempt started; `duration_ms` sums every attempt's recorded duration and
 * is present only on a node that has ended, so a node suspended at a gate has none.
 */
export const runStepSchema = z.object({
  node_id: z.string(),
  state: nodeStateSchema,
  started_at: z.string().datetime({ offset: true }).optional(),
  duration_ms: z.number().optional(),
  model: z.string().optional(),
});
export type RunStep = z.infer<typeof runStepSchema>;

/** The longest `text` a run list carries of a run's last agent message. */
export const RUN_PROGRESS_MESSAGE_LENGTH = 500;

export const runLastMessageSchema = z.object({
  node_id: z.string(),
  at: z.string(),
  text: z.string().max(RUN_PROGRESS_MESSAGE_LENGTH),
  truncated: z.literal(true).optional(),
});
export type RunLastMessage = z.infer<typeof runLastMessageSchema>;

/**
 * What an active run is doing, for a run list. `steps` holds one entry per node of the
 * run's recorded graph in authored order. `last_observed_at` is the later of the run's
 * heartbeat (`last_activity_at`) and its newest event.
 */
export const runProgressSchema = z.object({
  steps: z.array(runStepSchema),
  last_observed_at: z.string().nullable(),
  /**
   * True while the run has running nodes and none of them, at any depth, records anything
   * while it runs: a `bash:` or `script:` node, or a `workflow:` node waiting on its child
   * run. However old `last_observed_at` is, such a run has not stalled.
   */
  silent_by_design: z.boolean(),
  /**
   * The agent message chunk the run stored last. A provider that flushes a reply block
   * early stores it as several chunks, so this can be the tail of a block.
   */
  last_message: runLastMessageSchema.nullable(),
  /** The branch of the run's worktree or container environment; null for a run with none. */
  branch: z.string().nullable(),
  /** The base branch the run was dispatched with; null when it recorded none. */
  base_branch: z.string().nullable(),
});
export type RunProgress = z.infer<typeof runProgressSchema>;

/** `text` as a run list carries it: whole, or cut to the bound and marked. */
export function boundedMessageText(text: string): Pick<RunLastMessage, 'text' | 'truncated'> {
  return text.length > RUN_PROGRESS_MESSAGE_LENGTH
    ? { text: text.slice(0, RUN_PROGRESS_MESSAGE_LENGTH), truncated: true }
    : { text };
}
