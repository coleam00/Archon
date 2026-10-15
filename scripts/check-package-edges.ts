import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import ts from 'typescript';

const dependencySections = [
  'dependencies',
  'peerDependencies',
  'devDependencies',
  'optionalDependencies',
] as const;

const runtimeDependencySections = dependencySections.filter(
  section => section !== 'devDependencies'
);

export type PackageManifest = {
  path: string;
} & Partial<Record<(typeof dependencySections)[number], Record<string, string>>>;

export interface SourceFile {
  path: string;
  content: string;
}

export interface Violation {
  file: string;
  line?: number;
  message: string;
}

export type Layering = Readonly<
  Record<string, { runtime: readonly string[]; test?: readonly string[] }>
>;

/**
 * The allowed `@archon/*` edges between workspace packages, mirrored by the package table in
 * `.archon/architecture.md` (pinned by this script's test). `runtime` must equal the declared
 * `dependencies`, `peerDependencies` and `optionalDependencies`; `test` lists the extra
 * `devDependencies` only tests may import. Adding an edge means editing this table.
 */
export const PACKAGE_LAYERING: Layering = {
  paths: { runtime: [] },
  'provider-contract': { runtime: [] },
  'chat-contract': { runtime: ['provider-contract'] },
  'plugin-manifest': { runtime: ['chat-contract', 'paths', 'provider-contract'] },
  git: { runtime: ['paths'] },
  forge: { runtime: ['paths'] },
  providers: { runtime: ['paths', 'provider-contract'] },
  workflows: {
    runtime: ['git', 'paths', 'plugin-manifest', 'provider-contract'],
    test: ['providers'],
  },
  isolation: { runtime: ['git', 'paths', 'provider-contract', 'workflows'] },
  core: {
    runtime: [
      'chat-contract',
      'git',
      'isolation',
      'paths',
      'plugin-manifest',
      'provider-contract',
      'providers',
      'workflows',
    ],
  },
  adapters: {
    runtime: ['core', 'forge', 'git', 'isolation', 'paths', 'providers', 'workflows'],
  },
  'chat-slack': { runtime: ['chat-contract'] },
  server: {
    runtime: [
      'adapters',
      'chat-contract',
      'core',
      'git',
      'paths',
      'provider-contract',
      'providers',
      'workflows',
    ],
  },
  cli: {
    runtime: [
      'adapters',
      'chat-contract',
      'core',
      'forge',
      'git',
      'isolation',
      'paths',
      'plugin-manifest',
      'provider-contract',
      'providers',
      'workflows',
    ],
  },
  web: { runtime: [] },
  'docs-web': { runtime: ['plugin-manifest'] },
};

function normalizePath(path: string): string {
  return path.replaceAll('\\', '/');
}

function packageDirectory(path: string): string | undefined {
  return normalizePath(path).split('/')[1];
}

function packageTarget(specifier: string): string | undefined {
  return specifier.startsWith('@archon/')
    ? specifier.slice('@archon/'.length).split('/')[0]
    : undefined;
}

function isTestFile(path: string): boolean {
  return (
    /\.test\.[cm]?[jt]sx?$/.test(path) ||
    /\/(?:test|__tests__)\//.test(path) ||
    /(?:^|\/)test-utils\./.test(path)
  );
}

function importedPackages(file: SourceFile): { specifier: string; line: number }[] {
  const source = ts.createSourceFile(file.path, file.content, ts.ScriptTarget.Latest, true);
  const imports: { specifier: string; line: number }[] = [];
  const add = (specifier: ts.Node | undefined): void => {
    // Only literal specifiers name packages. Non-literal specifiers in this repo load
    // file paths (webhook plugins, deep SDK files), so they are not package edges.
    if (!specifier || !ts.isStringLiteralLike(specifier)) return;
    imports.push({
      specifier: specifier.text,
      line: source.getLineAndCharacterOfPosition(specifier.getStart(source)).line + 1,
    });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) add(node.moduleSpecifier);
    else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      add(node.moduleReference.expression);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
      add(node.argument.literal);
    else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (
        callee.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(callee) && callee.text === 'require') ||
        (ts.isPropertyAccessExpression(callee) &&
          ts.isIdentifier(callee.expression) &&
          callee.expression.text === 'mock' &&
          callee.name.text === 'module')
      )
        add(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return imports;
}

export function findEdgeViolations(input: {
  packages: readonly PackageManifest[];
  files: readonly SourceFile[];
}): Violation[] {
  const violations: Violation[] = [];
  const packages = new Map(
    input.packages.map(manifest => [packageDirectory(manifest.path), manifest])
  );
  const workflows = packages.get('workflows');
  for (const field of dependencySections) {
    if (workflows && '@hono/zod-openapi' in (workflows[field] ?? {})) {
      violations.push({
        file: workflows.path,
        message: `workflows must not declare @hono/zod-openapi in ${field}; engine schemas use plain zod`,
      });
    }
  }
  for (const file of input.files) {
    const path = normalizePath(file.path);
    const name = packageDirectory(path);
    if (name === undefined) continue;
    const manifest = packages.get(name);
    if (!manifest) continue;
    const test = isTestFile(path);
    const declared = declaredArchonPackages(
      manifest,
      test ? dependencySections : runtimeDependencySections
    );
    for (const { specifier, line } of importedPackages({ ...file, path })) {
      if (
        (path.startsWith('packages/workflows/src/') ||
          path === 'packages/core/src/schemas/user.ts') &&
        (specifier === '@hono/zod-openapi' || specifier.startsWith('@hono/zod-openapi/'))
      ) {
        violations.push({
          file: file.path,
          line,
          message: 'Engine schemas must import plain zod instead of @hono/zod-openapi',
        });
      }
      const target = packageTarget(specifier);
      if (target === undefined || target === name) continue;
      const workspaceSpecifier = `@archon/${target}`;
      if (!declared.has(target)) {
        violations.push({
          file: file.path,
          line,
          message: `${name} → ${workspaceSpecifier} is undeclared in ${(test ? dependencySections : runtimeDependencySections).join(', ')}`,
        });
      }
    }
  }
  return violations;
}

function declaredArchonPackages(
  manifest: PackageManifest,
  sections: readonly (typeof dependencySections)[number][]
): Set<string> {
  const names = new Set<string>();
  for (const section of sections) {
    for (const specifier of Object.keys(manifest[section] ?? {})) {
      const target = packageTarget(specifier);
      if (target !== undefined) names.add(target);
    }
  }
  return names;
}

function sameNames(declared: ReadonlySet<string>, allowed: readonly string[]): boolean {
  return declared.size === allowed.length && allowed.every(name => declared.has(name));
}

function listNames(names: Iterable<string>): string {
  const sorted = [...names].sort();
  return sorted.length === 0 ? 'none' : sorted.join(', ');
}

/** Every workspace package declares exactly the `@archon/*` edges its layering row allows. */
export function findLayeringViolations(
  packages: readonly PackageManifest[],
  layering: Layering = PACKAGE_LAYERING
): Violation[] {
  const violations: Violation[] = [];
  const present = new Set<string>();
  for (const manifest of packages) {
    const name = packageDirectory(manifest.path);
    if (name === undefined) continue;
    present.add(name);
    const row = Object.hasOwn(layering, name) ? layering[name] : undefined;
    if (row === undefined) {
      violations.push({
        file: manifest.path,
        message: `${name} has no row in PACKAGE_LAYERING (scripts/check-package-edges.ts) or the package table in .archon/architecture.md`,
      });
      continue;
    }
    const runtime = declaredArchonPackages(manifest, runtimeDependencySections);
    if (!sameNames(runtime, row.runtime)) {
      violations.push({
        file: manifest.path,
        message: `${name} declares @archon runtime dependencies [${listNames(runtime)}]; the layering allows [${listNames(row.runtime)}]`,
      });
    }
    const testOnly = new Set(
      [...declaredArchonPackages(manifest, ['devDependencies'])].filter(dep => !runtime.has(dep))
    );
    const allowedTest = row.test ?? [];
    if (!sameNames(testOnly, allowedTest)) {
      violations.push({
        file: manifest.path,
        message: `${name} declares test-only @archon devDependencies [${listNames(testOnly)}]; the layering allows [${listNames(allowedTest)}]`,
      });
    }
  }
  for (const name of Object.keys(layering)) {
    if (!present.has(name)) {
      violations.push({
        file: 'scripts/check-package-edges.ts',
        message: `PACKAGE_LAYERING has a row for ${name}, which is not a workspace package`,
      });
    }
  }
  return violations;
}

export function loadRepository(root = resolve(import.meta.dir, '..')): {
  packages: PackageManifest[];
  files: SourceFile[];
} {
  const packages = readdirSync(join(root, 'packages'), { withFileTypes: true })
    .filter(
      entry => entry.isDirectory() && existsSync(join(root, 'packages', entry.name, 'package.json'))
    )
    .map(entry => {
      const path = `packages/${entry.name}/package.json`;
      const manifest = JSON.parse(readFileSync(join(root, path), 'utf8')) as Omit<
        PackageManifest,
        'path'
      >;
      return { ...manifest, path };
    });
  const listed = new Set<string>();
  for (const args of [
    ['ls-files', '-z', '--', 'packages'],
    ['ls-files', '-z', '--others', '--exclude-standard', '--', 'packages'],
  ]) {
    const result = Bun.spawnSync(['git', ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
    if (result.exitCode !== 0)
      throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString()}`);
    for (const file of result.stdout.toString().split('\0')) {
      if (/\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/.test(file) && existsSync(join(root, file)))
        listed.add(file);
    }
  }
  const files = [...listed]
    .sort()
    .map(path => ({ path, content: readFileSync(join(root, path), 'utf8') }));
  return { packages, files };
}

if (import.meta.main) {
  const repository = loadRepository();
  const violations = [
    ...findLayeringViolations(repository.packages),
    ...findEdgeViolations(repository),
  ];
  for (const violation of violations) {
    console.error(
      `${violation.file}${violation.line === undefined ? '' : `:${String(violation.line)}`}: ${violation.message}`
    );
  }
  if (violations.length > 0) process.exitCode = 1;
  else console.log('Package edge check passed.');
}
