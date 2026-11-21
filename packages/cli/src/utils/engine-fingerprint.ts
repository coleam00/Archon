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
