import { resolve, relative } from 'node:path';
import ts from 'typescript';

const root = resolve(import.meta.dir, '..');
export const WORKFLOW_BOUNDARY_FILES = [
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
] as const;

const sqlComposition = new Set([
  'packages/core/src/workflows/sql-host.ts',
  'packages/core/src/workflows/store-adapter.ts',
]);

function isPersistence(path: string): boolean {
  return path.startsWith('packages/core/src/db/') || sqlComposition.has(path);
}

export function checkWorkflowImports(files: readonly string[]): string[] {
  const program = ts.createProgram(
    files.map(file => resolve(root, file)),
    {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.Preserve,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      skipLibCheck: true,
      noEmit: true,
    }
  );
  const checker = program.getTypeChecker();
  const failures: string[] = [];
  const pathOf = (file: string): string => relative(root, file).replaceAll('\\', '/');
  const reachesPersistence = (symbol: ts.Symbol, visited = new Set<ts.Symbol>()): boolean => {
    if (visited.has(symbol)) return false;
    visited.add(symbol);
    if (symbol.flags & ts.SymbolFlags.Alias)
      return reachesPersistence(checker.getAliasedSymbol(symbol), visited);
    if (
      symbol.declarations?.some(declaration =>
        isPersistence(pathOf(declaration.getSourceFile().fileName))
      )
    )
      return true;
    return (
      symbol.exports !== undefined &&
      [...symbol.exports.values()].some(item => reachesPersistence(item, visited))
    );
  };
  for (const file of files) {
    if (sqlComposition.has(file)) continue;
    const source = program.getSourceFile(resolve(root, file));
    if (!source) throw new Error(`Missing boundary source: ${file}`);
    const report = (node: ts.Node, message: string): void => {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart());
      failures.push(`${file}:${String(line + 1)}: ${message}`);
    };
    const checkModule = (specifier: ts.StringLiteralLike, names?: readonly ts.Node[]): void => {
      const resolved = ts.resolveModuleName(
        specifier.text,
        source.fileName,
        program.getCompilerOptions(),
        ts.sys
      ).resolvedModule;
      if (resolved && isPersistence(pathOf(resolved.resolvedFileName))) {
        report(specifier, `SQL persistence import '${specifier.text}'`);
        return;
      }
      for (const node of names ?? [specifier]) {
        const symbol = checker.getSymbolAtLocation(node);
        if (symbol && reachesPersistence(symbol))
          report(node, `Persistence re-export from '${specifier.text}'`);
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
          else
            names.push(
              ...clause.namedBindings.elements
                .filter(item => !item.isTypeOnly)
                .map(item => item.name)
            );
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
        )
          checkModule(argument);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return failures;
}

if (import.meta.main) {
  const failures = checkWorkflowImports(WORKFLOW_BOUNDARY_FILES);
  if (failures.length) {
    console.error(failures.join('\n'));
    process.exitCode = 1;
  } else console.log('Workflow persistence import boundaries pass.');
}
