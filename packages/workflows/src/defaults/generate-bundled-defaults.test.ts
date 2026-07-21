/**
 * Regression tests for the untracked-file guard in
 * scripts/generate-bundled-defaults.ts (#1578).
 *
 * Drives the real script via spawnSync inside an isolated mkdtempSync git
 * repo (same pattern as .archon/scripts/__tests__/marketplace-fetch-source.test.ts),
 * pointed at the throwaway repo via the BUNDLED_DEFAULTS_REPO_ROOT test seam.
 */
import { describe, it, expect } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const SCRIPT = resolve(import.meta.dir, '../../../../scripts/generate-bundled-defaults.ts');
const OUTPUT_REL = 'packages/workflows/src/defaults/bundled-defaults.generated.ts';
const SENTINEL = '// sentinel — must not be overwritten when the guard trips\n';

function runGit(repoRoot: string, args: string[]): void {
  const result = spawnSync('git', args, { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr?.toString() ?? ''}`);
  }
}

/** Create a temp git repo with one tracked command + workflow default, committed. */
function createRepo(): string {
  const repoRoot = mkdtempSync(join(tmpdir(), 'bundled-defaults-test-'));
  mkdirSync(join(repoRoot, '.archon/commands/defaults'), { recursive: true });
  mkdirSync(join(repoRoot, '.archon/workflows/defaults'), { recursive: true });
  mkdirSync(join(repoRoot, 'packages/workflows/src/defaults'), { recursive: true });
  writeFileSync(join(repoRoot, '.archon/commands/defaults/tracked-command.md'), '# Tracked\n');
  writeFileSync(
    join(repoRoot, '.archon/workflows/defaults/tracked-workflow.yaml'),
    'name: tracked-workflow\n'
  );
  // Sentinel output file lets tests assert the bundle is untouched on failure.
  writeFileSync(join(repoRoot, OUTPUT_REL), SENTINEL);
  runGit(repoRoot, ['init']);
  runGit(repoRoot, ['add', '.']);
  runGit(repoRoot, [
    '-c',
    'user.email=test@example.com',
    '-c',
    'user.name=Test',
    'commit',
    '-m',
    'init',
  ]);
  return repoRoot;
}

function runScript(repoRoot: string): { exitCode: number; stderr: string } {
  const result = spawnSync('bun', [SCRIPT], {
    env: { ...process.env, BUNDLED_DEFAULTS_REPO_ROOT: repoRoot },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    exitCode: result.status ?? 1,
    stderr: result.stderr?.toString() ?? '',
  };
}

describe('generate-bundled-defaults: untracked-file guard (#1578)', () => {
  it('exits 0 and writes the bundle when all defaults are tracked', () => {
    const repoRoot = createRepo();
    try {
      const { exitCode, stderr } = runScript(repoRoot);
      expect(stderr).not.toContain('untracked');
      expect(exitCode).toBe(0);
      const output = readFileSync(join(repoRoot, OUTPUT_REL), 'utf-8');
      expect(output).toContain('tracked-command');
      expect(output).toContain('tracked-workflow');
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('exits 1 and leaves the bundle untouched for an untracked workflow default', () => {
    const repoRoot = createRepo();
    try {
      writeFileSync(
        join(repoRoot, '.archon/workflows/defaults/untracked-draft.yaml'),
        'name: untracked-draft\n'
      );
      const { exitCode, stderr } = runScript(repoRoot);
      expect(exitCode).toBe(1);
      expect(stderr).toContain('untracked files');
      expect(stderr).toContain('.archon/workflows/defaults/untracked-draft.yaml');
      // Remediation names the workflow-scoped destinations.
      expect(stderr).toContain('.archon/workflows/');
      expect(readFileSync(join(repoRoot, OUTPUT_REL), 'utf-8')).toBe(SENTINEL);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('exits 1 and leaves the bundle untouched for an untracked command default', () => {
    const repoRoot = createRepo();
    try {
      writeFileSync(join(repoRoot, '.archon/commands/defaults/untracked-draft.md'), '# Draft\n');
      const { exitCode, stderr } = runScript(repoRoot);
      expect(exitCode).toBe(1);
      expect(stderr).toContain('untracked files');
      expect(stderr).toContain('.archon/commands/defaults/untracked-draft.md');
      // Remediation names the command-scoped destinations, not workflows.
      expect(stderr).toContain('.archon/commands/ (project-scope)');
      expect(readFileSync(join(repoRoot, OUTPUT_REL), 'utf-8')).toBe(SENTINEL);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('exits 0 for a staged-but-uncommitted default (staged is not untracked)', () => {
    const repoRoot = createRepo();
    try {
      writeFileSync(
        join(repoRoot, '.archon/workflows/defaults/staged-draft.yaml'),
        'name: staged-draft\n'
      );
      runGit(repoRoot, ['add', '.archon/workflows/defaults/staged-draft.yaml']);
      const { exitCode, stderr } = runScript(repoRoot);
      expect(stderr).not.toContain('untracked');
      expect(exitCode).toBe(0);
      expect(existsSync(join(repoRoot, OUTPUT_REL))).toBe(true);
      expect(readFileSync(join(repoRoot, OUTPUT_REL), 'utf-8')).toContain('staged-draft');
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
