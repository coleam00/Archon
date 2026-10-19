/**
 * Paths into the source checkout this build runs from: the bundled defaults,
 * the built web UI, and the provider and server entry points.
 */

import { join, dirname } from 'path';
import { access } from 'fs/promises';
import { createLogger } from './logger';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('archon-paths');
  return cachedLog;
}

/**
 * Root of the checkout this build runs from.
 *
 * This file is at packages/paths/src/source-tree-paths.ts, so the repo root is three
 * levels up from `import.meta.dir` (src → paths → packages → root). In Docker
 * that is /app.
 */
function getSourceRepoRoot(): string {
  return dirname(dirname(dirname(import.meta.dir)));
}

/**
 * Get the path to the app's base directory
 * This is where default commands/workflows are stored for copying to new repos
 *
 * In Docker: /app/.archon
 * Locally: {repo_root}/.archon
 */
export function getAppArchonBasePath(): string {
  return join(getSourceRepoRoot(), '.archon');
}

/**
 * Where a source checkout keeps its built web UI: the output of
 * `bun run build:web`. Owns that location for every consumer, so the CLI's
 * pre-flight check and the server's default cannot drift apart.
 *
 * A compiled binary has no checkout to build in and caches a downloaded copy
 * under `getWebDistDir(version)` instead.
 */
export function getSourceWebDistDir(): string {
  return join(getSourceRepoRoot(), 'packages', 'web', 'dist');
}

export function getSourceProviderEntry(id: string): string {
  return join(
    getSourceRepoRoot(),
    'packages',
    'providers',
    'src',
    ...(id === 'pi' ? ['community', 'pi'] : [id]),
    'plugin.ts'
  );
}

export function getSourceServerEntry(): string {
  return join(getSourceRepoRoot(), 'packages', 'server', 'src', 'bin.ts');
}

/**
 * The bundled packs root in a source checkout. Every bundled pack, with its
 * commands and scripts, lives in a folder beneath it.
 */
export function getBundledWorkflowsPath(): string {
  return join(getAppArchonBasePath(), 'workflows');
}

/**
 * Validate that the bundled packs root exists and is accessible (for startup).
 * Every bundled pack, with its commands and scripts, lives under it.
 */
export async function validateAppDefaultsPaths(): Promise<void> {
  const workflowsPath = getBundledWorkflowsPath();
  if (await checkPathAccessible(workflowsPath, 'workflows')) {
    getLog().info({ workflows: workflowsPath }, 'app_defaults_verified');
  }
}

/**
 * Check if a path is accessible, logging a warning if not.
 * Returns true if the path is accessible, false otherwise.
 */
async function checkPathAccessible(path: string, label: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      getLog().warn({ path }, `app_default_${label}_not_found`);
    } else {
      getLog().warn({ path, err, code: err.code }, `app_default_${label}_inaccessible`);
    }
    return false;
  }
}
