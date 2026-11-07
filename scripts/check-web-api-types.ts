import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import ts from 'typescript';
import { gitOutput } from './check-test-cleanup-drift';

const ROOT = resolve(import.meta.dir, '..');
const CONSOLE = 'packages/web/src/experiments/console/';
const GENERATED = 'packages/web/src/lib/api.generated';
const HELPERS = `${CONSOLE}lib/api-types`;
const PROJECTIONS = new Set([
  'Pick',
  'Omit',
  'Partial',
  'Required',
  'Readonly',
  'NonNullable',
  'Extract',
  'Exclude',
  'Array',
  'ReadonlyArray',
]);

export function isCheckedSource(file: string): boolean {
  return (
    file === `${CONSOLE}lib/http.ts` ||
    (file.startsWith(`${CONSOLE}skills/`) && /\.(?:[cm]?ts|tsx)$/.test(file))
  );
}

export function checkSources(sources: ReadonlyMap<string, string>, root = ROOT): string[] {
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ESNext, types: [], noEmit: true };
  const host = ts.createCompilerHost(options);
  const originals = host.getSourceFile.bind(host);
  const virtual = new Map([...sources].map(([file, text]) => [resolve(root, file), text]));
  host.getSourceFile = (file, languageVersion, onError, shouldCreateNewSourceFile) => {
    const text = virtual.get(resolve(file));
    return text === undefined
      ? originals(file, languageVersion, onError, shouldCreateNewSourceFile)
      : ts.createSourceFile(file, text, languageVersion, true);
  };
  const program = ts.createProgram([...virtual.keys()], options, host);
  const checker = program.getTypeChecker();
  const failures: string[] = [];
  for (const file of sources.keys()) {
    if (!isCheckedSource(file)) continue;
    const parsed = program.getSourceFile(resolve(root, file));
    if (parsed === undefined) throw new Error(`Cannot read ${file}`);
    const source = parsed;
    const active = new Set<ts.Declaration>();

    function importedRoot(node: ts.Identifier, member?: string): boolean {
      const declarations = checker.getSymbolAtLocation(node)?.declarations ?? [];
      return declarations.some(declaration => {
        if (!ts.isImportSpecifier(declaration) && !ts.isNamespaceImport(declaration)) return false;
        const binding = ts.isImportSpecifier(declaration)
          ? declaration.parent.parent
          : declaration.parent;
        const statement = binding.parent;
        if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
          return false;
        const module = statement.moduleSpecifier.text;
        const target = module.startsWith('@/')
          ? `packages/web/src/${module.slice(2)}`
          : resolve(dirname(file), module).slice(resolve('.').length + 1);
        const name = ts.isImportSpecifier(declaration)
          ? (declaration.propertyName ?? declaration.name).text
          : member;
        return target === GENERATED
          ? name === 'paths' || name === 'components'
          : target === HELPERS && name !== undefined;
      });
    }

    function standard(node: ts.Identifier): boolean {
      return (
        PROJECTIONS.has(node.text) &&
        (checker
          .getSymbolAtLocation(node)
          ?.declarations?.every(declaration => declaration.getSourceFile().hasNoDefaultLib) ??
          false)
      );
    }

    function reference(
      name: ts.EntityName | ts.Expression,
      args: readonly ts.TypeNode[] | undefined
    ): boolean {
      if (ts.isQualifiedName(name))
        return ts.isIdentifier(name.left) && importedRoot(name.left, name.right.text);
      if (!ts.isIdentifier(name)) return false;
      if (importedRoot(name)) return true;
      if (standard(name)) {
        if (args === undefined || args.length === 0 || !derived(args[0])) return false;
        return args.slice(1).every(selector);
      }
      const declarations = checker.getSymbolAtLocation(name)?.declarations;
      return (
        declarations !== undefined &&
        declarations.length > 0 &&
        declarations.every(
          declaration =>
            declaration.getSourceFile() === source &&
            (ts.isTypeAliasDeclaration(declaration) || ts.isInterfaceDeclaration(declaration)) &&
            declarationDerived(declaration)
        )
      );
    }

    function selector(node: ts.TypeNode): boolean {
      if (ts.isLiteralTypeNode(node)) return true;
      if (ts.isUnionTypeNode(node) || ts.isIntersectionTypeNode(node))
        return node.types.every(selector);
      if (ts.isTypeOperatorNode(node) && node.operator === ts.SyntaxKind.KeyOfKeyword)
        return derived(node.type);
      if (ts.isTypeLiteralNode(node))
        return (
          node.members.length > 0 &&
          node.members.every(
            member =>
              ts.isPropertySignature(member) && member.type !== undefined && selector(member.type)
          )
        );
      return derived(node);
    }

    function membersDerived(members: ts.NodeArray<ts.TypeElement>): boolean {
      return members.every(
        member =>
          (ts.isPropertySignature(member) || ts.isIndexSignatureDeclaration(member)) &&
          member.type !== undefined &&
          derived(member.type)
      );
    }

    function derived(node: ts.TypeNode): boolean {
      if (ts.isTypeReferenceNode(node)) return reference(node.typeName, node.typeArguments);
      if (ts.isIndexedAccessTypeNode(node))
        return derived(node.objectType) && selector(node.indexType);
      if (ts.isParenthesizedTypeNode(node) || ts.isArrayTypeNode(node))
        return derived(ts.isArrayTypeNode(node) ? node.elementType : node.type);
      if (ts.isTypeOperatorNode(node))
        return node.operator === ts.SyntaxKind.ReadonlyKeyword && derived(node.type);
      if (ts.isUnionTypeNode(node) || ts.isIntersectionTypeNode(node))
        return node.types.every(derived);
      if (ts.isTypeLiteralNode(node))
        return node.members.length > 0 && membersDerived(node.members);
      return false;
    }

    function declarationDerived(node: ts.TypeAliasDeclaration | ts.InterfaceDeclaration): boolean {
      if (active.has(node)) return false;
      active.add(node);
      const heritage = ts.isInterfaceDeclaration(node)
        ? (node.heritageClauses ?? []).flatMap(clause => [...clause.types])
        : [];
      const result = ts.isTypeAliasDeclaration(node)
        ? derived(node.type)
        : (heritage.length > 0 || node.members.length > 0) &&
          heritage.every(parent => reference(parent.expression, parent.typeArguments)) &&
          membersDerived(node.members);
      active.delete(node);
      return result;
    }

    function visit(node: ts.Node): void {
      if (
        (ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) &&
        !declarationDerived(node)
      ) {
        const line = source.getLineAndCharacterOfPosition(node.name.getStart(source)).line + 1;
        failures.push(
          `${file}:${line} ${node.name.text}: derive API types from api.generated or lib/api-types; move genuine UI models to their owner`
        );
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  return failures;
}

export function checkRepository(root = ROOT): string[] {
  const sources = new Map<string, string>();
  for (const file of gitOutput(
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    root
  ).split('\0')) {
    if (isCheckedSource(file) && existsSync(join(root, file)))
      sources.set(file, readFileSync(join(root, file), 'utf8'));
  }
  return checkSources(sources, root);
}

if (import.meta.main) {
  const failures = checkRepository();
  if (failures.length > 0) {
    console.error(['Independent web API types detected:', ...failures].join('\n'));
    process.exit(1);
  }
  console.log('Web API type derivation check passed.');
}
