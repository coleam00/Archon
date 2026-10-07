import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import ts from 'typescript';

export interface PackageEdges {
  runtime: readonly string[];
  test?: readonly string[];
}

export const PACKAGE_EDGES: Readonly<Record<string, PackageEdges>> = {
  // SDK-free filesystem and process foundations.
  paths: { runtime: [] },
  // Forge contracts; fixtures use paths' test cleanup helpers.
  forge: { runtime: ['paths'] },
  // Plugin manifest vocabulary.
  'plugin-manifest': { runtime: ['paths'] },
  // External providers can depend on the contract without pulling in implementations.
  'provider-contract': { runtime: [] },
  // Git operations use the shared paths and process helpers.
  git: { runtime: ['paths'] },
  // SDK implementations adapt the provider contract.
  providers: { runtime: ['paths', 'provider-contract'] },
  // Isolation imports the engine-owned write-back shapes type-only. This table checks the
  // edge, not the import kind; keep those imports `import type`.
  isolation: { runtime: ['git', 'paths', 'provider-contract', 'workflows'] },
  // Tests run the engine against the real registered providers.
  workflows: {
    runtime: ['git', 'paths', 'plugin-manifest', 'provider-contract'],
    test: ['providers'],
  },
  // Core assembles execution and persistence services.
  core: { runtime: ['git', 'isolation', 'paths', 'provider-contract', 'providers', 'workflows'] },
  // Transport adapters normalize platform input for core.
  adapters: { runtime: ['core', 'forge', 'git', 'isolation', 'paths', 'providers', 'workflows'] },
  // Server hosts the engine and platform adapters.
  server: {
    runtime: ['adapters', 'core', 'git', 'paths', 'provider-contract', 'providers', 'workflows'],
  },
  // CLI composes local services and can launch the server.
  cli: {
    runtime: [
      'adapters',
      'core',
      'forge',
      'git',
      'isolation',
      'paths',
      'plugin-manifest',
      'provider-contract',
      'providers',
      'server',
      'workflows',
    ],
  },
  // The browser consumes generated API types through its local API layer.
  web: { runtime: [] },
  // Documentation builds independently of the runtime packages; the plugin catalog
  // validates listed manifests against the shared manifest vocabulary.
  'docs-web': { runtime: ['plugin-manifest'] },
};

export interface PackageManifest {
  path: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

export interface SourceFile {
  path: string;
  content: string;
}

export interface Violation {
  file: string;
  line?: number;
  message: string;
}

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

function importedPackages(file: SourceFile): { target: string; line: number }[] {
  const source = ts.createSourceFile(file.path, file.content, ts.ScriptTarget.Latest, true);
  const imports: { target: string; line: number }[] = [];
  const add = (specifier: ts.Node | undefined): void => {
    // Only literal specifiers name packages. Non-literal specifiers in this repo load
    // file paths (webhook plugins, deep SDK files), so they are not package edges.
    if (!specifier || !ts.isStringLiteralLike(specifier)) return;
    const target = packageTarget(specifier.text);
    if (target !== undefined) {
      imports.push({
        target,
        line: source.getLineAndCharacterOfPosition(specifier.getStart(source)).line + 1,
      });
    }
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

export function findEdgeViolations(
  input: { packages: readonly PackageManifest[]; files: readonly SourceFile[] },
  edges: Readonly<Record<string, PackageEdges>> = PACKAGE_EDGES
): Violation[] {
  const violations: Violation[] = [];
  const packages = new Map(
    input.packages.map(manifest => [packageDirectory(manifest.path), manifest])
  );
  for (const [name, manifest] of packages) {
    if (name === undefined || edges[name] === undefined) {
      violations.push({
        file: manifest.path,
        message: `workspace package '${String(name)}' has no edge-table entry`,
      });
    }
  }
  for (const [name, allowed] of Object.entries(edges)) {
    if (!packages.has(name)) {
      violations.push({
        file: 'PACKAGE_EDGES',
        message: `edge-table package '${name}' has no workspace package`,
      });
    }
    for (const target of [...allowed.runtime, ...(allowed.test ?? [])]) {
      if (edges[target] === undefined) {
        violations.push({
          file: 'PACKAGE_EDGES',
          message: `${name} → ${target}: unknown edge-table target`,
        });
      }
    }
  }
  for (const [name, manifest] of packages) {
    if (name === undefined) continue;
    const allowed = edges[name];
    if (allowed === undefined) continue;
    for (const section of ['dependencies', 'peerDependencies', 'devDependencies'] as const) {
      const targets =
        section === 'devDependencies'
          ? [...allowed.runtime, ...(allowed.test ?? [])]
          : allowed.runtime;
      for (const specifier of Object.keys(manifest[section] ?? {})) {
        const target = packageTarget(specifier);
        if (target !== undefined && target !== name && !targets.includes(target)) {
          violations.push({
            file: manifest.path,
            message: `${name} → @archon/${target} in ${section} is forbidden; allowed: ${targets.join(', ') || '(none)'}`,
          });
        }
      }
    }
  }
  for (const file of input.files) {
    const path = normalizePath(file.path);
    const name = packageDirectory(path);
    if (name === undefined) continue;
    const manifest = packages.get(name);
    const allowed = edges[name];
    if (!manifest || !allowed) continue;
    const test = isTestFile(path);
    const targets = test ? [...allowed.runtime, ...(allowed.test ?? [])] : allowed.runtime;
    for (const { target, line } of importedPackages({ ...file, path })) {
      if (target === name) continue;
      if (!targets.includes(target)) {
        violations.push({
          file: file.path,
          line,
          message: `${name} → @archon/${target} is forbidden; allowed: ${targets.join(', ') || '(none)'}`,
        });
      }
      const specifier = `@archon/${target}`;
      if (
        !(specifier in (manifest.dependencies ?? {})) &&
        !(specifier in (manifest.peerDependencies ?? {})) &&
        !(test && specifier in (manifest.devDependencies ?? {}))
      ) {
        violations.push({
          file: file.path,
          line,
          message: `${name} → ${specifier} is undeclared in ${test ? 'dependencies, peerDependencies or devDependencies' : 'dependencies or peerDependencies'}`,
        });
      }
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
  const violations = findEdgeViolations(loadRepository());
  for (const violation of violations) {
    console.error(
      `${violation.file}${violation.line === undefined ? '' : `:${String(violation.line)}`}: ${violation.message}`
    );
  }
  if (violations.length > 0) process.exitCode = 1;
  else console.log('Package edge check passed.');
}
