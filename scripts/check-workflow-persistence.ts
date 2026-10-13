import { dirname, relative, resolve } from 'node:path';
import ts from 'typescript';

const REPO_ROOT = resolve(import.meta.dir, '..');

/**
 * Workflow-facing code that reaches persistence only through the workflow host contract.
 * Each listed file must exist: a renamed consumer fails the check instead of silently
 * dropping out of it.
 */
export const WORKFLOW_PERSISTENCE_CONSUMERS = [
  'packages/core/src/operations/workflow-operations.ts',
  'packages/core/src/operations/workflow-adoption.ts',
  'packages/core/src/services/run-attention-watch.ts',
  'packages/core/src/services/codebase-checkout-resolver.ts',
  'packages/core/src/workflows/continuation-host.ts',
  'packages/core/src/workflows/resource-start-host.ts',
  'packages/core/src/workflows/child-isolation-resolver.ts',
  'packages/core/src/workflows/headless-platform.ts',
  'packages/core/src/handlers/clone.ts',
  'packages/cli/src/commands/workflow.ts',
  'packages/cli/src/commands/workflow-continuations.ts',
  'packages/cli/src/commands/trigger.ts',
  'packages/cli/src/adapters/cli-adapter.ts',
  'packages/cli/src/utils/owned-run-termination.ts',
  'packages/server/src/services/resource-start-hosting.ts',
  'packages/server/src/services/webhook-source-plugins.ts',
];

const SQL_COMPOSITION = new Set([
  'packages/core/src/workflows/sql-host.ts',
  'packages/core/src/workflows/store-adapter.ts',
]);

function isPersistence(path: string): boolean {
  return path.startsWith('packages/core/src/db/') || SQL_COMPOSITION.has(path);
}

function loadOptions(configPath: string): ts.CompilerOptions {
  const parsed = ts.getParsedCommandLineOfConfigFile(
    configPath,
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: diagnostic => {
        throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
      },
    }
  );
  if (parsed === undefined) throw new Error(`Could not read ${configPath}`);
  return parsed.options;
}

/**
 * Returns one `file:line:column message` entry per runtime import, re-export, dynamic
 * `import()` or `require()` in `consumers` that reaches persistence. The type checker
 * follows aliases and barrel re-exports, so a persistence symbol re-exported through
 * `@archon/core` is caught. Type-only imports are allowed. Each consumer is resolved
 * with the tsconfig that owns it, the same resolution type-check uses.
 */
export function findPersistenceImports(root: string, consumers: readonly string[]): string[] {
  const groups = new Map<string, string[]>();
  for (const file of consumers) {
    const absolute = resolve(root, file);
    if (!ts.sys.fileExists(absolute)) {
      throw new Error(`Workflow persistence consumer does not exist: ${file}`);
    }
    const config = ts.findConfigFile(dirname(absolute), ts.sys.fileExists);
    if (config === undefined) throw new Error(`No tsconfig.json owns ${file}`);
    groups.set(config, [...(groups.get(config) ?? []), absolute]);
  }

  const pathOf = (file: string): string => relative(root, file).replaceAll('\\', '/');
  const violations: string[] = [];
  for (const [configPath, files] of groups) {
    const program = ts.createProgram(files, loadOptions(configPath));
    const checker = program.getTypeChecker();
    const reachesPersistence = (symbol: ts.Symbol, visited = new Set<ts.Symbol>()): boolean => {
      if (visited.has(symbol)) return false;
      visited.add(symbol);
      if (symbol.flags & ts.SymbolFlags.Alias) {
        return reachesPersistence(checker.getAliasedSymbol(symbol), visited);
      }
      if (
        symbol.declarations?.some(declaration =>
          isPersistence(pathOf(declaration.getSourceFile().fileName))
        )
      ) {
        return true;
      }
      return (
        symbol.exports !== undefined &&
        [...symbol.exports.values()].some(item => reachesPersistence(item, visited))
      );
    };

    for (const file of files) {
      const source = program.getSourceFile(file);
      if (source === undefined) throw new Error(`TypeScript did not load ${pathOf(file)}`);
      const report = (node: ts.Node, specifier: string): void => {
        const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
        violations.push(
          `${pathOf(file)}:${line + 1}:${character + 1} SQL persistence import from '${specifier}'; use the workflow host contract.`
        );
      };
      const checkModule = (specifier: ts.StringLiteralLike, names?: ts.Node[]): void => {
        const resolved = ts.resolveModuleName(
          specifier.text,
          source.fileName,
          program.getCompilerOptions(),
          ts.sys
        ).resolvedModule;
        if (resolved && isPersistence(pathOf(resolved.resolvedFileName))) {
          report(specifier, specifier.text);
          return;
        }
        for (const node of names ?? [specifier]) {
          const symbol = checker.getSymbolAtLocation(node);
          if (symbol && reachesPersistence(symbol)) report(node, specifier.text);
        }
      };
      const visit = (node: ts.Node): void => {
        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
          const clause = node.importClause;
          if (clause?.isTypeOnly) return;
          const names: ts.Node[] = [];
          if (clause?.name) names.push(clause.name);
          if (clause?.namedBindings) {
            if (ts.isNamespaceImport(clause.namedBindings)) names.push(clause.namedBindings.name);
            else {
              names.push(
                ...clause.namedBindings.elements
                  .filter(item => !item.isTypeOnly)
                  .map(item => item.name)
              );
            }
          }
          checkModule(node.moduleSpecifier, clause ? names : undefined);
          return;
        }
        if (
          ts.isExportDeclaration(node) &&
          node.moduleSpecifier &&
          ts.isStringLiteral(node.moduleSpecifier) &&
          !node.isTypeOnly
        ) {
          checkModule(node.moduleSpecifier);
          return;
        }
        if (
          ts.isCallExpression(node) &&
          (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
            (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
        ) {
          const argument = node.arguments[0];
          if (
            argument &&
            (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))
          ) {
            checkModule(argument);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  }
  return violations;
}

if (import.meta.main) {
  const violations = findPersistenceImports(REPO_ROOT, WORKFLOW_PERSISTENCE_CONSUMERS);
  if (violations.length > 0) {
    console.error(
      ['Workflow persistence boundary violated:', ...violations.map(item => `  ${item}`)].join('\n')
    );
    process.exitCode = 1;
  } else {
    console.log('Workflow persistence check passed.');
  }
}
