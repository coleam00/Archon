/**
 * `archon script types` and `archon script preload`: each writes the text the engine
 * embeds, and check mode notices a missing or edited file without touching it. The
 * written preload makes `archon:script` importable in a Bun process the engine did not start.
 */
import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { scriptApiDeclaration, scriptApiPreloadSource } from '@archon/workflows/script-api';
import { scriptPreloadCommand, scriptTypesCommand } from './script-types';

const trackTempRoot = trackTempRoots();

test('writes the embedded declaration, and check mode exits 1 for a missing or edited file', async () => {
  const root = trackTempRoot(realpathSync(mkdtempSync(join(tmpdir(), 'archon-script-types-'))));
  const path = join(root, 'types', 'archon-script.d.ts');
  const run = (check: boolean): Promise<number> =>
    scriptTypesCommand(root, { out: 'types/archon-script.d.ts', check, json: true });

  expect(await run(true)).toBe(1);
  expect(() => readFileSync(path)).toThrow();
  expect(await run(false)).toBe(0);
  expect(readFileSync(path, 'utf8')).toBe(scriptApiDeclaration);
  expect(scriptApiDeclaration).toContain("declare module 'archon:script'");
  expect(await run(true)).toBe(0);

  const stale = scriptApiDeclaration.replace("'pr.view'", "'pr.look'");
  writeFileSync(path, stale);
  expect(await run(true)).toBe(1);
  expect(readFileSync(path, 'utf8')).toBe(stale);
});

test('writes the engine preload, needs --out, and check mode exits 1 for a missing or edited file', async () => {
  const root = trackTempRoot(realpathSync(mkdtempSync(join(tmpdir(), 'archon-script-preload-'))));
  const path = join(root, 'test', 'archon-script.preload.ts');
  const run = (check: boolean): Promise<number> =>
    scriptPreloadCommand(root, { out: 'test/archon-script.preload.ts', check, json: true });

  expect(await scriptPreloadCommand(root, {})).toBe(1);
  expect(await run(true)).toBe(1);
  expect(await run(false)).toBe(0);
  expect(readFileSync(path, 'utf8')).toBe(scriptApiPreloadSource);
  expect(scriptApiPreloadSource).not.toContain('\r');
  expect(await run(true)).toBe(0);

  writeFileSync(path, `${scriptApiPreloadSource}// edited\n`);
  expect(await run(true)).toBe(1);
});

test('a script run with the written preload imports archon:script outside a run', async () => {
  // Away from the repository, so nothing but the preload can resolve the module.
  const root = trackTempRoot(realpathSync(mkdtempSync(join(tmpdir(), 'archon-script-preload-'))));
  expect(await scriptPreloadCommand(root, { out: 'preload.ts', json: true })).toBe(0);
  const script = "import { input } from 'archon:script';\nconsole.log(input('greeting'));\n";
  writeFileSync(join(root, 'script.ts'), script);
  const env = { ...process.env, INPUTS_GREETING: 'hello' };

  const run = (preload: string[]) =>
    Bun.spawnSync([process.execPath, ...preload, 'script.ts'], {
      cwd: root,
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    });

  const withPreload = run(['--preload', join(root, 'preload.ts')]);
  expect(withPreload.stderr.toString()).toBe('');
  expect(withPreload.stdout.toString()).toBe('hello\n');
  expect(run([]).exitCode).not.toBe(0);
});
