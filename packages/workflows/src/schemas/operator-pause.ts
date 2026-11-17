/**
 * An operator's pause of a running run (`archon workflow pause`). The request is recorded
 * on the running run; the executor that owns it pauses the run at its next node boundary.
 */
import { z } from 'zod';
import { itemActFields } from './item-act';
import { isOperatorPaused } from './pause-cause';
import type { WorkflowRun } from './workflow-run';

export const OPERATOR_PAUSE_METADATA_KEY = 'operator_pause';

// The record is written through a JSON merge, and SQLite's drops null values, so an absent
// field reads as null.
const storedActSchema = z
  .object({
    ...itemActFields,
    by: itemActFields.by.optional(),
    fromRun: itemActFields.fromRun.optional(),
  })
  .transform(act => ({ ...act, by: act.by ?? null, fromRun: act.fromRun ?? null }));

/**
 * Persisted under `OPERATOR_PAUSE_METADATA_KEY`. The request writes it without
 * `pausedAt`; the executor's running-to-paused transition sets it; any resume clears the
 * whole record, so a request a gate pause overtook ends with that gate's resume.
 */
export const operatorPauseRecordSchema = z.object({
  requested: storedActSchema,
  pausedAt: z.string().datetime().optional(),
});
export type OperatorPauseRecord = z.infer<typeof operatorPauseRecordSchema>;

export function readOperatorPauseRecord(
  metadata: Record<string, unknown> | undefined
): OperatorPauseRecord | undefined {
  const parsed = operatorPauseRecordSchema.safeParse(metadata?.[OPERATOR_PAUSE_METADATA_KEY]);
  return parsed.success ? parsed.data : undefined;
}

/**
 * The operator pause a run is in, as surfaces show it: `requested` while the run still
 * runs the nodes it had started, `paused` once the executor stopped at the boundary.
 */
export const operatorPauseSchema = z.object({
  state: z.enum(['requested', 'paused']),
  requested: z.object(itemActFields),
  pausedAt: z.string().datetime().nullable(),
});
export type OperatorPause = z.infer<typeof operatorPauseSchema>;

/** The operator pause `run` is in, or null when it is in none. */
export function operatorPause(run: Pick<WorkflowRun, 'status' | 'metadata'>): OperatorPause | null {
  const record = readOperatorPauseRecord(run.metadata);
  if (record === undefined) return null;
  if (run.status === 'running' && record.pausedAt === undefined)
    return { state: 'requested', requested: record.requested, pausedAt: null };
  if (isOperatorPaused(run) && record.pausedAt !== undefined)
    return { state: 'paused', requested: record.requested, pausedAt: record.pausedAt };
  return null;
}

/** One line for a surface that describes the run: who asked, through what, and when. */
export function describeOperatorPause(pause: OperatorPause): string {
  const { by, via, at } = pause.requested;
  const who = by === null ? via : `${'declared' in by ? by.declared : by.userId} via ${via}`;
  return pause.state === 'paused'
    ? `paused by an operator (${who}) at ${pause.pausedAt ?? at}`
    : `pause requested by an operator (${who}) at ${at}; takes effect when the running nodes finish`;
}
