import { createLogger } from '@archon/paths';

/** Lazy-initialized logger */
let cachedLog: ReturnType<typeof createLogger> | undefined;
export function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('workflow.validator');
  return cachedLog;
}
