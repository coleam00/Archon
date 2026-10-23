import { access } from 'fs/promises';
import { basename, join } from 'path';
import { createLogger, getProjectRoot, sanitizeScopeSegment } from '@archon/paths';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('workflow.state-migration');
  return cachedLog;
}

const warnedCwds = new Set<string>();

/**
 * Warn once per working directory when legacy `_cwd/<basename>` storage exists.
 * Legacy cwd storage has ambiguous ownership; never migrate it or read it as a fallback.
 */
export async function maybeWarnLegacyCwdStoragePath(cwd: string, newRoot: string): Promise<void> {
  if (warnedCwds.has(cwd)) return;
  const legacyPath = getProjectRoot('_cwd', sanitizeScopeSegment(basename(cwd)));
  try {
    await access(legacyPath);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') return;
    if (warnedCwds.has(cwd)) return;
    warnedCwds.add(cwd);
    getLog().warn({ err, legacyPath }, 'workflow.legacy_cwd_storage_probe_error');
    return;
  }
  if (warnedCwds.has(cwd)) return;
  warnedCwds.add(cwd);
  getLog().warn(
    {
      legacyPath,
      newPath: newRoot,
      message:
        `Legacy unregistered-directory output remains at ${legacyPath}. ` +
        'It may contain data from multiple directories with the same name. Nothing was moved or copied. ' +
        `Inspect ${join(legacyPath, 'state')} and manually move only state belonging to this directory ` +
        `into ${join(newRoot, 'state')}. New runs do not read the legacy tree.`,
    },
    'workflow.legacy_cwd_storage_detected'
  );
}
