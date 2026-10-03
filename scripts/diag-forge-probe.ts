// Throwaway diagnostic (diag branch only): phase timings of compiling and running the
// forge external-plugin fixture on this runner, in two temp locations.
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const fixture = join(import.meta.dir, '..', 'packages', 'forge', 'src', 'fixtures', 'external-plugin.ts');
const bases = [['tmpdir', tmpdir()], ['runner_temp', process.env.RUNNER_TEMP ?? tmpdir()]] as const;
const time = (fn: () => void): number => { const t = performance.now(); fn(); return performance.now() - t; };
for (let i = 0; i < 3; i++) {
  for (const [label, base] of bases) {
    const dir = mkdtempSync(join(base, 'forge-probe-'));
    const exe = join(dir, `archon-forge-probe${process.platform === 'win32' ? '.exe' : ''}`);
    const compile = time(() => {
      const r = Bun.spawnSync([process.execPath, 'build', '--compile', fixture, '--outfile', exe], { stdout: 'pipe', stderr: 'pipe' });
      if (r.exitCode !== 0) throw new Error(r.stderr.toString());
    });
    const size = statSync(exe).size;
    const runs = [0, 1, 2].map(() => time(() => {
      const r = Bun.spawnSync([exe, 'metadata'], { stdout: 'pipe', stderr: 'pipe', env: { PATH: process.env.PATH ?? '' } });
      if (r.exitCode !== 0) throw new Error(`exit ${String(r.exitCode)}`);
    }));
    const bunRun = time(() => { Bun.spawnSync([process.execPath, fixture, 'metadata'], { stdout: 'pipe', stderr: 'pipe' }); });
    const remove = time(() => rmSync(dir, { recursive: true, force: true }));
    console.log(`FORGE_PROBE iter=${String(i)} ${label} size=${String(size)} compile=${compile.toFixed(0)} run=${runs.map(r => r.toFixed(0)).join('/')} bunScript=${bunRun.toFixed(0)} rm=${remove.toFixed(0)}`);
  }
}
