import { z } from 'zod';

/**
 * Something that happened to a process the provider started, worth an operator's
 * attention. Diagnostics only: nothing branches on it, and it is not a failure. A
 * provider turn that failed reports a `ProviderFailureClass` instead.
 *  - `process_still_exiting`  the process has not exited yet after SIGTERM. Reported
 *    repeatedly while it keeps running, with `waitedMs` (`providerLifecycleWaitedMsSchema`)
 *    for how long it has been waited for since the signal.
 *  - `process_abnormal_exit`  the process exited with a non-zero code or a signal.
 */
export const providerLifecycleEventSchema = z.enum([
  'process_still_exiting',
  'process_abnormal_exit',
]);
export type ProviderLifecycleEvent = z.infer<typeof providerLifecycleEventSchema>;

/** The one numeric log field the host forwards alongside a lifecycle event. */
export const providerLifecycleWaitedMsSchema = z.number().int().nonnegative();
