import { z } from 'zod';
import { gitObjectIdSchema } from './checkout-observation';

/**
 * Run metadata key of an item run's change size (#6261), written by the run's completion or
 * failure write. Null on a completion that measured none.
 */
export const CHANGE_SIZE_METADATA_KEY = 'change_size';

/**
 * How large an item run's change is at the clean commit its checkout ended on: the files
 * changed and lines added and removed from `base`, the commit the item's work was cut from,
 * to `commit`. Absent means unknown, never zero. Renames are detected, as `git diff` does by
 * default. A binary file counts as a file with no lines.
 */
export const changeSizeSchema = z.object({
  base: gitObjectIdSchema,
  commit: gitObjectIdSchema,
  files: z.number().int().nonnegative(),
  added: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
});
export type ChangeSize = z.infer<typeof changeSizeSchema>;

/** The size a completed or failed run recorded, or null. A malformed value throws: it is engine-written. */
export function recordedChangeSize(run: {
  status: string;
  metadata: Readonly<Record<string, unknown>>;
}): ChangeSize | null {
  if (run.status !== 'completed' && run.status !== 'failed') return null;
  const value = run.metadata[CHANGE_SIZE_METADATA_KEY];
  return value == null ? null : changeSizeSchema.parse(value);
}
