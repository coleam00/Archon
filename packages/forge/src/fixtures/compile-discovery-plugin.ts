import { copyFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Compile `discovery-plugin.ts` into `dir` and return the executable's path. Each suite that
 * needs a real forge executable compiles once through here and hard-links or copies the
 * result. The source is copied out of the repository first, so the build proves the fixture
 * resolves no Archon code.
 */
export function compileDiscoveryPlugin(dir: string): string {
  const entry = join(dir, 'fixture.ts');
  copyFileSync(join(import.meta.dir, 'discovery-plugin.ts'), entry);
  const outfile = join(dir, `fixture${process.platform === 'win32' ? '.exe' : ''}`);
  const built = Bun.spawnSync(
    [process.execPath, 'build', '--compile', entry, '--outfile', outfile],
    { cwd: dir, stdout: 'pipe', stderr: 'pipe' }
  );
  if (built.exitCode !== 0) throw new Error(built.stderr.toString());
  return outfile;
}
