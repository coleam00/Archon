import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The bundled packs' deterministic scripts are validated where they live:
 * `.archon/workflows/tsconfig.json` is the owning configuration and `bun run
 * type-check` compiles that project. Lint covers the whole `.archon/workflows`
 * tree, so it cannot miss a script. Type-check can: a pack script placed somewhere
 * the tsconfig globs do not reach would simply go untype-checked, with nothing
 * failing. This is that check, and it is repository tooling, not engine behaviour:
 * the engine never learns which packs exist.
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
  it('type-checks every tracked pack script', () => {
    expect(includedByOwningProject()).toEqual(trackedPackScripts());
  });

  it('has scripts to validate at all', () => {
    // Guards the check above against passing by matching nothing against nothing.
    expect(trackedPackScripts().length).toBeGreaterThan(0);
  });
});
