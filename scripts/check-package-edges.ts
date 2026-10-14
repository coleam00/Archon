import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import ts from 'typescript';

export interface PackageManifest {
  path: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
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
  for (const field of [
    'dependencies',
    'peerDependencies',
    'devDependencies',
    'optionalDependencies',
  ] as const) {
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
      if (
        !(workspaceSpecifier in (manifest.dependencies ?? {})) &&
        !(workspaceSpecifier in (manifest.peerDependencies ?? {})) &&
        !(test && workspaceSpecifier in (manifest.devDependencies ?? {}))
      ) {
        violations.push({
          file: file.path,
          line,
          message: `${name} → ${workspaceSpecifier} is undeclared in ${test ? 'dependencies, peerDependencies or devDependencies' : 'dependencies or peerDependencies'}`,
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
