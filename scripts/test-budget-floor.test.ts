import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import { WINDOWS_TEST_TIMEOUT_MS } from '@archon/paths/test-utils';
import { gitOutput } from './check-test-cleanup-drift';

const REPO_ROOT = resolve(import.meta.dir, '..');
const TEST_FILE = /\.(?:test|spec)\.(?:[cm]?ts|tsx)$/;

/**
 * Position of the budget argument: `it(name, fn, budget)`, `beforeAll(fn, budget)` and
 * `setDefaultTimeout(budget)`, which replaces the floor for every test in the file. `describe`
 * is absent because Bun 1.4 ignores a budget passed to it.
 */
const BUDGET_INDEX = new Map([
  ['it', 2],
  ['test', 2],
  ['beforeAll', 1],
  ['beforeEach', 1],
  ['afterAll', 1],
  ['afterEach', 1],
  ['setDefaultTimeout', 0],
]);

/** Local names each `bun:test` export is bound to in this file, aliases included. */
function bunTestBindings(sourceFile: ts.SourceFile): {
  names: Map<string, string>;
  namespaces: Set<string>;
} {
  const names = new Map<string, string>();
  const namespaces = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== 'bun:test'
    )
      continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined) continue;
    if (ts.isNamespaceImport(bindings)) {
      namespaces.add(bindings.name.text);
      continue;
    }
    for (const element of bindings.elements) {
      const imported = element.propertyName?.text ?? element.name.text;
      if (BUDGET_INDEX.has(imported)) names.set(element.name.text, imported);
    }
  }
  return { names, namespaces };
}

/**
 * The `bun:test` function a call ultimately invokes, through modifier and table forms such as
 * `it.skip(...)`, `test.if(cond)(...)` and `it.each(rows)(...)`.
 */
function calledTestFunction(
  call: ts.CallExpression,
  bindings: ReturnType<typeof bunTestBindings>
): string | undefined {
  let callee: ts.Expression = call.expression;
  for (;;) {
    if (ts.isIdentifier(callee)) return bindings.names.get(callee.text);
    if (ts.isCallExpression(callee)) {
      callee = callee.expression;
      continue;
    }
    if (!ts.isPropertyAccessExpression(callee)) return undefined;
    if (
      ts.isIdentifier(callee.expression) &&
      bindings.namespaces.has(callee.expression.text) &&
      BUDGET_INDEX.has(callee.name.text)
    )
      return callee.name.text;
    callee = callee.expression;
  }
}

function numericValue(node: ts.Expression): number | undefined {
  return ts.isNumericLiteral(node) ? Number(node.text.replaceAll('_', '')) : undefined;
}

/** Module-level `const NAME = <number>` declarations, so a named budget is judged by its value. */
function numericConstants(sourceFile: ts.SourceFile): Map<string, number> {
  const constants = new Map<string, number>();
  for (const statement of sourceFile.statements) {
    if (
      !ts.isVariableStatement(statement) ||
      !(statement.declarationList.flags & ts.NodeFlags.Const)
    )
      continue;
    for (const declaration of statement.declarationList.declarations) {
      const value =
        declaration.initializer === undefined ? undefined : numericValue(declaration.initializer);
      if (ts.isIdentifier(declaration.name) && value !== undefined)
        constants.set(declaration.name.text, value);
    }
  }
  return constants;
}

/**
 * A budget is allowed in two forms only: `testTimeout(...)`, which applies the Windows floor,
 * or a number above the floor, which needs none, written as a literal or a module-level
 * numeric constant. Anything else (a number at or below the floor, an expression, an imported
 * name) is rejected rather than evaluated, so a budget below the floor cannot hide behind one.
 */
function budgetViolation(
  budget: ts.Expression,
  constants: Map<string, number>
): string | undefined {
  if (
    ts.isCallExpression(budget) &&
    ts.isIdentifier(budget.expression) &&
    budget.expression.text === 'testTimeout'
  )
    return undefined;
  const value = ts.isIdentifier(budget) ? constants.get(budget.text) : numericValue(budget);
  if (value !== undefined && value > WINDOWS_TEST_TIMEOUT_MS) return undefined;
  if (ts.isObjectLiteralExpression(budget)) {
    for (const property of budget.properties) {
      if (ts.isShorthandPropertyAssignment(property) && property.name.text === 'timeout')
        return budgetViolation(property.name, constants);
      if (
        ts.isPropertyAssignment(property) &&
        (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
        property.name.text === 'timeout'
      )
        return budgetViolation(property.initializer, constants);
    }
    return undefined;
  }
  return budget.getText();
}

function checkBudgets(file: string, source: string): string[] {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const bindings = bunTestBindings(sourceFile);
  const constants = numericConstants(sourceFile);
  const violations: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const name = calledTestFunction(node, bindings);
      const index = name === undefined ? undefined : BUDGET_INDEX.get(name);
      const budget = index === undefined ? undefined : node.arguments[index];
      const violation = budget === undefined ? undefined : budgetViolation(budget, constants);
      if (budget !== undefined && violation !== undefined) {
        const line = sourceFile.getLineAndCharacterOfPosition(budget.getStart(sourceFile)).line;
        violations.push(`${file}:${line + 1} ${name} budget ${violation}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return violations;
}

describe('explicit test budgets respect the Windows floor', () => {
  it('rejects raw budgets at or below the floor in every form the runner honours', () => {
    const source = `
      import { it as check, beforeAll } from 'bun:test';
      import * as bt from 'bun:test';
      const LIMIT = 10_000;
      check('a', () => {}, 10_000);
      check.skip('b', () => {}, ${WINDOWS_TEST_TIMEOUT_MS});
      check.each([1])('c %d', () => {}, { timeout: 8000 });
      beforeAll(() => {}, LIMIT);
      bt.test('d', () => {}, 1_000);
      check('e', () => {}, LIMIT + 5_000);
      check('f', () => {}, IMPORTED_LIMIT);
      const timeout = 8_000;
      check('g', () => {}, { timeout });
      check('h', () => {}, { 'timeout': 9_000 });
      bt.setDefaultTimeout(5_000);
    `;
    expect(checkBudgets('x.test.ts', source)).toEqual([
      'x.test.ts:5 it budget 10_000',
      `x.test.ts:6 it budget ${WINDOWS_TEST_TIMEOUT_MS}`,
      'x.test.ts:7 it budget 8000',
      'x.test.ts:8 beforeAll budget LIMIT',
      'x.test.ts:9 test budget 1_000',
      'x.test.ts:10 it budget LIMIT + 5_000',
      'x.test.ts:11 it budget IMPORTED_LIMIT',
      'x.test.ts:13 it budget timeout',
      'x.test.ts:14 it budget 9_000',
      'x.test.ts:15 setDefaultTimeout budget 5_000',
    ]);
  });

  it('accepts testTimeout, budgets above the floor, and calls outside bun:test', () => {
    const source = `
      import { it } from 'bun:test';
      const SLOW = 30_000;
      const timeout = 30_000;
      it('a', () => {}, testTimeout(10_000));
      it('b', () => {}, 30_000);
      it('c', () => {}, { timeout: testTimeout(8_000) });
      it('d', () => {});
      it('e', () => {}, SLOW);
      it('f', () => {}, { timeout });
      setTimeout(() => {}, 1_000);
      execFile('git', [], { timeout: 5_000 });
    `;
    expect(checkBudgets('x.test.ts', source)).toEqual([]);
  });

  it('no test file in the repository sets a raw budget at or below the floor', () => {
    const files = gitOutput(['ls-files'], REPO_ROOT)
      .split('\n')
      .filter(file => TEST_FILE.test(file));
    const violations = files.flatMap(file =>
      checkBudgets(file, readFileSync(join(REPO_ROOT, file), 'utf8'))
    );
    // A raw budget at or below WINDOWS_TEST_TIMEOUT_MS replaces the Windows floor rather than
    // adding to it. Delete it if Bun's default is enough, or wrap it in testTimeout().
    expect(violations).toEqual([]);
  });
});
