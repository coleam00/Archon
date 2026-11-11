/**
 * Delivers the `archon:script` module to a Bun script's process. The engine starts the
 * script with `--preload=<file>`; the file registers one virtual module whose source is
 * a string inside it. Nothing else the script imports resolves differently, the flag is
 * argv so a process the script starts does not inherit it, and a pack needs no file of
 * its own and no node_modules.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RUN_ARTIFACTS_ENGINE_SUBDIR } from '@archon/paths';
import type { ScriptRuntime } from '../script-discovery';
import { scriptApiModuleSource } from '@archon/script-api/text';

export { scriptApiDeclaration } from '@archon/script-api/text';

const PRELOAD = `import { plugin } from 'bun';
plugin({
  name: 'archon-script',
  setup(build) {
    build.module('archon:script', () => ({ contents: ${JSON.stringify(scriptApiModuleSource)}, loader: 'ts' }));
  },
});
`;
const PRELOAD_FILE = `preload-${createHash('sha256').update(PRELOAD).digest('hex').slice(0, 16)}.ts`;

/**
 * The preload file for a script of `runtime` in this run, written on first use; undefined
 * for a runtime that cannot import the module.
 *
 * It lives in the engine's part of the run's artifact directory, which a container run
 * mounts at the same path, so the same argv works on both sides of that boundary. The
 * name carries the content's hash and the file arrives by rename, so parallel nodes and
 * a resumed run under another Archon version never read a partial or foreign copy.
 */
export function scriptApiPreload(runtime: ScriptRuntime, artifactsDir: string): string | undefined {
  if (runtime !== 'bun') return undefined;
  const dir = join(artifactsDir, RUN_ARTIFACTS_ENGINE_SUBDIR, 'script-api');
  const path = join(dir, PRELOAD_FILE);
  if (existsSync(path)) return path;
  mkdirSync(dir, { recursive: true });
  const temp = join(dir, `${PRELOAD_FILE}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, PRELOAD, { flag: 'wx' });
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
  return path;
}
