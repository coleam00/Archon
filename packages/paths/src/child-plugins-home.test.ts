/**
 * A child Archon process reads plugins from the same home as the parent that spawned
 * it. Real processes, because the process boundary is the subject: the parent loads a
 * repository `.archon/.env`, then spawns a child the way the detached-run and trigger
 * paths do.
 */
import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { removeTempTree } from './test-utils';

const stripBootUrl = pathToFileURL(join(import.meta.dir, 'strip-cwd-env-boot.ts')).href;
const indexUrl = pathToFileURL(join(import.meta.dir, 'index.ts')).href;

/**
 * - `inherit`: the child gets the parent's env unchanged (detached control commands,
 *   CLI calls from workflow scripts).
 * - `trigger`: `trigger execute` sets ARCHON_HOME to the parent's resolved home.
 * - `detached`: a `--detach` run passes its install context and the payload flag, and
 *   the child restores that context after loading env, as the CLI does.
 */
type SpawnShape = 'inherit' | 'trigger' | 'detached';

async function pluginsDirs(shape: SpawnShape): Promise<{ parent: string; child: string }> {
  const root = mkdtempSync(join(tmpdir(), 'archon-child-plugins-'));
  const repo = join(root, 'repo');
  const home = join(root, 'home');
  mkdirSync(join(repo, '.archon'), { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(repo, '.archon', '.env'), 'ARCHON_CHILD_TEST_REPO_KEY=1\n');
  const child = join(root, 'child.ts');
  writeFileSync(
    child,
    `import '${stripBootUrl}';\n` +
      `import { captureDetachedInstallContext, getPluginsPath, loadArchonEnv, restoreDetachedInstallContext } from '${indexUrl}';\n` +
      "const gated = process.argv.includes('--internal-detached-run-config');\n" +
      'const inherited = gated ? captureDetachedInstallContext() : undefined;\n' +
      'loadArchonEnv(process.cwd());\n' +
      'if (inherited) restoreDetachedInstallContext(inherited);\n' +
      'process.stdout.write(getPluginsPath());\n'
  );
  const parent = join(root, 'parent.ts');
  writeFileSync(
    parent,
    `import '${stripBootUrl}';\n` +
      "import { spawnSync } from 'node:child_process';\n" +
      `import { captureDetachedInstallContext, getArchonHome, getPluginsPath, loadArchonEnv } from '${indexUrl}';\n` +
      'loadArchonEnv(process.cwd());\n' +
      `const shape = ${JSON.stringify(shape)};\n` +
      'const env = { ...process.env };\n' +
      "if (shape === 'trigger') env.ARCHON_HOME = getArchonHome();\n" +
      "if (shape === 'detached') Object.assign(env, captureDetachedInstallContext(), { ARCHON_HOME: getArchonHome() });\n" +
      "const args = shape === 'detached' ? ['--internal-detached-run-config', 'placeholder'] : [];\n" +
      `const result = spawnSync(process.execPath, [${JSON.stringify(child)}, ...args], { cwd: process.cwd(), encoding: 'utf8', env });\n` +
      'process.stderr.write(result.stderr);\n' +
      'process.stdout.write(JSON.stringify({ parent: getPluginsPath(), child: result.stdout }));\n' +
      'process.exitCode = result.status ?? 1;\n'
  );
  try {
    const result = spawnSync(process.execPath, [parent], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, ARCHON_HOME: home },
    });
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
    const dirs = JSON.parse(result.stdout) as { parent: string; child: string };
    expect(dirs.parent).toBe(join(home, 'plugins'));
    return dirs;
  } finally {
    await removeTempTree(root);
  }
}

describe('plugins home across a spawned Archon child', () => {
  for (const shape of ['inherit', 'trigger', 'detached'] as const) {
    it(`a ${shape} child reads plugins from the parent's home`, async () => {
      const { parent, child } = await pluginsDirs(shape);
      expect(child).toBe(parent);
    });
  }
});
