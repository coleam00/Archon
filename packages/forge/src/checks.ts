import { z } from 'zod';
import { checkChangedEventSchema } from './events';
import { repoRefSchema } from './identity';

export const rerunGroupSchema = z.object({
  id: z.string().min(1),
  attempt: z.number().int().positive(),
});
export const selectedCheckSchema = z.object({
  unit: checkChangedEventSchema.shape.unit,
  rerun: rerunGroupSchema.nullable(),
});
export const checkSelectionSchema = z.array(selectedCheckSchema).superRefine((units, ctx) => {
  const identities = new Set<string>();
  for (const [index, { unit }] of units.entries()) {
    const key = JSON.stringify([unit.kind, unit.id]);
    if (identities.has(key))
      ctx.addIssue({ code: 'custom', message: 'Duplicate check unit', path: [index] });
    identities.add(key);
  }
});
export type SelectedCheck = z.infer<typeof selectedCheckSchema>;

export const selectedChecksSchema = checkSelectionSchema.min(1);

/** The most log bytes one `checks.logs` returns, and the size it returns when none is asked for. */
export const CHECKS_LOGS_MAX_BYTES = 1024 * 1024;
export const CHECKS_LOGS_DEFAULT_BYTES = 64 * 1024;
/**
 * The log of one check unit, named exactly as `checks.state` or `checks.commit`
 * reported it. A log longer than `maxBytes` keeps its end, where a failure is.
 */
export const checksLogsRequestSchema = z.object({
  operationId: z.string().min(1),
  op: z.literal('checks.logs'),
  repo: repoRefSchema,
  unit: checkChangedEventSchema.shape.unit,
  maxBytes: z.number().int().positive().max(CHECKS_LOGS_MAX_BYTES).optional(),
});
/**
 * A unit without a log is an answer, not an error: `unit_has_no_log` for a unit
 * that never has one, such as a commit status, and `log_unavailable` for one whose
 * log the forge does not hold now, because it is not written yet or has expired.
 * `totalBytes` is the whole log's size, so `truncated` text is its last bytes.
 */
export const checkLogSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('text'),
    text: z.string(),
    truncated: z.boolean(),
    totalBytes: z.number().int().nonnegative(),
  }),
  z.object({ kind: z.literal('none'), reason: z.enum(['unit_has_no_log', 'log_unavailable']) }),
]);
export const checksLogsSchema = z.object({
  repo: repoRefSchema,
  unit: checkChangedEventSchema.shape.unit,
  log: checkLogSchema,
});
