import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RUN_ARTIFACTS_ENGINE_SUBDIR } from '@archon/paths';

export function bashScriptArgs(script: string, artifactsDir: string): string[] {
  // Stay below per-argument OS limits even when substitutions contain large newline suffixes.
  if (Buffer.byteLength(script, 'utf8') <= 32_768) return ['-c', script];

  const hash = createHash('sha256').update(script, 'utf8').digest('hex');
  const dir = join(artifactsDir, RUN_ARTIFACTS_ENGINE_SUBDIR, 'bash-scripts');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${hash}.sh`);
  writeFileSync(path, script);
  return [path];
}
