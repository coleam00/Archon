/**
 * A continuation host's give-up on a run, recorded on the run so it outlives the host: after
 * repeated failures to read the run's frozen source the host stops resuming it. It names the
 * continuation it gave up on (`cursor`), so a reader applies it only while the run is still
 * at that continuation; a resume clears it (`resumeTransition`).
 */
import { z } from 'zod';

export const CONTINUATION_GIVEN_UP_METADATA_KEY = 'continuation_given_up';

/** A `WorkflowResumeCursor` as stored; every kind a continuation host wakes a run at. */
const storedCursorSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('wait'),
    nodeId: z.string(),
    resumeAt: z.string(),
    pauseId: z.string().optional(),
  }),
  z.object({ kind: z.literal('quota'), attempt: z.number(), resumeAt: z.string() }),
  z.object({ kind: z.literal('answered'), nodeId: z.string(), pauseId: z.string() }),
  z.object({
    kind: z.literal('source'),
    nodeId: z.string(),
    releasedAt: z.string(),
    releaseId: z.string().optional(),
  }),
]);

export const continuationGiveUpSchema = z.object({
  at: z.string(),
  attempts: z.number().int().positive(),
  /** What the host could not read, or null when the recorded source names no path. */
  path: z.string().nullable(),
  /** The `WorkflowResumeCursor` the host gave up on, as `resumeCursorMatches` reads it. */
  cursor: storedCursorSchema,
});
export type ContinuationGiveUp = z.infer<typeof continuationGiveUpSchema>;

/** The give-up a run records, or undefined when it records none or the record does not read. */
export function readContinuationGiveUp(
  metadata: Record<string, unknown>
): ContinuationGiveUp | undefined {
  const parsed = continuationGiveUpSchema.safeParse(metadata[CONTINUATION_GIVEN_UP_METADATA_KEY]);
  return parsed.success ? parsed.data : undefined;
}
