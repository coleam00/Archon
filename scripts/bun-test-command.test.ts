import { describe, expect, it } from 'bun:test';
import { bunTestCommand, bunTestEnv, WINDOWS_TEST_TIMEOUT_MS } from './bun-test-command';

describe('bunTestCommand', () => {
  it('widens the default per-test budget on Windows only', () => {
    expect(bunTestCommand(['src/a.test.ts'], 'win32')).toEqual([
      'bun',
      'test',
      '--timeout',
      String(WINDOWS_TEST_TIMEOUT_MS),
      'src/a.test.ts',
    ]);
    expect(bunTestCommand(['src/a.test.ts'], 'linux')).toEqual(['bun', 'test', 'src/a.test.ts']);
    expect(bunTestCommand(['src/a.test.ts'], 'darwin')).toEqual(['bun', 'test', 'src/a.test.ts']);
  });

  it('forwards selectors and flags verbatim after the budget', () => {
    expect(bunTestCommand(['--bail', 'logger'], 'win32')).toEqual([
      'bun',
      'test',
      '--timeout',
      String(WINDOWS_TEST_TIMEOUT_MS),
      '--bail',
      'logger',
    ]);
  });
});

describe('bunTestEnv', () => {
  it('disables telemetry unless the caller chose explicitly', () => {
    expect(bunTestEnv({}).ARCHON_TELEMETRY_DISABLED).toBe('1');
    expect(bunTestEnv({ ARCHON_TELEMETRY_DISABLED: '' }).ARCHON_TELEMETRY_DISABLED).toBe('');
    expect(bunTestEnv({ PATH: '/bin' }).PATH).toBe('/bin');
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
      if (!('testGroups' in JSON.parse(await readFile(manifest, 'utf8')))) continue;
      configs.push({ dir, preload: '../../scripts/test-telemetry-off.ts' });
    }
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
    // A hand-built command on any runner path silently drops the Windows budget for that path.
    expect(offenders).toEqual([]);
  });
});
