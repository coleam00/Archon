import { createLogger } from '@archon/paths';
import type { MergedConfig } from '@archon/core';

export interface CheckResult {
  label: string;
  /**
   * `warn` is a defect the operator should see that is not a failure: the
   * install works, but something about it is wrong or worth knowing. It does
   * not count toward the exit code.
   */
  status: 'pass' | 'warn' | 'fail' | 'skip';
  message: string;
}

let cachedLog: ReturnType<typeof createLogger> | undefined;
export function doctorLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('cli.doctor');
  return cachedLog;
}

export async function loadMergedConfig(cwd: string): Promise<MergedConfig> {
  // Lazy import so doctor doesn't pull the full @archon/core graph for an
  // unrelated check.
  const { loadConfig } = await import('@archon/core');
  return loadConfig(cwd);
}
