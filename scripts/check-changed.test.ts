import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import {
  type ClassifierInputs,
  ROOT,
  type WorkspaceGraph,
  type ScopedChange,
  changeScope,
  changedFiles,
  lintInputs,
  lintPlan,
  scopedTypeChecks,
} from './check-changed';
import { REPO_ROOT } from './type-check';
import { workspaceTestInputs } from './should-run-test-suite';

// leaf -> mid -> base, and the root manifest depends on mid.
const graph: WorkspaceGraph = {
  directories: new Map([
    ['@x/base', 'packages/base'],
    ['@x/mid', 'packages/mid'],
    ['@x/leaf', 'packages/leaf'],
    ['@x/alone', 'packages/alone'],
    ['@x/site', 'packages/docs-web'],
  ]),
  dependsOn: new Map([
    ['@x/base', []],
    ['@x/mid', ['@x/base']],
    ['@x/leaf', ['@x/mid']],
    ['@x/alone', []],
    ['@x/site', []],
    [ROOT, ['@x/mid']],
  ]),
};

const inputs: ClassifierInputs = {
  packRunner: new Set(['scripts/repo-tests.ts']),
  workspaceTest: new Set(['scripts/package-tests.ts']),
};

function scoped(files: string[]) {
  const scope = changeScope(files, graph, inputs);
  if (scope.kind !== 'scoped') throw new Error(`expected a scoped result: ${scope.because}`);
  return scope;
}

describe('changeScope', () => {
  test('a leaf package checks only itself', () => {
    const scope = scoped(['packages/leaf/src/index.ts']);
    expect([...scope.packages]).toEqual([['@x/leaf', 'changed']]);
    expect(scope.rootScripts).toBe(false);
  });

  test('a package with dependents checks its reverse closure and root scripts', () => {
    const scope = scoped(['packages/base/src/index.ts']);
    expect(Object.fromEntries(scope.packages)).toEqual({
      '@x/base': 'changed',
      '@x/mid': 'depends on @x/base',
      '@x/leaf': 'depends on @x/mid',
    });
    expect(scope.rootScripts).toBe(true);
  });

  test('a root script no package reads checks root scripts only', () => {
    const scope = scoped(['scripts/lens-yield.ts']);
    expect(scope.packages.size).toBe(0);
    expect(scope.rootScripts).toBe(true);
  });

  test('a root script packages read checks every package', () => {
    expect(scoped(['scripts/package-tests.ts']).packages.size).toBe(5);
  });

  test('a pack file checks the pack and the root scripts that read it', () => {
    const scope = scoped(['.archon/workflows/sdlc/land/scripts/record.ts']);
    expect(scope.pack).toBe(true);
    expect(scope.rootScripts).toBe(true);
    expect(scope.packages.size).toBe(0);
  });

  test('prose checks nothing and is listed as unchecked', () => {
    const scope = scoped(['README.md']);
    expect(scope.packages.size).toBe(0);
    expect(scope.rootScripts || scope.pack).toBe(false);
    expect(scope.unchecked).toEqual(['README.md']);
  });

  test('code in the docs site checks that package; its Markdown pages stay prose', () => {
    const scope = scoped([
      'packages/docs-web/src/data/plugins.ts',
      'packages/docs-web/src/content/docs/guide.md',
    ]);
    expect([...scope.packages]).toEqual([['@x/site', 'changed']]);
    expect(scope.unchecked).toEqual(['packages/docs-web/src/content/docs/guide.md']);
  });

  test('the lockfile checks everything', () => {
    expect(changeScope(['bun.lock'], graph, inputs).kind).toBe('everything');
  });

  test('an unmapped root file checks everything and names the file', () => {
    const scope = changeScope(['packages/leaf/a.ts', 'Dockerfile'], graph, inputs);
    expect(scope.kind === 'everything' && scope.because.join()).toContain('Dockerfile');
  });
});

describe('lintPlan', () => {
  const fakeInputs = new Set([
    'scripts/check-mock-modules.ts',
    'scripts/mock-module-baseline.json',
  ]);
  const plan = (files: string[]) =>
    lintPlan(changeScope(files, graph, inputs), files, graph, fakeInputs);
  const runs = (files: string[]) =>
    Object.fromEntries(plan(files).steps.map(step => [step.id, step.run]));

  test('a leaf change scopes mock-modules to the leaf', () => {
    const lint = plan(['packages/leaf/src/index.ts']);
    const mock = lint.steps.find(step => step.id === 'check-mock-modules');
    expect(mock?.args.slice(-2)).toEqual(['--scope', 'packages/leaf']);
    expect(lint.wholeBecause).toEqual([]);
  });

  test('a scoped change scopes mock-modules to its dependents and the root scripts', () => {
    const mock = plan(['packages/base/src/index.ts']).steps.find(
      step => step.id === 'check-mock-modules'
    );
    expect(mock?.note).toBe('packages/base, packages/leaf, packages/mid, scripts');
  });

  test.each([
    ['a lint script', 'scripts/check-mock-modules.ts'],
    ['the mock.module() baseline', 'scripts/mock-module-baseline.json'],
    ['a package tsconfig', 'packages/leaf/tsconfig.json'],
  ])('%s runs every lint check whole', (_, file) => {
    const lint = plan(['packages/leaf/src/index.ts', file]);
    expect(lint.steps.every(step => step.run === 'whole')).toBe(true);
    expect(lint.wholeBecause).toEqual([`${file} is a lint input`]);
  });

  test('the lint inputs are the lint scripts, the root scripts they import and the baseline', () => {
    const real = lintInputs(REPO_ROOT, []);
    for (const file of [
      'scripts/lint.ts',
      'scripts/check-mock-modules.ts',
      'scripts/check-test-cleanup-drift.ts',
      'scripts/mock-module-baseline.json',
    ]) {
      expect(real.has(file)).toBe(true);
    }
    expect(real.has('scripts/check-changed.ts')).toBe(false);
  });

  test('a change that reaches everything runs every lint check whole', () => {
    expect(Object.values(runs(['bun.lock'])).every(run => run === 'whole')).toBe(true);
  });
});

describe('scopedTypeChecks', () => {
  // Real manifests: a package with a tsconfig joins the build, docs-web runs its own script.
  const packages = [
    { name: '@archon/core', path: 'packages/core' },
    { name: '@archon/docs-web', path: 'packages/docs-web', scripts: { 'type-check': 'x' } },
  ];
  const scope = (rootScripts: boolean, pack: boolean): ScopedChange => ({
    kind: 'scoped',
    packages: new Map(),
    rootScripts,
    pack,
    unchecked: [],
  });
  const projects = (rootScripts: boolean, pack: boolean) => {
    const [build, ...own] = scopedTypeChecks(scope(rootScripts, pack), packages);
    return {
      built: build.command.filter(argument => argument.endsWith('tsconfig.json')),
      own: own.map(task => task.name),
    };
  };

  test('builds the scoped packages, and runs a package with its own script after the build', () => {
    expect(projects(false, false)).toEqual({
      built: ['packages/core/tsconfig.json'],
      own: ['@archon/docs-web'],
    });
  });

  test('adds the root scripts project for root scripts and the pack project for the pack', () => {
    expect(projects(true, false).built).toEqual([
      'packages/core/tsconfig.json',
      'scripts/tsconfig.json',
    ]);
    expect(projects(false, true).built).toEqual([
      'packages/core/tsconfig.json',
      '.archon/workflows/tsconfig.json',
    ]);
  });
});

describe('changedFiles', () => {
  const trackTempRoot = trackTempRoots();

  function git(repo: string, ...args: string[]): void {
    const result = Bun.spawnSync(['git', ...args], { cwd: repo, stdout: 'pipe', stderr: 'pipe' });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  }

  test('reports committed, modified, deleted and untracked files since the merge base', () => {
    const repo = trackTempRoot(mkdtempSync(join(tmpdir(), 'check-changed-')));
    mkdirSync(join(repo, 'packages/a/src'), { recursive: true });
    writeFileSync(join(repo, 'packages/a/src/kept.ts'), 'export {};\n');
    writeFileSync(join(repo, 'packages/a/src/deleted.ts'), 'export {};\n');
    git(repo, 'init', '-q', '-b', 'base');
    git(repo, '-c', 'user.name=T', '-c', 'user.email=t@example.com', 'add', '.');
    git(repo, '-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-qm', 'base');
    git(repo, 'checkout', '-qb', 'work');
    writeFileSync(join(repo, 'packages/a/src/committed.ts'), 'export {};\n');
    git(repo, 'add', '.');
    git(repo, '-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-qm', 'work');
    writeFileSync(join(repo, 'packages/a/src/kept.ts'), 'export const changed = 1;\n');
    rmSync(join(repo, 'packages/a/src/deleted.ts'));
    writeFileSync(join(repo, 'packages/a/src/new.ts'), 'export {};\n');

    const { files } = changedFiles('base', repo);
    expect(files).toEqual([
      'packages/a/src/committed.ts',
      'packages/a/src/deleted.ts',
      'packages/a/src/kept.ts',
      'packages/a/src/new.ts',
    ]);
    // The deletion is still in the index; reading the classifier inputs must not trip on it.
    expect(() => workspaceTestInputs(repo, files)).not.toThrow();
  });
});
