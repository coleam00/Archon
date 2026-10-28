import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { describe, expect, test } from 'bun:test';
import {
  BUNDLED_PACK_SEAM,
  findEdgeViolations,
  findLayeringViolations,
  findPackBoundaryViolations,
  type Layering,
  type PackageManifest,
  PACKAGE_LAYERING,
} from './check-package-edges';

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
        message:
          'engine → @archon/contract is undeclared in dependencies, peerDependencies, optionalDependencies',
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

  test('optionalDependencies satisfy runtime imports and layering together', () => {
    const packages = manifests();
    packages[0].optionalDependencies = packages[0].dependencies;
    delete packages[0].dependencies;
    expect(check("import { contract } from '@archon/contract';", undefined, packages)).toEqual([]);
    expect(
      findLayeringViolations(packages, {
        engine: { runtime: ['contract'], test: ['providers'] },
        contract: { runtime: [] },
        providers: { runtime: ['contract'] },
      })
    ).toEqual([]);
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
      message:
        'new → @archon/paths is undeclared in dependencies, peerDependencies, optionalDependencies',
    },
  ]);
});

describe('plain-Zod engine boundary', () => {
  for (const field of [
    'dependencies',
    'peerDependencies',
    'devDependencies',
    'optionalDependencies',
  ]) {
    test(`rejects the paired Hono import and ${field} regression`, () => {
      const violations = findEdgeViolations({
        packages: [
          {
            path: 'packages/workflows/package.json',
            [field]: { '@hono/zod-openapi': '^1.0.0' },
          },
        ],
        files: [
          {
            path: 'packages/workflows/src/schemas/dag-node.ts',
            content: "import { z } from '@hono/zod-openapi';",
          },
        ],
      });
      expect(violations).toEqual([
        {
          file: 'packages/workflows/package.json',
          message: `workflows must not declare @hono/zod-openapi in ${field}; engine schemas use plain zod`,
        },
        {
          file: 'packages/workflows/src/schemas/dag-node.ts',
          line: 1,
          message: 'Engine schemas must import plain zod instead of @hono/zod-openapi',
        },
      ]);
    });
  }

  for (const path of [
    'packages/workflows/src/schemas/dag-node.ts',
    'packages/workflows/src/schemas.test.ts',
    'packages/core/src/schemas/user.ts',
  ]) {
    for (const source of [
      "import { z } from '@hono/zod-openapi';",
      "export { z } from '@hono/zod-openapi';",
      "const wrapper = import('@hono/zod-openapi');",
      "const wrapper = require('@hono/zod-openapi');",
      "import type { ZodType } from '@hono/zod-openapi/internal';",
    ]) {
      test(`rejects ${source} in ${path}`, () => {
        expect(
          check(source, path, [
            { path: 'packages/workflows/package.json' },
            { path: 'packages/core/package.json' },
          ])
        ).toEqual([
          {
            file: path,
            line: 1,
            message: 'Engine schemas must import plain zod instead of @hono/zod-openapi',
          },
        ]);
      });
    }
  }

  test('allows plain Zod and server-owned Hono schemas', () => {
    expect(
      findEdgeViolations({
        packages: [
          { path: 'packages/workflows/package.json', dependencies: { zod: '^4' } },
          { path: 'packages/core/package.json', dependencies: { '@hono/zod-openapi': '^1' } },
          { path: 'packages/server/package.json', dependencies: { '@hono/zod-openapi': '^1' } },
        ],
        files: [
          {
            path: 'packages/workflows/src/schemas/dag-node.ts',
            content: "import { z } from 'zod';",
          },
          { path: 'packages/core/src/schemas/user.ts', content: "import { z } from 'zod';" },
          {
            path: 'packages/core/src/schemas/other.ts',
            content: "import { z } from '@hono/zod-openapi';",
          },
          {
            path: 'packages/server/src/schemas.ts',
            content: "import { z } from '@hono/zod-openapi';",
          },
        ],
      })
    ).toEqual([]);
  });
});

describe('engine/pack boundary', () => {
  const reaches = (content: string, path: string) =>
    findPackBoundaryViolations([{ path, content }]).map(v => v.message);
  const engineFile = 'packages/cli/src/commands/doctor.ts';
  const packFile = '.archon/scripts/__tests__/intake.test.ts';

  for (const source of [
    "import { check } from '../../../../.archon/workflows/sdlc/.shared/x.ts';",
    "const fixture = join(import.meta.dir, '../../../../.archon/workflows/p/w.yaml');",
    "const root = join(import.meta.dir, '..', '..', '..', '..', '.archon', 'workflows');",
    "const ROOT = join(import.meta.dir, '..', '..', '..', '..');\nconst script = join(ROOT, '.archon/scripts/x.ts');",
    "const url = new URL('../../../../.archon/workflows/x', import.meta.url);",
  ]) {
    test(`rejects the engine reaching the pack: ${source}`, () => {
      expect(
        reaches(source, engineFile).some(m => m.startsWith('engine code reaches .archon/'))
      ).toBe(true);
    });
  }

  for (const source of [
    "const workflows = join(cwd, '.archon', 'workflows');",
    "const pack = '/repo/.archon/workflows/team-pack';",
    '// see ../../../../.archon/workflows/sdlc for the pack\nconst x = 1;',
  ]) {
    test(`accepts the engine's own discovery paths and prose: ${source}`, () => {
      expect(reaches(source, engineFile)).toEqual([]);
    });
  }

  test('only the bundling seam may resolve the container root, and nothing beneath it', () => {
    const container = "const root = new URL('../../../../.archon/workflows', import.meta.url);";
    const beneath = "const root = new URL('../../../../.archon/workflows/sdlc', import.meta.url);";
    expect(reaches(container, BUNDLED_PACK_SEAM)).toEqual([]);
    expect(reaches(beneath, BUNDLED_PACK_SEAM)).toHaveLength(1);
    expect(reaches(container, 'packages/workflows/src/defaults/other.ts')).toHaveLength(1);
  });

  for (const source of [
    "import { trackTempRoots } from '@archon/paths/test-utils';",
    "import { OPS } from '../../../packages/forge/src/operations';",
    "const cli = resolve(import.meta.dir, '../../../packages/cli/src/cli.ts');",
  ]) {
    test(`rejects the pack reaching the engine: ${source}`, () => {
      expect(reaches(source, packFile)).toHaveLength(1);
    });
  }

  test('accepts pack prose and pack-local paths', () => {
    expect(
      reaches(
        "// imports @archon/paths in the engine\nimport { x } from '../lib/x';\nconst f = join(import.meta.dir, 'fixtures');",
        packFile
      )
    ).toEqual([]);
  });
});

describe('package layering', () => {
  const layering: Layering = {
    contract: { runtime: [] },
    engine: { runtime: ['contract'], test: ['providers'] },
    providers: { runtime: ['contract'] },
  };

  test('accepts manifests that declare exactly their layering row', () => {
    expect(findLayeringViolations(manifests(), layering)).toEqual([]);
  });

  test('rejects a runtime edge the layering does not allow', () => {
    const packages = manifests();
    packages[0].dependencies = { ...packages[0].dependencies, '@archon/providers': 'workspace:*' };
    expect(findLayeringViolations(packages, layering)).toEqual([
      {
        file: 'packages/engine/package.json',
        message:
          'engine declares @archon runtime dependencies [contract, providers]; the layering allows [contract]',
      },
      {
        file: 'packages/engine/package.json',
        message:
          'engine declares test-only @archon devDependencies [none]; the layering allows [providers]',
      },
    ]);
  });

  for (const field of ['peerDependencies', 'optionalDependencies'] as const) {
    test(`counts ${field} as runtime edges`, () => {
      const packages = manifests();
      packages[1][field] = { '@archon/providers': 'workspace:*' };
      expect(findLayeringViolations(packages, layering)).toEqual([
        {
          file: 'packages/contract/package.json',
          message:
            'contract declares @archon runtime dependencies [providers]; the layering allows [none]',
        },
      ]);
    });
  }

  test('rejects a test-only edge the layering does not allow', () => {
    const packages = manifests();
    packages[2].devDependencies = { '@archon/engine': 'workspace:*' };
    expect(findLayeringViolations(packages, layering)).toEqual([
      {
        file: 'packages/providers/package.json',
        message:
          'providers declares test-only @archon devDependencies [engine]; the layering allows [none]',
      },
    ]);
  });

  test('rejects an allowed edge the manifest no longer declares', () => {
    const packages = manifests();
    delete packages[0].dependencies;
    expect(findLayeringViolations(packages, layering)).toEqual([
      {
        file: 'packages/engine/package.json',
        message:
          'engine declares @archon runtime dependencies [none]; the layering allows [contract]',
      },
    ]);
  });

  test('rejects a package without a row and a row without a package', () => {
    expect(
      findLayeringViolations(
        [...manifests().slice(1), { path: 'packages/new/package.json' }],
        layering
      )
    ).toEqual([
      {
        file: 'packages/new/package.json',
        message: 'new has no row in PACKAGE_LAYERING (scripts/check-package-edges.ts)',
      },
      {
        file: 'scripts/check-package-edges.ts',
        message: 'PACKAGE_LAYERING has a row for engine, which is not a workspace package',
      },
    ]);
  });

  test('the package table in .archon/architecture.md equals PACKAGE_LAYERING', () => {
    const doc = readFileSync(new URL('../.archon/architecture.md', import.meta.url), 'utf8');
    const table = doc.split('### Packages')[1]?.split('\n### ')[0] ?? '';
    const rows = table
      .split('\n')
      .filter(line => line.includes('|'))
      .map(line => {
        const cells = line
          .trim()
          .replace(/^\|/, '')
          .replace(/\|$/, '')
          .split('|')
          .map(cell => cell.trim());
        if (cells.length === 3) cells.push('');
        expect(cells).toHaveLength(4);
        const [name, , runtime, testOnly] = cells;
        return [name, runtime, testOnly];
      })
      .filter(([name]) => name !== 'Package' && !/^:?-+:?$/.test(name))
      .sort(([a], [b]) => a.localeCompare(b));
    const imports = (names: readonly string[]): string =>
      [...names]
        .sort()
        .map(name => `\`${name}\``)
        .join(', ');
    const expected = Object.entries(PACKAGE_LAYERING)
      .map(([name, row]) => [
        `\`${name}\``,
        imports(row.runtime) || 'none',
        imports(row.test ?? []),
      ])
      .sort(([a], [b]) => a.localeCompare(b));
    expect(rows).toEqual(expected);
  });
});

const trackTempRoot = trackTempRoots();

test('the package-edge command rejects a forbidden manifest dependency', () => {
  const root = trackTempRoot(mkdtempSync(join(tmpdir(), 'package-edge-command-')));
  mkdirSync(join(root, 'scripts'));
  copyFileSync(
    join(import.meta.dir, 'check-package-edges.ts'),
    join(root, 'scripts/check-package-edges.ts')
  );
  symlinkSync(resolve(import.meta.dir, '../node_modules'), join(root, 'node_modules'), 'junction');
  writeFileSync(join(root, '.gitignore'), 'node_modules/\n');
  const git = Bun.spawnSync(['git', 'init', '--quiet'], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(git.exitCode).toBe(0);

  for (const [name, row] of Object.entries(PACKAGE_LAYERING)) {
    mkdirSync(join(root, 'packages', name), { recursive: true });
    writeFileSync(
      join(root, 'packages', name, 'package.json'),
      JSON.stringify({
        dependencies: Object.fromEntries(row.runtime.map(dep => [`@archon/${dep}`, 'workspace:*'])),
        devDependencies: Object.fromEntries(
          (row.test ?? []).map(dep => [`@archon/${dep}`, 'workspace:*'])
        ),
      })
    );
  }
  const run = () =>
    Bun.spawnSync([process.execPath, 'run', 'scripts/check-package-edges.ts'], {
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
    });
  const valid = run();
  expect(valid.stderr.toString()).toBe('');
  expect(valid.exitCode).toBe(0);
  expect(valid.stdout.toString()).toContain('Package edge check passed.');

  const manifestPath = join(root, 'packages/workflows/package.json');
  writeFileSync(
    manifestPath,
    JSON.stringify({
      dependencies: Object.fromEntries(
        [...PACKAGE_LAYERING.workflows.runtime, 'core'].map(dep => [
          `@archon/${dep}`,
          'workspace:*',
        ])
      ),
      devDependencies: Object.fromEntries(
        (PACKAGE_LAYERING.workflows.test ?? []).map(dep => [`@archon/${dep}`, 'workspace:*'])
      ),
    })
  );
  const invalid = run();
  expect(invalid.exitCode).toBe(1);
  expect(invalid.stderr.toString()).toContain(
    `packages/workflows/package.json: workflows declares @archon runtime dependencies [${[...PACKAGE_LAYERING.workflows.runtime, 'core'].sort().join(', ')}]; the layering allows [${[...PACKAGE_LAYERING.workflows.runtime].sort().join(', ')}]`
  );
  expect(invalid.stdout.toString()).not.toContain('Package edge check passed.');
});
