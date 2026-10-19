import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { writeEngineFile } from './engine-file';

export function bashScriptArgs(script: string, artifactsDir: string): string[] {
  // Stay below per-argument OS limits even when substitutions contain large newline suffixes.
  if (Buffer.byteLength(script, 'utf8') <= 32_768) return ['-c', script];

  const hash = createHash('sha256').update(script, 'utf8').digest('hex');
  const path = writeEngineFile(artifactsDir, join('bash-scripts', `${hash}.sh`), script);
  return [path];
}
