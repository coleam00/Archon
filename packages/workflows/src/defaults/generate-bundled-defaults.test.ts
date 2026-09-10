/**
 * Regression tests for the untracked-file guard in
 * scripts/generate-bundled-defaults.ts (#1578).
 *
 * Drives the real script via spawnSync inside an isolated mkdtempSync git
 * repo (same pattern as .archon/scripts/__tests__/marketplace-fetch-source.test.ts),
 * pointed at the throwaway repo via the BUNDLED_DEFAULTS_REPO_ROOT test seam.
 *
 * Fork-cost amortization: the expensive git init/add/commit template repo is
 * built ONCE per file; every scenario gets its own working copy via an
 * in-process recursive fs copy instead of a fresh git init/add/commit chain.
 * The positive scenarios (all-tracked, staged-but-uncommitted, packaged
 * embed) assert against one shared generator run because their expectations
 * are mutually compatible and none depends on a per-run process boundary.
 * The three negative scenarios stay in separate runs: they trip different
 * guards (workflows-defaults guard vs commands-defaults guard vs packaged
 * tracked-set check) whose failure messages land on stderr
 * nondeterministically if raced in parallel, so merging them would force
 * weaker assertions. All original assertions from the six-case suite are
 * preserved verbatim.
 */
import { describe, it, expect, afterAll } from 'bun:test';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import type { BundledScriptPack } from './bundled-script-pack';
import { removeTempTree } from '@archon/paths/test-utils';

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
function createTemplateRepo(): string {
  const repoRoot = mkdtempSync(join(tmpdir(), 'bundled-defaults-template-'));
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

let templateRepo: string | null = null;

/** Build the committed template repo lazily, exactly once for the whole file. */
function getTemplateRepo(): string {
  if (templateRepo === null) {
    templateRepo = createTemplateRepo();
  }
  return templateRepo;
}

afterAll(async () => {
  if (templateRepo !== null) {
    await removeTempTree(templateRepo);
    templateRepo = null;
  }
});

/** Cheap in-process clone of the committed template repo (no git spawns). */
function createRepo(): string {
  const repoRoot = mkdtempSync(join(tmpdir(), 'bundled-defaults-test-'));
  cpSync(getTemplateRepo(), repoRoot, { recursive: true });
  return repoRoot;
}

function runScript(repoRoot: string, args: string[] = []): { exitCode: number; stderr: string } {
  const result = spawnSync('bun', [SCRIPT, ...args], {
    env: { ...process.env, BUNDLED_DEFAULTS_REPO_ROOT: repoRoot },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    exitCode: result.status ?? 1,
    stderr: result.stderr?.toString() ?? '',
  };
}

describe('generate-bundled-defaults: untracked-file guard (#1578)', () => {
  it('exits 0 for tracked defaults, staged-but-uncommitted defaults, and embedded packaged workflows (single amortized run)', async () => {
    // One scenario covers what used to be three separate generator runs:
    //   - all tracked legacy defaults (positive path)
    //   - staged-but-uncommitted default (staged is not untracked)
    //   - packaged workflow with commands + scripts + owner metadata
    // Each set of assertions below is preserved verbatim from its origin case.
    const repoRoot = createRepo();
    try {
      // Staged-but-uncommitted default (previously its own case).
      writeFileSync(
        join(repoRoot, '.archon/workflows/defaults/staged-draft.yaml'),
        'name: staged-draft\n'
      );
      // Packaged workflow tree (previously its own case).
      const packageDir = join(repoRoot, '.archon/workflows/author-pack/release-flow');
      mkdirSync(join(packageDir, 'commands'), { recursive: true });
      mkdirSync(join(packageDir, 'scripts/helpers'), { recursive: true });
      writeFileSync(
        join(packageDir, 'release.yaml'),
        'name: release\ndescription: release\nnodes:\n  - id: run\n    command: prepare\n'
      );
      writeFileSync(join(packageDir, 'commands/prepare.md'), '# Prepare the release\n');
      writeFileSync(join(packageDir, 'scripts/publish.ts'), "console.log('published');\n");
      writeFileSync(join(packageDir, 'scripts/helpers/announce.py'), "print('announced')\n");
      // One git spawn stages both trees; nothing is committed after init.
      runGit(repoRoot, [
        'add',
        '.archon/workflows/defaults/staged-draft.yaml',
        '.archon/workflows/author-pack',
      ]);

      const { exitCode, stderr } = runScript(repoRoot);

      // Assertions from the former "all tracked" case.
      expect(stderr).not.toContain('untracked');
      expect(exitCode).toBe(0);
      const output = readFileSync(join(repoRoot, OUTPUT_REL), 'utf-8');
      expect(output).toContain('tracked-command');
      expect(output).toContain('tracked-workflow');

      // Assertions from the former "staged-but-uncommitted" case.
      expect(stderr).not.toContain('untracked');
      expect(exitCode).toBe(0);
      expect(existsSync(join(repoRoot, OUTPUT_REL))).toBe(true);
      expect(readFileSync(join(repoRoot, OUTPUT_REL), 'utf-8')).toContain('staged-draft');

      // Assertions from the former "packaged embed" case.
      expect(stderr).toBe('');
      expect(exitCode).toBe(0);
      const packagedOutput = readFileSync(join(repoRoot, OUTPUT_REL), 'utf-8');
      expect(packagedOutput).toContain('BUNDLED_WORKFLOW_OWNERS');
      expect(packagedOutput).toContain(
        '"release": {"pack":"author-pack","workflow":"release-flow"}'
      );
      expect(packagedOutput).toContain('__archon_pack__bundled:author-pack:release-flow::prepare');
      expect(packagedOutput).toContain('__archon_pack__bundled:author-pack:release-flow::publish');
      expect(packagedOutput).toContain('__archon_pack__bundled:author-pack:release-flow::announce');
      expect(packagedOutput).toContain('BUNDLED_SCRIPT_PACKS');
      const generated: { BUNDLED_SCRIPT_PACKS: Record<string, BundledScriptPack> } = await import(
        join(repoRoot, OUTPUT_REL)
      );
      const bundle = generated.BUNDLED_SCRIPT_PACKS['author-pack'];
      expect(bundle.scripts['__archon_pack__bundled:author-pack:release-flow::announce']).toEqual({
        path: 'release-flow/scripts/helpers/announce.py',
        runtime: 'uv',
      });
      expect(bundle.files['release-flow/scripts/helpers/announce.py']).toBe("print('announced')\n");
    } finally {
      await removeTempTree(repoRoot);
    }
  });

  it('exits 1 and leaves the bundle untouched for an untracked workflow default', async () => {
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
      await removeTempTree(repoRoot);
    }
  });

  it('exits 1 and leaves the bundle untouched for an untracked command default', async () => {
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
      await removeTempTree(repoRoot);
    }
  });

  it('embeds a tracked defaults/legacy/ workflow into the flat bundle (#2781)', async () => {
    const repoRoot = createRepo();
    try {
      const legacyDir = join(repoRoot, '.archon/workflows/defaults/legacy');
      mkdirSync(legacyDir, { recursive: true });
      writeFileSync(
        join(legacyDir, 'tracked-legacy-workflow.yaml'),
        'name: tracked-legacy-workflow\ndeprecated:\n  message: Switch instead.\n'
      );
      runGit(repoRoot, ['add', '.archon/workflows/defaults/legacy']);

      // `defaults/legacy` must NOT be misread as a packaged pack directory —
      // that failure mode exits 1 with "must contain exactly one .yaml".
      const { exitCode, stderr } = runScript(repoRoot);
      expect(stderr).toBe('');
      expect(exitCode).toBe(0);
      const output = readFileSync(join(repoRoot, OUTPUT_REL), 'utf-8');
      expect(output).toContain('"tracked-legacy-workflow"');
    } finally {
      await removeTempTree(repoRoot);
    }
  });

  it('rejects an untracked file inside a packaged workflow', async () => {
    const repoRoot = createRepo();
    try {
      const packageDir = join(repoRoot, '.archon/workflows/author-pack/release-flow');
      mkdirSync(packageDir, { recursive: true });
      writeFileSync(
        join(packageDir, 'release.yaml'),
        'name: release\ndescription: release\nnodes:\n  - id: run\n    prompt: hi\n'
      );

      const { exitCode, stderr } = runScript(repoRoot);
      expect(exitCode).toBe(1);
      expect(stderr).toContain('untracked files');
      expect(stderr).toContain('.archon/workflows/author-pack/release-flow/release.yaml');
      expect(readFileSync(join(repoRoot, OUTPUT_REL), 'utf-8')).toBe(SENTINEL);
    } finally {
      await removeTempTree(repoRoot);
    }
  });

  it('includes tracked shared modules, excludes nonmodules and runnable keys, and checks helper-only drift', async () => {
    const repoRoot = createRepo();
    try {
      const pack = join(repoRoot, '.archon/workflows/author-pack');
      mkdirSync(join(pack, '.shared/nested'), { recursive: true });
      mkdirSync(join(pack, '.shared/__pycache__'), { recursive: true });
      mkdirSync(join(pack, 'release/scripts/group/deeper'), { recursive: true });
      writeFileSync(join(pack, 'release/release.yaml'), 'name: release\n');
      writeFileSync(join(pack, 'release/scripts/group/main.ts'), 'console.log("ok");\n');
      writeFileSync(join(pack, 'release/scripts/group/deeper/ignored.ts'), 'ignored');
      writeFileSync(join(pack, '.shared/__init__.py'), '');
      writeFileSync(join(pack, '.shared/nested/helper.ts'), 'export const value = 1;\r\n');
      writeFileSync(join(pack, '.shared/nested/helper.js'), 'export const value = 2;\n');
      writeFileSync(join(pack, '.shared/__pycache__/helper.pyc'), 'bytecode');
      writeFileSync(join(pack, '.shared/data.json'), '{}');
      runGit(repoRoot, ['add', '.archon/workflows/author-pack']);
      expect(runScript(repoRoot)).toEqual({ exitCode: 0, stderr: '' });
      const generated: { BUNDLED_SCRIPT_PACKS: Record<string, BundledScriptPack> } = await import(
        join(repoRoot, OUTPUT_REL)
      );
      const bundle = generated.BUNDLED_SCRIPT_PACKS['author-pack'];
      expect(bundle.files).toEqual({
        '.shared/__init__.py': '',
        '.shared/nested/helper.ts': 'export const value = 1;\n',
        '.shared/nested/helper.js': 'export const value = 2;\n',
        'release/scripts/group/main.ts': 'console.log("ok");\n',
      });
      expect(Object.keys(bundle.scripts)).toEqual([
        '__archon_pack__bundled:author-pack:release::main',
      ]);
      expect(runScript(repoRoot, ['--check'])).toEqual({ exitCode: 0, stderr: '' });
      writeFileSync(join(pack, '.shared/nested/helper.ts'), 'export const value = 3;\n');
      const drift = runScript(repoRoot, ['--check']);
      expect(drift.exitCode).toBe(2);
      expect(drift.stderr).toContain('is stale');
    } finally {
      await removeTempTree(repoRoot);
    }
  });

  it('rejects an untracked shared module before writing the bundle', async () => {
    const repoRoot = createRepo();
    try {
      const shared = join(repoRoot, '.archon/workflows/author-pack/.shared/nested');
      mkdirSync(shared, { recursive: true });
      writeFileSync(join(shared, 'helper.py'), 'value = 1\n');
      const result = runScript(repoRoot);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('untracked files');
      expect(result.stderr).toContain('author-pack/.shared/nested/helper.py');
      expect(readFileSync(join(repoRoot, OUTPUT_REL), 'utf-8')).toBe(SENTINEL);
    } finally {
      await removeTempTree(repoRoot);
    }
  });

  it.skipIf(process.platform === 'win32').each(['file', 'dir'] as const)(
    'rejects a shared %s symlink instead of silently omitting it',
    async kind => {
      const repoRoot = createRepo();
      try {
        const shared = join(repoRoot, '.archon/workflows/author-pack/.shared');
        mkdirSync(shared, { recursive: true });
        const target = join(repoRoot, 'module-target');
        if (kind === 'dir') mkdirSync(target);
        else writeFileSync(target, 'export const value = 1;\n');
        const linked = join(shared, kind === 'dir' ? 'nested' : 'helper.ts');
        symlinkSync(target, linked, kind);
        runGit(repoRoot, ['add', '.archon/workflows/author-pack']);
        const result = runScript(repoRoot);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('Shared module symlinks are not supported');
        expect(result.stderr).toContain(linked);
        expect(readFileSync(join(repoRoot, OUTPUT_REL), 'utf-8')).toBe(SENTINEL);
      } finally {
        await removeTempTree(repoRoot);
      }
    }
  );
});
