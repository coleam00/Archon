import { describe, expect, it } from 'bun:test';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { removeTempTree, testTimeout, DEFAULT_TEST_TIMEOUT_MS } from '@archon/paths/test-utils';
import { TEST_TRANSPILER_CACHE, bunTestCommand, bunTestEnv } from './bun-test-command';

describe('bunTestCommand', () => {
  it('sets the default per-test budget to 20 seconds', () => {
    expect(bunTestCommand(['src/a.test.ts'])).toEqual([
      'bun',
      'test',
      '--timeout',
      String(DEFAULT_TEST_TIMEOUT_MS),
      'src/a.test.ts',
    ]);
  });

  it('forwards selectors and flags verbatim after the budget', () => {
    expect(bunTestCommand(['--bail', 'logger'])).toEqual([
      'bun',
      'test',
      '--timeout',
      String(DEFAULT_TEST_TIMEOUT_MS),
      '--bail',
      'logger',
    ]);
  });
});

describe('testTimeout', () => {
  it('lifts small explicit budgets to the default and preserves larger budgets', () => {
    expect(testTimeout(10_000)).toBe(DEFAULT_TEST_TIMEOUT_MS);
    expect(testTimeout(DEFAULT_TEST_TIMEOUT_MS + 1)).toBe(DEFAULT_TEST_TIMEOUT_MS + 1);
  });
});

describe('bunTestEnv', () => {
  it('disables telemetry unless the caller chose explicitly', () => {
    expect(bunTestEnv({}).ARCHON_TELEMETRY_DISABLED).toBe('1');
    expect(bunTestEnv({ ARCHON_TELEMETRY_DISABLED: '' }).ARCHON_TELEMETRY_DISABLED).toBe('');
    expect(bunTestEnv({ PATH: '/bin' }).PATH).toBe('/bin');
  });

  it('pins the transpiler cache so a child given its own home starts warm', async () => {
    expect(bunTestEnv({}).BUN_RUNTIME_TRANSPILER_CACHE_PATH).toBe(TEST_TRANSPILER_CACHE);
    expect(
      bunTestEnv({ BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' }).BUN_RUNTIME_TRANSPILER_CACHE_PATH
    ).toBe('0');

    // Without the pin Bun derives the cache from the home, so a child with a scratch
    // home would write `.bun/install/cache` (Windows) or `.cache`/`Library` into it.
    const home = await mkdtemp(join(tmpdir(), 'archon-transpiler-home-'));
    try {
      // Bun caches only outputs above a size floor, so transpile a large module.
      const big = join(home, '..', `${basename(home)}-big.ts`);
      await writeFile(big, `export const x: number[] = [${'1,'.repeat(40_000)}];\n`);
      try {
        const { BUN_RUNTIME_TRANSPILER_CACHE_PATH: _, ...inherited } = process.env;
        const child = Bun.spawnSync([process.execPath, big], {
          env: { ...bunTestEnv(inherited), HOME: home, USERPROFILE: home },
        });
        expect(child.exitCode).toBe(0);
        expect(await readdir(home)).toEqual([]);
      } finally {
        await rm(big, { force: true });
      }
    } finally {
      await removeTempTree(home);
    }
  });
});

describe('every bun test entry point preloads the telemetry opt-out', () => {
  it('the repo root and every package with tests preload scripts/test-telemetry-off.ts', async () => {
    const { readdir, readFile } = await import('node:fs/promises');
    const { existsSync } = await import('node:fs');
    const { join } = await import('node:path');
    const repoRoot = join(import.meta.dir, '..');
    const configs = [{ dir: repoRoot, preload: './scripts/test-telemetry-off.ts' }];
    for (const name of await readdir(join(repoRoot, 'packages'))) {
      const dir = join(repoRoot, 'packages', name);
      const manifest = join(dir, 'package.json');
      if (!existsSync(manifest)) continue;
      const declaration = JSON.parse(await readFile(manifest, 'utf8'));
      if (declaration.scripts?.test !== 'bun run ../../scripts/package-tests.ts') continue;
      configs.push({ dir, preload: '../../scripts/test-telemetry-off.ts' });
    }
    expect(configs.some(({ dir }) => dir === join(repoRoot, 'packages', 'core'))).toBe(true);
    const missing: string[] = [];
    for (const { dir, preload } of configs) {
      const bunfig = join(dir, 'bunfig.toml');
      // Bun reads bunfig.toml from the cwd only; a package without this preload lets
      // a direct `bun test <file>` there send live events with the embedded key.
      if (!existsSync(bunfig) || !(await readFile(bunfig, 'utf8')).includes(`"${preload}"`))
        missing.push(dir.slice(repoRoot.length + 1) || '.');
    }
    expect(missing).toEqual([]);
  });
});

describe('every runner assembles its command through bunTestCommand', () => {
  it('no runner script spells out a bun test command by hand', async () => {
    const { readdir, readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const offenders: string[] = [];
    for (const entry of await readdir(import.meta.dir)) {
      if (!entry.endsWith('.ts') || entry.endsWith('.test.ts') || entry === 'bun-test-command.ts')
        continue;
      const source = await readFile(join(import.meta.dir, entry), 'utf8');
      if (/\[\s*'bun'\s*,\s*'test'/.test(source)) offenders.push(entry);
      // A runner that spawns tests without bunTestEnv lets them send telemetry.
      if (source.includes('bunTestCommand(') && !source.includes('env: bunTestEnv()'))
        offenders.push(`${entry} (env)`);
    }
    // A hand-built command on any runner path silently drops the default budget for that path.
    expect(offenders).toEqual([]);
  });
});
