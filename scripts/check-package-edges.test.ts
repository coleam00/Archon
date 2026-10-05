import { describe, expect, test } from 'bun:test';
import { findEdgeViolations, type PackageEdges, type PackageManifest } from './check-package-edges';

const edges: Readonly<Record<string, PackageEdges>> = {
  engine: { runtime: ['contract'], test: ['providers'] },
  contract: { runtime: [] },
  providers: { runtime: ['contract'] },
};

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
  return findEdgeViolations({ packages, files: [{ path, content }] }, edges);
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
            v.message.includes('forbidden')
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

  test('a test file is still limited to its runtime and test edges', () => {
    expect(
      check("import { run } from '@archon/providers';", 'packages/contract/src/a.test.ts').some(
        v => v.message === 'contract → @archon/providers is forbidden; allowed: (none)'
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

describe('package manifest edges and table conformance', () => {
  test('accepts a clean workspace with test-only devDependencies', () => {
    expect(findEdgeViolations({ packages: manifests(), files: [] }, edges)).toEqual([]);
  });

  for (const section of ['dependencies', 'peerDependencies'] as const) {
    test(`rejects a test-only edge in ${section}`, () => {
      const packages = manifests();
      packages[0][section] = { '@archon/providers': 'workspace:*' };
      const violations = findEdgeViolations({ packages, files: [] }, edges);
      expect(violations).toHaveLength(1);
      expect(violations[0].file).toBe('packages/engine/package.json');
      expect(violations[0].message).toContain(`${section} is forbidden`);
    });
  }

  test('rejects unknown manifest dependencies', () => {
    const packages = manifests();
    packages[0].devDependencies = { '@archon/missing': 'workspace:*' };
    expect(findEdgeViolations({ packages, files: [] }, edges)[0].message).toContain(
      '@archon/missing'
    );
  });

  test('reports a workspace package missing from the table', () => {
    const packages = [...manifests(), { path: 'packages/new/package.json' }];
    expect(findEdgeViolations({ packages, files: [] }, edges)[0].message).toContain(
      "'new' has no edge-table entry"
    );
  });

  test('reports a table entry with no workspace package', () => {
    expect(
      findEdgeViolations({ packages: manifests().slice(0, 2), files: [] }, edges)[0].message
    ).toContain("'providers' has no workspace package");
  });

  test('reports unknown table targets for runtime and test edges', () => {
    const invalid = { ...edges, engine: { runtime: ['missing'], test: ['other'] } };
    const violations = findEdgeViolations({ packages: manifests(), files: [] }, invalid);
    expect(
      violations.filter(v => v.message.includes('unknown edge-table target')).map(v => v.message)
    ).toEqual([
      'engine → missing: unknown edge-table target',
      'engine → other: unknown edge-table target',
    ]);
  });
});
