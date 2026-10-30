import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pruneScratch, scratchDir } from '../../workflows/sdlc/.shared/scratch';

function git(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

const home = process.cwd();
let root = '';

afterEach(() => {
  process.chdir(home);
  if (root) Bun.spawnSync(['git', '-c', 'core.longpaths=true', 'worktree', 'prune'], { cwd: join(root, 'repo') });
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('prune-scratch', () => {
  it('removes a scratch worktree whose installed files run past 260 characters', () => {
    root = mkdtempSync(join(tmpdir(), 'scratch-prune-'));
    const repo = join(root, 'repo');
    mkdirSync(repo);
    git(repo, 'init', '-q');
    git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
    const scratch = scratchDir(join(root, 'artifacts'), 'code');
    const tree = join(scratch, 'tree');
    mkdirSync(scratch, { recursive: true });
    git(repo, 'worktree', 'add', '-q', '--detach', tree);
    // A pnpm-shaped dependency tree, the shape that failed a mission-control lap (2026-10-25).
    let deep = join(tree, 'node_modules');
    while (deep.length < 300) deep = join(deep, 'node_modules_dir');
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(deep, 'index.js'), '');

    process.chdir(repo);
    expect(pruneScratch(scratch)).toHaveLength(1);
    expect(existsSync(scratch)).toBe(false);
  });
});
