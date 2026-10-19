import { createHash } from 'node:crypto';
import { join as joinPath } from 'path';
import { mkdirSync, writeFileSync } from 'fs';
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
 * space, etc.) — callers own their own fallback; this never throws.
 */
export function writeSpillFile(dir: string, filename: string, value: string): string | undefined {
  const filePath = joinPath(dir, filename);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, value);
    return filePath;
  } catch (fileErr) {
    const err = fileErr as Error;
    getLog().error(
      { err, dir, filename, valueSize: Buffer.byteLength(value, 'utf8'), filePath },
      'dag.spill_file_write_failed'
    );
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
    // Bash reads these files after all references resolve; distinct values must not overwrite.
    const contentHash = createHash('sha256').update(value, 'utf8').digest('hex');
    const spillDir = joinPath(
      artifactsDir,
      RUN_ARTIFACTS_ENGINE_SUBDIR,
      'node-output-spills',
      contentHash
    );
    const filename = field ? `${nodeId}.${field}.nodeoutput` : `${nodeId}.nodeoutput`;
    const filePath = writeSpillFile(spillDir, filename, value);
    if (filePath) return `$(cat ${shellQuote(filePath)})`;
    return shellQuote(value); // fallback: inline (pre-file-spill behavior)
  }
  return shellQuote(value);
}
