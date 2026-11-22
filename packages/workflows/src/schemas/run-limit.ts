import { z } from 'zod';

/**
 * The install's run limit (`concurrency.runs`) and how many top-level runs count against it
 * now: running, or admitted and not yet claimed. Full when `live >= limit`; every new start
 * then waits for a run to end.
 */
export const runLimitSchema = z.object({
  limit: z.number().int().positive(),
  live: z.number().int().nonnegative(),
});
export type RunLimit = z.infer<typeof runLimitSchema>;

export function describeRunLimit(limit: RunLimit): string {
  return `${String(limit.live)} of ${String(limit.limit)} runs at once on this install`;
}

/** The run limit while it is full, else null: what a read reports a start waiting for. */
export function fullRunLimit(limit: RunLimit | null): RunLimit | null {
  return limit && limit.live >= limit.limit ? limit : null;
}
