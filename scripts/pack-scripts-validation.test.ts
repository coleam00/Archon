import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The bundled packs' deterministic scripts are validated where they live:
 * `.archon/workflows/tsconfig.json` is the owning configuration, `bun run
 * type-check` compiles that project, and eslint.config.mjs and scripts/lint.ts
 * derive their globs from its `include` rather than restating them. What no config
 * can notice on its own is a pack script placed somewhere the globs do not reach;
 * it would simply go unchecked, with nothing failing. This is that check, and it is
 * repository tooling, not engine behaviour: the engine never learns which packs
 * exist.
 */
const REPO_ROOT = join(import.meta.dir, '..');
const PACKS_ROOT = join(REPO_ROOT, '.archon', 'workflows');
const PACK_TSCONFIG = join(PACKS_ROOT, 'tsconfig.json');

function trackedPackScripts(): string[] {
  const listed = Bun.spawnSync(['git', 'ls-files', '-z', '--', '.archon/workflows'], {
    cwd: REPO_ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (listed.exitCode !== 0) {
    throw new Error(`git ls-files failed: ${listed.stderr.toString().trim()}`);
  }
  return listed.stdout
    .toString()
    .split('\0')
    .filter(path => path.endsWith('.ts'))
    .map(path => path.slice('.archon/workflows/'.length))
    .sort();
}

function includedByOwningProject(): string[] {
  const include = (JSON.parse(readFileSync(PACK_TSCONFIG, 'utf-8')) as { include: string[] })
    .include;
  const matched = new Set<string>();
  for (const pattern of include) {
    for (const path of new Bun.Glob(pattern).scanSync({ cwd: PACKS_ROOT, dot: true })) {
      matched.add(path.split('\\').join('/'));
    }
  }
  return [...matched].sort();
}

describe('workflow pack scripts are validated where they live', () => {
  it('selects the same script family for type-check, lint and execution', () => {
    expect(includedByOwningProject()).toEqual(trackedPackScripts());
  });

  it('has scripts to validate at all', () => {
    // Guards the check above against passing by matching nothing against nothing.
    expect(trackedPackScripts().length).toBeGreaterThan(0);
  });
});
