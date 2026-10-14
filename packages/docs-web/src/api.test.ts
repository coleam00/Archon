import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const generated = ts.createSourceFile(
  'api.generated.d.ts',
  readFileSync(new URL('../../web/src/lib/api.generated.d.ts', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest,
  true
);
const paths = generated.statements.find(
  statement => ts.isInterfaceDeclaration(statement) && statement.name.text === 'paths'
);
if (!paths || !ts.isInterfaceDeclaration(paths) || paths.members.length === 0) {
  throw new Error('Generated API paths interface is missing or empty');
}

const routes = paths.members.flatMap(path => {
  if (!ts.isPropertySignature(path) || !ts.isStringLiteral(path.name) || !path.type) {
    throw new Error('Unsupported generated API path');
  }
  if (!ts.isTypeLiteralNode(path.type)) throw new Error('Expected generated path operations');
  const pathname = path.name.text;
  return path.type.members.flatMap(operation => {
    if (
      !ts.isPropertySignature(operation) ||
      !ts.isIdentifier(operation.name) ||
      operation.name.text === 'parameters' ||
      operation.type?.kind === ts.SyntaxKind.NeverKeyword
    ) {
      return [];
    }
    return [{ path: pathname, method: operation.name.text.toUpperCase() }];
  });
});

const page = readFileSync(new URL('./content/docs/reference/api.md', import.meta.url), 'utf8').replace(
  /\r\n/g,
  '\n'
);
const rows = [
  ...page
    .replace(/```[^\n]*\n[\s\S]*?```/g, '')
    .matchAll(/^\|[ \t]*(.*?)[ \t]*\|[ \t]*`([^`]+)`[ \t]*\|[ \t]*(.+?)[ \t]*\|[ \t]*$/gm),
].filter(row => row[3]?.trim());

test('every generated API path has a reference table row', () => {
  const documented = new Set(rows.map(row => row[2]));
  const missing = [...new Set(routes.map(route => route.path))].filter(path => !documented.has(path));
  expect(missing).toEqual([]);
});

test('every generated API operation has a method and purpose in the reference', () => {
  const documented = new Set(rows.map(row => `${row[1]} ${row[2]}`));
  const missing = routes
    .map(route => `${route.method} ${route.path}`)
    .filter(operation => !documented.has(operation));
  expect(routes.length).toBeGreaterThan(0);
  expect(missing).toEqual([]);
});
