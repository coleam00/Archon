import { expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

const path = join(import.meta.dir, '../../workflows/sdlc/intake/scripts/bench/runner.ts');
const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);

function functionBody(name: string): ts.Block {
  const declaration = source.statements.find(
    (node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name
  );
  if (declaration?.body === undefined) throw new Error(`missing function ${name}`);
  return declaration.body;
}

function calls(node: ts.Node): string[] {
  const names: string[] = [];
  const visit = (child: ts.Node): void => {
    if (ts.isCallExpression(child) && ts.isIdentifier(child.expression)) names.push(child.expression.text);
    ts.forEachChild(child, visit);
  };
  visit(node);
  return names;
}

it.each(['copyRows', 'runBatch'])('%s derives canonical copy keys from the same owner', name => {
  expect(calls(functionBody(name))).toContain('canonicalCopyKey');
});

it('derives monitored source prefixes from the snapshot issue key owner', () => {
  let prefix: ts.VariableDeclaration | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'setPrefixes') prefix = node;
    ts.forEachChild(node, visit);
  };
  visit(functionBody('runBatch'));
  if (prefix?.initializer === undefined) throw new Error('missing setPrefixes initializer');
  expect(calls(prefix.initializer)).toContain('issueKey');
});
