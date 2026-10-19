import { randomUUID } from 'node:crypto';
import { join as joinPath } from 'path';
import {
  ArtifactWriteError,
  isProtectedArtifactPath,
  writeArtifactFileSync,
} from '../artifact-writes';
import { RUN_ARTIFACTS_ENGINE_SUBDIR } from '@archon/paths';
import { getLog } from './log';
import { NODE_OUTPUT_FILE_THRESHOLD } from './node-output';

/**
 * Single-quote a string for safe inline shell use.
 * Replaces each ' with '\'' (end quote, literal single-quote, re-open quote).
 */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Write `value` to `<dir>/<filename>`, creating `dir` as needed. Returns the full
 * path on success, or `undefined` after logging on any failure (permission, disk
 * space, etc.). Separated container writes fail instead of falling back.
 */
export function writeSpillFile(dir: string, filename: string, value: string): string | undefined {
  const filePath = joinPath(dir, filename);
  try {
    writeArtifactFileSync(filePath, value);
    return filePath;
  } catch (fileErr) {
    const err = fileErr as Error;
    getLog().error(
      { err, dir, filename, valueSize: value.length, filePath },
      'dag.spill_file_write_failed'
    );
    if (fileErr instanceof ArtifactWriteError || isProtectedArtifactPath(filePath)) throw fileErr;
    return undefined;
  }
}

/**
 * Shell-quote a value for bash, or write it under the run artifact directory's
 * engine-owned spill child and return a $(cat ...) reference when the value exceeds
 * the inline size threshold.
 */
export function shellQuoteOrFile(
  value: string,
  nodeId: string,
  field: string | undefined,
  artifactsDir: string | undefined
): string {
  if (artifactsDir && value.length > NODE_OUTPUT_FILE_THRESHOLD) {
    const spillDir = joinPath(artifactsDir, RUN_ARTIFACTS_ENGINE_SUBDIR, 'node-output-spills');
    // Unique per write: $X.output and $LOOP_PREV.X.output in one script must not share a file.
    const filename = `${randomUUID()}.${nodeId}${field ? `.${field}` : ''}.nodeoutput`;
    const filePath = writeSpillFile(spillDir, filename, value);
    if (filePath) return `$(cat ${shellQuote(filePath)})`;
    return shellQuote(value); // fallback: inline (pre-file-spill behavior)
  }
  return shellQuote(value);
}
