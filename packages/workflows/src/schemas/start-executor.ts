import { z } from 'zod';

/**
 * Whether an admitted start whose run has not begun has an executor, as this process
 * observes it per read; never persisted. `starting`: its executor's live-owner endpoint
 * answers, or the process it was handed to runs only this start and is alive here.
 * `unowned`: no executor runs it on this host and user, and the run is still pending;
 * `archon trigger execute <requestId> --host <hostId>` runs it once. `unknown`: this
 * process cannot tell, because the executor was handed to another host or user, or is a
 * server whose own life says nothing about this start, or no observer was given. Elapsed
 * time is never an input.
 */
export const startExecutorStateSchema = z.enum(['starting', 'unowned', 'unknown']);
export type StartExecutorState = z.infer<typeof startExecutorStateSchema>;

/** The process an admitted start was handed to (`START_EXECUTOR_METADATA_KEY`). */
export const startExecutorRecordSchema = z.object({
  host: z.string(),
  pid: z.number().int(),
  uid: z.number().int().optional(),
  dedicated: z.boolean(),
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
  executor: startExecutorRecordSchema.nullable(),
});
export type AwaitingExecution = z.infer<typeof awaitingExecutionSchema>;

/** An observation of a pending admitted start's executor. */
export type StartExecutorObservation = Pick<AwaitingExecution, 'state' | 'executor'>;
