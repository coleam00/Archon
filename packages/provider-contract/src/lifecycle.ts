import { z } from 'zod';

/**
 * Something that happened to a process the provider started, worth an operator's
 * attention. Diagnostics only: nothing branches on it, and it is not a failure. A
 * provider turn that failed reports a `ProviderFailureClass` instead.
 *  - `process_ignored_sigterm`  the process did not exit after SIGTERM.
 *  - `process_abnormal_exit`    the process exited with a non-zero code or a signal.
 */
export const providerLifecycleEventSchema = z.enum([
  'process_ignored_sigterm',
  'process_abnormal_exit',
]);
export type ProviderLifecycleEvent = z.infer<typeof providerLifecycleEventSchema>;
