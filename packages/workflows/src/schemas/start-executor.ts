import { z } from 'zod';

/**
 * What this process observes of the executor of an admitted start whose run has not begun;
 * observed per read, never persisted. `starting`: the run's live-owner endpoint answers,
 * the only proof that a process is executing this start. `unowned`: the run is still
 * pending and nothing can be running it, because its hand-off recorded that it started
 * nothing or the process it was handed to no longer exists on this host;
 * `archon trigger execute <requestId> --host <hostId>` runs it once. `unknown`: this process
 * cannot tell, because nothing was recorded yet, the recorded process is on another host or
 * user, or a process holds the recorded pid but does not answer as this run's owner (an
 * executor still booting, or another process that reused the pid). Elapsed time is never
 * an input.
 */
export const startExecutorStateSchema = z.enum(['starting', 'unowned', 'unknown']);
export type StartExecutorState = z.infer<typeof startExecutorStateSchema>;

/** The process an admitted start was handed to (`START_EXECUTOR_METADATA_KEY`). */
export const startExecutorProcessSchema = z.object({
  host: z.string(),
  pid: z.number().int(),
  uid: z.number().int().optional(),
});

/**
 * An admitted start whose run has not begun, the host whose executor runs it, what this
 * process observes of that executor, and the process it was handed to when one was
 * recorded.
 */
export const awaitingExecutionSchema = z.object({
  requestId: z.string(),
  hostId: z.string(),
  state: startExecutorStateSchema,
  executor: startExecutorProcessSchema.nullable(),
});
export type AwaitingExecution = z.infer<typeof awaitingExecutionSchema>;

/** An observation of a pending admitted start's executor. */
export type StartExecutorObservation = Pick<AwaitingExecution, 'state' | 'executor'>;
