import { z } from 'zod';

/**
 * The install's run limit (`concurrency.runs`) and how many run trees count against it now: a
 * tree counts from its top-level run's admission until every run in it has ended. Full when
 * `live >= limit`; every new start then waits for a tree to end.
 */
export const runLimitSchema = z.object({
  limit: z.number().int().positive(),
  live: z.number().int().nonnegative(),
});
export type RunLimit = z.infer<typeof runLimitSchema>;

/**
 * The run limit as the store reads it for an operator: with `waiting`, the ids of the queued
 * start requests that only the limit holds now. A drain of their host would admit them on
 * their resource, and the limit's room goes elsewhere.
 */
export type RunLimitState = RunLimit & { waiting: readonly string[] };

export function describeRunLimit(limit: RunLimit): string {
  return `${String(limit.live)} of ${String(limit.limit)} runs at once on this install`;
}

/** The run limit while it is full, else null: what a read reports a start waiting for. */
export function fullRunLimit(limit: RunLimit | null): RunLimit | null {
  return limit && limit.live >= limit.limit ? limit : null;
}
