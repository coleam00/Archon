import { WINDOWS_PROCESS_TREE_STOP_MAX_MS } from '@archon/paths/windows-process-tree';

export const TERMINATION_GRACE_MS = 5_000;
export const TERMINATION_CONFIRM_MS = 1_000;

export const HOST_NODE_TERMINATION_MAX_MS =
  (process.platform === 'win32' ? WINDOWS_PROCESS_TREE_STOP_MAX_MS : TERMINATION_GRACE_MS) +
  TERMINATION_CONFIRM_MS;
