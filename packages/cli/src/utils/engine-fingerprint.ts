import { statSync } from 'node:fs';
import { BUNDLED_IS_BINARY } from '@archon/paths';
import { readSourceCommit } from '@archon/paths/source-commit';

/**
 * Names the Archon engine installed right now. A resident process keeps the
 * engine it loaded at start, so comparing this with its start value tells it
 * the install moved on. A compiled binary is named by its file identity: an
 * upgrade replaces or rewrites the file, while `BUNDLED_GIT_COMMIT` is a
 * compile-time constant that never changes in a running process. A source
 * install is named by the commit of the checkout this file sits in.
 * Undefined when neither can be read.
 */
export function engineFingerprint(): string | undefined {
  if (!BUNDLED_IS_BINARY) return readSourceCommit(import.meta.dir);
  try {
    const file = statSync(process.execPath);
    return `${file.dev}:${file.ino}:${file.size}:${file.mtimeMs}`;
  } catch {
    return undefined;
  }
}

// The engine this process loaded, recorded once at start; null until recorded.
let loadedEngine: string | undefined | null = null;

/**
 * Record the engine this process loaded. Called when a CLI workflow host is built, before
 * any run executes, so a run that ends after an update compares against the code it runs.
 */
export function recordLoadedEngine(): void {
  if (loadedEngine === null) loadedEngine = engineFingerprint();
}

/**
 * Whether the installed engine is no longer the one this process loaded. False when the
 * loaded engine could not be named: the process cannot tell, so it acts as before. A
 * binary deleted by its upgrade (Homebrew removes the old version) names no engine now,
 * which counts as changed.
 */
export function engineChangedSinceLoad(): boolean {
  return (
    loadedEngine !== null && loadedEngine !== undefined && engineFingerprint() !== loadedEngine
  );
}
