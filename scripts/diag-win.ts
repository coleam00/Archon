// TEMPORARY diagnostic for Windows CLI test timeouts. Not for merge.
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const entry = join(import.meta.dir, '../packages/cli/src/cli.ts');
const archonHome = mkdtempSync(join(tmpdir(), 'diag-archon-home-'));
const sharedCache = mkdtempSync(join(tmpdir(), 'diag-bun-cache-'));

function run(
  label: string,
  extra: Record<string, string>,
  argv: string[] = ['workflow', 'list', '--json', '--cwd', tmpdir()]
): number {
  const start = performance.now();
  const r = Bun.spawnSync([process.execPath, entry, ...argv], {
    env: { ...process.env, ARCHON_TELEMETRY_DISABLED: '1', ARCHON_HOME: archonHome, ...extra },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const ms = Math.round(performance.now() - start);
  console.log(`${label}: ${ms}ms exit=${r.exitCode}`);
  return ms;
}

console.log(
  'USERPROFILE',
  process.env.USERPROFILE,
  'HOME',
  process.env.HOME,
  'XDG_CACHE_HOME',
  process.env.XDG_CACHE_HOME,
  'LOCALAPPDATA',
  process.env.LOCALAPPDATA
);
for (let i = 0; i < 3; i++) run(`inherited home #${i}`, {});
for (let i = 0; i < 3; i++) {
  const home = mkdtempSync(join(tmpdir(), 'diag-home-'));
  run(`fresh home #${i}`, { HOME: home, USERPROFILE: home });
  const found: string[] = [];
  for (const e of readdirSync(home, { recursive: true }) as string[]) found.push(e);
  console.log(`  fresh home #${i} entries: ${found.length} ${found.slice(0, 6).join(' | ')}`);
}
for (let i = 0; i < 4; i++) {
  const home = mkdtempSync(join(tmpdir(), 'diag-home-'));
  run(`fresh home + shared cache #${i}`, {
    HOME: home,
    USERPROFILE: home,
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: sharedCache,
  });
}
for (let i = 0; i < 2; i++) {
  const home = mkdtempSync(join(tmpdir(), 'diag-home-'));
  run(`fresh home, cache disabled #${i}`, {
    HOME: home,
    USERPROFILE: home,
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0',
  });
}
for (let i = 0; i < 2; i++)
  run(`inherited, cache disabled #${i}`, { BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' });

// Compiled-executable cost (Windows CI only: never compile on a Mac).
if (process.platform === 'win32') {
  const dir = mkdtempSync(join(tmpdir(), 'diag-compile-'));
  const script = join(dir, 'echo.js');
  writeFileSync(script, 'console.log("hi")');
  for (let i = 0; i < 2; i++) {
    const out = join(dir, `echo${i}.exe`);
    let s = performance.now();
    const b = Bun.spawnSync([process.execPath, 'build', '--compile', script, '--outfile', out], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    console.log(
      `compile #${i}: ${Math.round(performance.now() - s)}ms exit=${b.exitCode} ${b.stderr.toString().slice(0, 200)}`
    );
    for (let k = 0; k < 3; k++) {
      s = performance.now();
      const r = Bun.spawnSync([out], { stdout: 'pipe', stderr: 'pipe' });
      console.log(
        `  run compiled #${i}.${k}: ${Math.round(performance.now() - s)}ms exit=${r.exitCode}`
      );
    }
  }
}
