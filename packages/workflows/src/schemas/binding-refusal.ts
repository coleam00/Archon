import { z } from 'zod';
import { stoppedLimitSchema, type StartRefusalReason, type StoppedLimit } from './run-metadata';

/**
 * Why a binding start was refused, stored on its binding row (`refusal`) by the write that
 * refuses it, so a read can name the reason without parsing `preparation_error`'s text:
 * a `StartRefusalReason`, `start_limit` with the limit's standing, or `rejected_by_source`
 * when the source plugin rejected the event (its reason stays in `preparation_error`).
 * `reason` reads as any text, so a code a newer binary writes still reads here.
 */
export const bindingRefusalSchema = z.object({
  reason: z.string().min(1),
  limit: stoppedLimitSchema.optional(),
});
export type BindingRefusal = z.infer<typeof bindingRefusalSchema>;
/** The codes this binary writes into `BindingRefusal.reason`. */
export type BindingRefusalReason = StartRefusalReason | 'start_limit' | 'rejected_by_source';

/** The stored refusal `reason` and `limit` name, as its column holds it. */
export function storedBindingRefusal(reason: BindingRefusalReason, limit?: StoppedLimit): string {
  return JSON.stringify(limit === undefined ? { reason } : { reason, limit });
}
