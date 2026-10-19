import { dirname, relative, resolve } from 'node:path';
import ts from 'typescript';

const REPO_ROOT = resolve(import.meta.dir, '..');

/**
 * Workflow-facing code that reaches persistence only through the workflow host contract.
 * This is the only list of these files. Each listed file must exist: a renamed consumer
 * fails the check instead of silently dropping out of it.
 */
export const WORKFLOW_PERSISTENCE_CONSUMERS = [
  'packages/core/src/operations/workflow-operations.ts',
  'packages/core/src/operations/workflow-adoption.ts',
  'packages/core/src/services/run-attention-watch.ts',
  'packages/core/src/services/codebase-checkout-resolver.ts',
  'packages/core/src/workflows/continuation-host.ts',
  'packages/core/src/workflows/continuation-resume.ts',
  'packages/core/src/workflows/resource-start-host.ts',
  'packages/core/src/workflows/child-isolation-resolver.ts',
  'packages/core/src/workflows/headless-platform.ts',
  'packages/core/src/handlers/clone.ts',
  'packages/cli/src/commands/workflow.ts',
  'packages/cli/src/commands/workflow-shared.ts',
  'packages/cli/src/commands/workflow-list.ts',
  'packages/cli/src/commands/workflow-node-summaries.ts',
  'packages/cli/src/commands/workflow-continuations.ts',
  'packages/cli/src/commands/workflow-run-output.ts',
  'packages/cli/src/commands/workflow-transcript.ts',
  'packages/cli/src/commands/workflow-inspect.ts',
  'packages/cli/src/commands/workflow-attention.ts',
  'packages/cli/src/commands/workflow-detach.ts',
  'packages/cli/src/commands/workflow-isolation.ts',
  'packages/cli/src/commands/workflow-run-preflight.ts',
  'packages/cli/src/commands/workflow-dry-run.ts',
  'packages/cli/src/commands/workflow-wait-continuation.ts',
  'packages/cli/src/commands/workflow-run-owned.ts',
  'packages/cli/src/commands/workflow-run-admission.ts',
  'packages/cli/src/commands/workflow-run-launch.ts',
  'packages/cli/src/commands/workflow-run-execution.ts',
  'packages/cli/src/commands/workflow-query.ts',
  'packages/cli/src/commands/trigger.ts',
  'packages/cli/src/adapters/cli-adapter.ts',
  'packages/cli/src/utils/owned-run-termination.ts',
  'packages/cli/src/utils/cli-user.ts',
  'packages/server/src/services/resource-start-hosting.ts',
  'packages/server/src/services/webhook-source-plugins.ts',
];

const SQL_COMPOSITION = new Set([
  'packages/core/src/workflows/sql-host.ts',
  'packages/core/src/workflows/store-adapter.ts',
  'packages/core/src/handlers/sql-registration.ts',
]);

/**
 * `@archon/core` and `@archon/core/workflows` re-export SQL-backed operations next to the
 * contract, so a consumer takes no runtime import from them even of a symbol that is safe.
 */
const CORE_BARRELS = new Set([
  'packages/core/src/index.ts',
  'packages/core/src/workflows/index.ts',
]);

function isPersistence(path: string): boolean {
  return path.startsWith('packages/core/src/db/') || SQL_COMPOSITION.has(path);
}

/** `names` is `[]` for an import of inline types only, which Bun erases; `import {}` loads. */
function bannedModule(path: string, names?: readonly ts.Node[]): string | undefined {
  if (isPersistence(path)) return 'SQL persistence';
  return CORE_BARRELS.has(path) && names?.length !== 0 ? 'Core barrel' : undefined;
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
 * `import()` or `require()` in `consumers` that reaches persistence or a core barrel. The
 * type checker follows aliases and barrel re-exports, so a persistence symbol re-exported
 * through `@archon/core` is caught. Type-only imports are allowed. Each consumer is
 * resolved with the tsconfig that owns it, the same resolution type-check uses.
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
  // The owning tsconfigs differ only in module resolution, so the programs share parsed
  // files instead of each parsing the overlapping workspace graph again.
  const parsed = new Map<string, ts.SourceFile | undefined>();
  for (const [configPath, files] of groups) {
    const options = loadOptions(configPath);
    const host = ts.createCompilerHost(options);
    const parse = host.getSourceFile.bind(host);
    host.getSourceFile = (fileName, ...rest) => {
      if (!parsed.has(fileName)) parsed.set(fileName, parse(fileName, ...rest));
      return parsed.get(fileName);
    };
    const program = ts.createProgram(files, options, host);
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
      const report = (node: ts.Node, specifier: string, what = 'SQL persistence'): void => {
        const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
        violations.push(
          `${pathOf(file)}:${line + 1}:${character + 1} ${what} import from '${specifier}'; use the workflow host contract.`
        );
      };
      const checkModule = (specifier: ts.StringLiteralLike, names?: ts.Node[]): void => {
        const target = ts.resolveModuleName(specifier.text, source.fileName, options, ts.sys)
          .resolvedModule?.resolvedFileName;
        const banned = target && bannedModule(pathOf(target), names);
        if (banned) return report(specifier, specifier.text, banned);
        for (const node of names ?? [specifier]) {
          const symbol = checker.getSymbolAtLocation(node);
          if (symbol && reachesPersistence(symbol)) report(node, specifier.text);
        }
      };
      const visit = (node: ts.Node): void => {
        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
          const clause = node.importClause;
          if (clause?.isTypeOnly) return;
          const bindings = clause?.namedBindings;
          const named = bindings && ts.isNamedImports(bindings) ? bindings.elements : [];
          const names: ts.Node[] = named.filter(item => !item.isTypeOnly).map(item => item.name);
          if (clause?.name) names.push(clause.name);
          if (bindings && ts.isNamespaceImport(bindings)) names.push(bindings.name);
          return checkModule(node.moduleSpecifier, names.length + named.length ? names : undefined);
        }
        if (
          ts.isExportDeclaration(node) &&
          node.moduleSpecifier &&
          ts.isStringLiteral(node.moduleSpecifier) &&
          !node.isTypeOnly
        ) {
          return checkModule(node.moduleSpecifier);
        }
        if (
          ts.isCallExpression(node) &&
          (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
            (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
        ) {
          const [argument] = node.arguments;
          if (argument && ts.isStringLiteralLike(argument)) checkModule(argument);
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
