import { WINDOWS_PROCESS_TREE_STOP_MAX_MS } from './windows-process-tree';

/*
 * How long stopping a detached run owner can take, shared by the controller that stops it
 * (`run-owner-stop.ts`) and the waiters that watch it go (`run-attention-watch.ts`). It
 * lives apart from both so a waiter can read the bound without loading the stop path.
 */

/** POSIX: how long the owner's process group has to exit after SIGTERM. */
export const TERMINATION_GRACE_MS = 5_000;
/** POSIX: how long the group has to disappear after SIGKILL. */
export const TERMINATION_CONFIRM_MS = 1_000;

/**
 * The longest a committed stop spends terminating the owner's process tree before it
 * returns or throws, from the terminator's own bounds. The controller and every waiter
 * share one host (the owner endpoint is host-local), so this process's platform is the
 * controller's.
 */
export const DETACHED_RUN_TERMINATION_MAX_MS =
  process.platform === 'win32'
    ? WINDOWS_PROCESS_TREE_STOP_MAX_MS
    : TERMINATION_GRACE_MS + TERMINATION_CONFIRM_MS;

/** Time for the controller to record `cancelled` once the tree is gone. */
const TERMINATION_RECORD_SLACK_MS = 4_000;

/**
 * How long a waiter keeps waiting for the stopping controller after the owner announced
 * the handoff and then disappeared, before it reports the owner lost.
 *
 * The controller has no endpoint, so nothing shows whether it is still working. A healthy
 * one has recorded `cancelled`, or failed, once its own termination bound plus the record
 * slack has passed. When this lapses the waiter only reports the owner lost; it changes
 * no run state. A container removal slower than the slack also ends in that report.
 */
export const DETACHED_RUN_STOP_HANDOFF_GRACE_MS =
  DETACHED_RUN_TERMINATION_MAX_MS + TERMINATION_RECORD_SLACK_MS;
