import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import {
  type ClassifierInputs,
  ROOT,
  type WorkspaceGraph,
  changeScope,
  changedFiles,
} from './check-changed';
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

  test('a pack file checks the pack and the root scripts that import it', () => {
    const scope = scoped(['.archon/scripts/x.ts']);
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
