import { expect, test } from 'bun:test';
import { createMarkdownProcessor, type RemarkPlugin } from '@astrojs/markdown-remark';
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
interface TextNode {
  type: string;
  value?: string;
  children?: TextNode[];
}

function textContent(node: TextNode): string {
  return node.value ?? node.children?.map(textContent).join('') ?? '';
}

async function referenceOperations(markdown: string): Promise<{ method: string; path: string }[]> {
  const operations: { method: string; path: string }[] = [];
  const collectTables: RemarkPlugin = () => tree => {
    for (const node of tree.children) {
      if (node.type !== 'table') continue;
      for (const row of node.children.slice(1)) {
        const [method, path, purpose] = row.children.map(cell => textContent(cell).trim());
        if (method && path && purpose) operations.push({ method, path });
      }
    }
  };
  const processor = await createMarkdownProcessor({
    syntaxHighlight: false,
    remarkPlugins: [collectTables],
  });
  await processor.render(markdown);
  return operations;
}
const documentedOperations = await referenceOperations(page);

test('only visible table rows with a purpose count as documentation', async () => {
  const table = (path: string, purpose = 'Read status') =>
    `| Method | Path | Description |\n| --- | --- | --- |\n| GET | \`${path}\` | ${purpose} |`;
  const fixture = [
    table('/visible'),
    `<!--\n${table('/commented')}\n-->`,
    `~~~markdown\n${table('/example')}\n~~~`,
    table('/blank', '   '),
    '| GET | `/outside-table` | Read status |',
  ].join('\n\n');
  expect(await referenceOperations(fixture)).toEqual([{ method: 'GET', path: '/visible' }]);
});

test('every generated API path has a reference table row', () => {
  const documented = new Set(documentedOperations.map(operation => operation.path));
  const missing = [...new Set(routes.map(route => route.path))].filter(path => !documented.has(path));
  expect(missing).toEqual([]);
});

test('every generated API operation has a method and purpose in the reference', () => {
  const documented = new Set(documentedOperations.map(operation => `${operation.method} ${operation.path}`));
  const missing = routes
    .map(route => `${route.method} ${route.path}`)
    .filter(operation => !documented.has(operation));
  expect(routes.length).toBeGreaterThan(0);
  expect(missing).toEqual([]);
});
