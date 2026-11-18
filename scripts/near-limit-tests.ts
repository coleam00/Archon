import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { DEFAULT_TEST_TIMEOUT_MS } from '@archon/paths/test-utils';
import { SaxesParser } from 'saxes';
import ts from 'typescript';

/**
 * Lists the tests that used more than half of their time limit, from the JUnit reports the
 * test runners write when `ARCHON_TEST_REPORT_DIR` is set (see `bunTestCommand`). The Windows
 * CI jobs run it after their tests, so a test drifting toward its limit shows on the run page
 * before it fails on a slow runner (#5835). It reports and never gates.
 *
 * Bun's JUnit report has each test's time, file and line, but not its limit, so the limit is
 * read from the `test`/`it` call whose name is on that line. `<report-dir>/<cwd-key>/` names the
 * directory the test process ran in, which a report's `file` is relative to.
 */

const REPO_ROOT = join(import.meta.dir, '..');

export interface TestTime {
  /** The test file, relative to the repository root. */
  path: string;
  line: number;
  name: string;
  seconds: number;
}

/** A limit in milliseconds, or `undefined` when the call's limit is not a form this reads. */
export type Limit = number | undefined;

const TEST_CALLEES = new Set(['test', 'it']);

/** `test`, `it.skip`, `test.each(rows)` and the like: the name the call chain starts from. */
function testCallee(expression: ts.Expression): boolean {
  if (ts.isIdentifier(expression)) return TEST_CALLEES.has(expression.text);
  if (ts.isPropertyAccessExpression(expression)) return testCallee(expression.expression);
  if (ts.isCallExpression(expression)) return testCallee(expression.expression);
  return false;
}

/**
 * The value of a limit expression, or `undefined` for a form this does not read: a call
 * other than `testTimeout(n)`, a non-`const` binding, or options that could carry it in a
 * spread or computed key.
 */
function numberValue(node: ts.Expression, checker: ts.TypeChecker): Limit {
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (ts.isIdentifier(node)) return constValue(node, checker);
  if (ts.isObjectLiteralExpression(node)) return optionsValue(node, checker);
  if (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'testTimeout' &&
    node.arguments.length === 1
  ) {
    const value = numberValue(node.arguments[0], checker);
    return value === undefined ? undefined : Math.max(value, DEFAULT_TEST_TIMEOUT_MS);
  }
  return undefined;
}

/**
 * A name resolved through the checker, so the binding in scope at the call wins over a
 * same-named one elsewhere. Only a `const` counts: a `let` may change before the test runs.
 */
function constValue(name: ts.Identifier, checker: ts.TypeChecker): Limit {
  const declaration = checker.getSymbolAtLocation(name)?.valueDeclaration;
  if (declaration === undefined || !ts.isVariableDeclaration(declaration)) return undefined;
  const isConst = (ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) !== 0;
  return isConst && declaration.initializer !== undefined
    ? numberValue(declaration.initializer, checker)
    : undefined;
}

/** `{ timeout: n }`, with the key quoted or not; options without one take the default. */
function optionsValue(options: ts.ObjectLiteralExpression, checker: ts.TypeChecker): Limit {
  for (const property of options.properties) {
    if (!ts.isPropertyAssignment(property)) return undefined;
    const key = property.name;
    if (ts.isComputedPropertyName(key) || ts.isPrivateIdentifier(key)) return undefined;
    if (key.text === 'timeout') return numberValue(property.initializer, checker);
  }
  return DEFAULT_TEST_TIMEOUT_MS;
}

/** A program of one file, so the checker can resolve the names in it; imports are not read. */
function checkedSource(source: string): { file: ts.SourceFile; checker: ts.TypeChecker } {
  const fileName = 'test.ts';
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const options: ts.CompilerOptions = { noLib: true, noResolve: true, types: [] };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = name => (name === fileName ? file : undefined);
  host.fileExists = name => name === fileName;
  host.readFile = () => undefined;
  const program = ts.createProgram([fileName], options, host);
  return { file, checker: program.getTypeChecker() };
}

/** The limit of every test call in one source file, by the line Bun reports it at. */
export function testLimits(source: string): Map<number, Limit> {
  const { file, checker } = checkedSource(source);
  const limits = new Map<number, Limit>();
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && testCallee(node.expression)) {
      // Bun reports a test at the line of its name, which is not the call's first line when
      // the call spans lines. Only the outermost call registers a test, so the inner
      // `test.each(rows)` or `test.skipIf(x)` of the chain is not visited.
      const name = node.arguments[0] ?? node;
      const line = file.getLineAndCharacterOfPosition(name.getStart(file)).line + 1;
      const limit = node.arguments[2];
      limits.set(line, limit === undefined ? DEFAULT_TEST_TIMEOUT_MS : numberValue(limit, checker));
      for (const argument of node.arguments) visit(argument);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return limits;
}

/** Every test case in one Bun JUnit report, with its file relative to the repository root. */
export function reportTimes(xml: string, cwdKey: string): TestTime[] {
  const times: TestTime[] = [];
  const base = cwdKey === 'root' ? '' : `${cwdKey}/`;
  const parser = new SaxesParser();
  parser.on('opentag', tag => {
    if (tag.name !== 'testcase') return;
    const { name, time, file, line } = tag.attributes as Record<string, string | undefined>;
    // Bun writes a load error as a testcase with no file; it has no time worth reporting.
    if (file === undefined || line === undefined) return;
    const seconds = Number(time);
    if (name === undefined || !Number.isFinite(seconds) || !Number.isInteger(Number(line))) {
      throw new Error(`Malformed JUnit testcase: ${JSON.stringify(tag.attributes)}`);
    }
    times.push({ path: `${base}${file.replaceAll('\\', '/')}`, line: Number(line), name, seconds });
  });
  parser.write(xml).close();
  return times;
}

export interface NearLimit extends TestTime {
  limitMs: Limit;
  /** Time over limit; for a limit not read, over the default limit. */
  share: number;
}

/**
 * The tests over half their limit, most of their limit first. A test whose limit this cannot
 * read is measured against the default limit. That can hide one whose real limit is smaller,
 * so the report also counts the tests whose limit was not read.
 */
export function nearLimit(times: readonly TestTime[], limitOf: (time: TestTime) => Limit) {
  const listed: NearLimit[] = [];
  for (const time of times) {
    const limitMs = limitOf(time);
    const share = (time.seconds * 1000) / (limitMs ?? DEFAULT_TEST_TIMEOUT_MS);
    if (share > 0.5) listed.push({ ...time, limitMs, share });
  }
  return listed.sort((a, b) => b.share - a.share);
}

function reportFiles(directory: string): { file: string; cwdKey: string }[] {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.xml'))
    .map(entry => {
      const file = join(entry.parentPath, entry.name);
      return { file, cwdKey: relative(directory, entry.parentPath).replaceAll('\\', '/') };
    });
}

function table(listed: readonly NearLimit[]): string {
  const rows = listed.map(test => {
    const limit = test.limitMs === undefined ? 'not read' : `${String(test.limitMs / 1000)} s`;
    const name = test.name.replaceAll('|', '\\|');
    return `| ${Math.round(test.share * 100)}% | ${test.seconds.toFixed(1)} s | ${limit} | \`${test.path}:${test.line}\` | ${name} |`;
  });
  return ['| Share | Time | Limit | Test | Name |', '|---|---|---|---|---|', ...rows].join('\n');
}

/** A workflow command's message ends at a newline, and `%` starts an escape. */
function escapeCommand(message: string): string {
  return message.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
}

function main(directory: string | undefined): void {
  if (directory === undefined) throw new Error('Usage: bun scripts/near-limit-tests.ts <dir>');
  const reports = existsSync(directory) ? reportFiles(directory) : [];
  if (reports.length === 0) {
    console.log(`No test reports under ${directory}: no test process ran.`);
    return;
  }
  const sources = new Map<string, Map<number, Limit>>();
  const limitOf = (time: TestTime): Limit => {
    let limits = sources.get(time.path);
    if (limits === undefined) {
      limits = testLimits(readFileSync(join(REPO_ROOT, time.path), 'utf8'));
      sources.set(time.path, limits);
    }
    return limits.has(time.line) ? limits.get(time.line) : undefined;
  };
  const times = reports.flatMap(({ file, cwdKey }) =>
    reportTimes(readFileSync(file, 'utf8'), cwdKey)
  );
  const listed = nearLimit(times, limitOf);
  const unread = times.filter(time => limitOf(time) === undefined).length;
  const heading = `### Tests over half their time limit (${String(listed.length)} of ${String(times.length)}; limit not read for ${String(unread)}, measured against the default)`;
  const body = listed.length === 0 ? 'None.' : table(listed);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary !== undefined && summary !== '') appendFileSync(summary, `${heading}\n\n${body}\n`);
  else console.log(`${heading}\n\n${body}`);
  for (const test of listed) {
    const message = `${String(Math.round(test.share * 100))}% of its time limit: ${test.name}`;
    console.log(`::warning file=${test.path},line=${String(test.line)}::${escapeCommand(message)}`);
  }
}

if (import.meta.main) main(Bun.argv[2]);
