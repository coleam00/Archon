/**
 * The internal CLI flag a Windows schedule task runs (`windows-hidden-desktop.ts`). The task
 * XML and the `cli.ts` dispatch both read it from here. It has a module of its own so `cli.ts`
 * can import it statically without loading the launcher's FFI or the schedule backends.
 */
export const SCHEDULE_LAUNCH_FLAG = '--internal-schedule-launch';
