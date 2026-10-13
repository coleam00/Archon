import { describe, expect, test } from 'bun:test';
import { findEdgeViolations, type PackageManifest } from './check-package-edges';

function manifests(): PackageManifest[] {
  return [
    {
      path: 'packages/engine/package.json',
      dependencies: { '@archon/contract': 'workspace:*' },
      devDependencies: { '@archon/providers': 'workspace:*' },
    },
    { path: 'packages/contract/package.json' },
    {
      path: 'packages/providers/package.json',
      dependencies: { '@archon/contract': 'workspace:*' },
    },
  ];
}

function check(content: string, path = 'packages/engine/src/execute.ts', packages = manifests()) {
  return findEdgeViolations({ packages, files: [{ path, content }] });
}

describe('package source edges', () => {
  for (const source of [
    "import { run } from '@archon/providers';",
    "import type { Provider } from '@archon/providers/types';",
    "export { run } from '@archon/providers';",
    "export type { Provider } from '@archon/providers/types';",
    "export * from '@archon/providers';",
    "const providers = import('@archon/providers');",
    'const providers = import(`@archon/providers`);',
    'const providers = require(`@archon/providers`);',
    "const providers = require('@archon/providers');",
    "import providers = require('@archon/providers');",
    "type Providers = typeof import('@archon/providers');",
    "mock.module('@archon/providers', () => ({}));",
  ]) {
    test(`rejects ${source}`, () => {
      const violations = check(`\n${source}`);
      expect(
        violations.some(
          v =>
            v.file === 'packages/engine/src/execute.ts' &&
            v.line === 2 &&
            v.message.includes('@archon/providers') &&
            v.message.includes('undeclared')
        )
      ).toBe(true);
    });
  }

  test('accepts declared runtime imports and self-imports', () => {
    expect(
      check(
        "import { contract } from '@archon/contract'; import { engine } from '@archon/engine/executor';"
      )
    ).toEqual([]);
  });

  for (const path of [
    'packages/engine/src/execute.test.ts',
    'packages/engine/src/execute.test.mts',
    'packages/engine/src/execute.test.cts',
    'packages/engine/src/execute.test.tsx',
    'packages/engine/test/fixture.ts',
    'packages/engine/src/__tests__/fixture.ts',
    'packages/engine/src/test-utils.ts',
    'packages\\engine\\src\\execute.test.ts',
  ]) {
    test(`accepts test-only imports in ${path}`, () => {
      expect(check("import type { Provider } from '@archon/providers/types';", path)).toEqual([]);
    });
  }

  test('a test file still requires declared dependencies', () => {
    expect(
      check("import { run } from '@archon/providers';", 'packages/contract/src/a.test.ts').some(v =>
        v.message.includes('undeclared')
      )
    ).toBe(true);
  });

  test('a test-only import must be declared in devDependencies', () => {
    const packages = manifests();
    delete packages[0].devDependencies;
    expect(
      check(
        "import { run } from '@archon/providers';",
        'packages/engine/src/execute.test.ts',
        packages
      ).some(v => v.message.includes('undeclared'))
    ).toBe(true);
  });

  test('a devDependency cannot satisfy a production import', () => {
    const violations = check("import { run } from '@archon/providers';");
    expect(violations.some(v => v.message.includes('undeclared'))).toBe(true);
  });

  test('an allowed edge must be declared', () => {
    const packages = manifests();
    delete packages[0].dependencies;
    expect(check("import { contract } from '@archon/contract';", undefined, packages)).toEqual([
      {
        file: 'packages/engine/src/execute.ts',
        line: 1,
        message: 'engine → @archon/contract is undeclared in dependencies or peerDependencies',
      },
    ]);
  });

  test('peerDependencies satisfy runtime imports', () => {
    const packages = manifests();
    packages[0].peerDependencies = packages[0].dependencies;
    delete packages[0].dependencies;
    expect(check("import type { Contract } from '@archon/contract';", undefined, packages)).toEqual(
      []
    );
  });

  test('ignores prose, unrelated imports and nonliteral calls', () => {
    expect(
      check(`
      // import { fake } from '@archon/providers';
      const example = "import('@archon/providers')";
      import { readFile } from 'node:fs/promises';
      import('ajv');
      import(variable);
      something.module('@archon/providers');
    `)
    ).toEqual([]);
  });
});

test('checks a new workspace package against its own manifest', () => {
  expect(
    findEdgeViolations({
      packages: [{ path: 'packages/new/package.json' }],
      files: [{ path: 'packages/new/src/index.ts', content: "import '@archon/paths';" }],
    })
  ).toEqual([
    {
      file: 'packages/new/src/index.ts',
      line: 1,
      message: 'new → @archon/paths is undeclared in dependencies or peerDependencies',
    },
  ]);
});
