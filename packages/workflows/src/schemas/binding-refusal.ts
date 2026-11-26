import { z } from 'zod';
import { fileSettingRefusalSchema } from './pack-settings';
import { stoppedLimitSchema, type StartRefusalReason } from './run-metadata';

/**
 * Why a binding start was refused, stored on its binding row (`refusal`) by the write that
 * refuses it, so a read can name the reason without parsing `preparation_error`'s text:
 * a `StartRefusalReason`, `start_limit` with the limit's standing, `file_setting_missing`
 * with the setting it is about, or `rejected_by_source` when the source plugin rejected the
 * event (its reason stays in `preparation_error`). An item's stop records the same details
 * on its refused entry. `reason` reads as any text, so a code a newer binary writes still
 * reads here.
 */
export const bindingRefusalSchema = z.object({
  reason: z.string().min(1),
  limit: stoppedLimitSchema.optional(),
  fileSetting: fileSettingRefusalSchema.optional(),
});
export type BindingRefusal = z.infer<typeof bindingRefusalSchema>;
/** The codes this binary writes into `BindingRefusal.reason`. */
export type BindingRefusalReason = StartRefusalReason | 'start_limit' | 'rejected_by_source';

/** A refusal as its column holds it: the reason, and the detail that goes with it. */
export function storedBindingRefusal(
  reason: BindingRefusalReason,
  detail: Omit<BindingRefusal, 'reason'> = {}
): string {
  return JSON.stringify({ reason, ...detail });
}
