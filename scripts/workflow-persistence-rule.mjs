import { relative } from 'node:path';
import ts from 'typescript';

const sqlComposition = new Set([
  'packages/core/src/workflows/sql-host.ts',
  'packages/core/src/workflows/store-adapter.ts',
]);

function isPersistence(path) {
  return path.startsWith('packages/core/src/db/') || sqlComposition.has(path);
}

export default {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      persistence: "SQL persistence import from '{{specifier}}'; use the workflow host contract.",
    },
  },
  create(context) {
    const services = context.sourceCode.parserServices;
    if (!services.program || !services.esTreeNodeToTSNodeMap || !services.tsNodeToESTreeNodeMap) {
      throw new Error('archon/no-workflow-persistence requires typed parser services');
    }
    const program = services.program;
    const checker = program.getTypeChecker();
    const pathOf = file => relative(context.cwd, file).replaceAll('\\', '/');
    const reachesPersistence = (symbol, visited = new Set()) => {
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
    return {
      'Program:exit'(node) {
        const source = services.esTreeNodeToTSNodeMap.get(node);
        const checkModule = (specifier, names) => {
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
        const visit = node => {
          if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
            const clause = node.importClause;
            if (clause?.isTypeOnly) return;
            const names = [];
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
        function report(tsNode, specifier) {
          context.report({
            node: services.tsNodeToESTreeNodeMap.get(tsNode),
            messageId: 'persistence',
            data: { specifier },
          });
        }
        visit(source);
      },
    };
  },
};
