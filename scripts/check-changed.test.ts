import { describe, expect, test } from 'bun:test';
import { type ClassifierInputs, ROOT, type WorkspaceGraph, changeScope } from './check-changed';

// leaf -> mid -> base, and the root manifest depends on mid.
const graph: WorkspaceGraph = {
  directories: new Map([
    ['@x/base', 'packages/base'],
    ['@x/mid', 'packages/mid'],
    ['@x/leaf', 'packages/leaf'],
    ['@x/alone', 'packages/alone'],
  ]),
  dependsOn: new Map([
    ['@x/base', []],
    ['@x/mid', ['@x/base']],
    ['@x/leaf', ['@x/mid']],
    ['@x/alone', []],
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
    expect(scoped(['scripts/package-tests.ts']).packages.size).toBe(4);
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

  test('the lockfile checks everything', () => {
    expect(changeScope(['bun.lock'], graph, inputs).kind).toBe('everything');
  });

  test('an unmapped root file checks everything and names the file', () => {
    const scope = changeScope(['packages/leaf/a.ts', 'Dockerfile'], graph, inputs);
    expect(scope.kind === 'everything' && scope.because.join()).toContain('Dockerfile');
  });
});
