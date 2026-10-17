import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import ts from 'typescript';

/**
 * A change may not make a touched function more complex, or a touched file longer, than it was
 * at the merge base. Both sides come from git: the merge base of `baseRef` and HEAD, against the
 * working tree. Nothing is committed as a baseline, so no edit in the change can move the
 * reference point. The file set is the TS/JS sources Biome lints, read from the merge base's
 * `biome.jsonc`, so a change cannot exclude its own file either. Untouched files are not scored.
 *
 * Complexity is SonarSource cognitive complexity per function unit, owned by this script (Biome
 * reports only threshold violations, in prose). Both sides use the same scorer, so its numbers
 * need not match Biome's:
 * - `+1 + nesting` for `if`, `?:`, `switch`, loops and `catch`; their bodies nest one deeper.
 * - `+1` for `else`, `else if` and a labelled `break`/`continue`.
 * - `+1` per run of the same logical operator: `a && b && c` is 1, `a && b || c` is 2.
 * - A nested function is its own unit and adds nothing to the function around it, so a route
 *   table of inline handlers ratchets each handler on its own.
 *
 * A unit's identity is its naming path inside the file (`outer > inner`), so a function that
 * moves between touched files keeps it and is compared with its old score. A function with no
 * base counterpart is new and is not refused: the gate is the delta, not a threshold.
 *
 * A deliberate increase lands with a `Ratchet-Allow:` trailer on one of the change's commits:
 * `Ratchet-Allow: <path>` for a file's line count, `Ratchet-Allow: <path>:<identity>` for a
 * function. A trailer lives only in the commits after the merge base, so it waives this change
 * and nothing after it.
 */

const REPO_ROOT = resolve(import.meta.dir, '..');
const SOURCE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const LOGICAL_OPERATORS = new Set([
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionToken,
]);

type FunctionUnit =
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration
  | ts.ConstructorDeclaration;

function isFunctionUnit(node: ts.Node): node is FunctionUnit {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node)
  );
}

// A unit's name shows an argument only when it is a simple token. Any other argument, such as
// a callback or an object literal, is `_`: its source would put one callback's body into a
// sibling's identity, so editing `p.then(a => ...)` would rename the `.catch(...)` after it.
function simpleToken(node: ts.Node): string | undefined {
  if (
    ts.isIdentifier(node) ||
    node.kind === ts.SyntaxKind.ThisKeyword ||
    ts.isStringLiteralLike(node) ||
    ts.isNumericLiteral(node)
  ) {
    return node.getText();
  }
  if (!ts.isPropertyAccessExpression(node)) return undefined;
  const object = simpleToken(node.expression);
  return object === undefined ? undefined : `${object}.${node.name.text}`;
}

const token = (node: ts.Node): string => simpleToken(node) ?? '_';

function calleeName(node: ts.Expression): string {
  if (ts.isPropertyAccessExpression(node))
    return `${calleeName(node.expression)}.${node.name.text}`;
  if (ts.isElementAccessExpression(node)) {
    return `${calleeName(node.expression)}[${token(node.argumentExpression)}]`;
  }
  if (ts.isCallExpression(node)) {
    return `${calleeName(node.expression)}(${node.arguments.map(token).join(',')})`;
  }
  if (ts.isNonNullExpression(node) || ts.isParenthesizedExpression(node)) {
    return calleeName(node.expression);
  }
  if (ts.isIdentifier(node) || node.kind === ts.SyntaxKind.ThisKeyword) return node.getText();
  return '<expr>';
}

function callLabel(call: ts.CallExpression | ts.NewExpression): string {
  const callee = calleeName(call.expression);
  const argument = call.arguments?.find(candidate => !ts.isFunctionLike(candidate));
  const label = argument === undefined ? '' : (simpleToken(argument) ?? '');
  return `${ts.isNewExpression(call) ? 'new ' : ''}${callee}(${label})`;
}

function unitName(node: FunctionUnit): string {
  if (ts.isConstructorDeclaration(node)) return 'constructor';
  if (ts.isGetAccessorDeclaration(node)) return `get ${node.name.getText()}`;
  if (ts.isSetAccessorDeclaration(node)) return `set ${node.name.getText()}`;
  if (ts.isMethodDeclaration(node)) return node.name.getText();
  if (node.name !== undefined) return node.name.text;
  const parent = node.parent;
  if (
    ts.isVariableDeclaration(parent) ||
    ts.isPropertyAssignment(parent) ||
    ts.isPropertyDeclaration(parent)
  ) {
    return parent.name.getText();
  }
  if (ts.isExportAssignment(parent)) return 'default';
  if (ts.isCallExpression(parent) || ts.isNewExpression(parent)) return callLabel(parent);
  if (ts.isJsxExpression(parent) && ts.isJsxAttribute(parent.parent)) {
    return parent.parent.name.getText();
  }
  return '<anonymous>';
}

function isNestingStructure(node: ts.Node): boolean {
  return (
    ts.isConditionalExpression(node) ||
    ts.isSwitchStatement(node) ||
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isWhileStatement(node) ||
    ts.isDoStatement(node) ||
    ts.isCatchClause(node)
  );
}

function score(unit: FunctionUnit): number {
  let total = 0;
  const visit = (node: ts.Node, nesting: number): void => {
    if (isFunctionUnit(node)) return;
    if (ts.isIfStatement(node)) {
      const isElseIf = ts.isIfStatement(node.parent) && node.parent.elseStatement === node;
      total += isElseIf ? 1 : 1 + nesting;
      visit(node.expression, nesting);
      visit(node.thenStatement, nesting + 1);
      const otherwise = node.elseStatement;
      if (otherwise === undefined) return;
      if (ts.isIfStatement(otherwise)) {
        visit(otherwise, nesting);
      } else {
        total += 1;
        visit(otherwise, nesting + 1);
      }
      return;
    }
    if (isNestingStructure(node)) {
      total += 1 + nesting;
      node.forEachChild(child => visit(child, nesting + 1));
      return;
    }
    if ((ts.isBreakStatement(node) || ts.isContinueStatement(node)) && node.label) total += 1;
    if (ts.isBinaryExpression(node) && LOGICAL_OPERATORS.has(node.operatorToken.kind)) {
      const parent = node.parent;
      const continuesRun =
        ts.isBinaryExpression(parent) && parent.operatorToken.kind === node.operatorToken.kind;
      if (!continuesRun) total += 1;
    }
    node.forEachChild(child => visit(child, nesting));
  };
  unit.forEachChild(child => visit(child, 0));
  return total;
}

/** Cognitive complexity per function identity. Same-identity units collapse to the highest. */
export function cognitiveUnits(file: string, source: string): Map<string, number> {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const units = new Map<string, number>();
  const walk = (node: ts.Node, path: readonly string[]): void => {
    if (isFunctionUnit(node)) {
      const unitPath = [...path, unitName(node)];
      const identity = unitPath.join(' > ');
      units.set(identity, Math.max(units.get(identity) ?? 0, score(node)));
      node.forEachChild(child => walk(child, unitPath));
      return;
    }
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      const classPath = [...path, node.name?.text ?? '<class>'];
      node.forEachChild(child => walk(child, classPath));
      return;
    }
    node.forEachChild(child => walk(child, path));
  };
  walk(sourceFile, []);
  return units;
}

export function lineCount(source: string): number {
  const newlines = source.split('\n').length - 1;
  return source.length > 0 && !source.endsWith('\n') ? newlines + 1 : newlines;
}

function git(args: readonly string[], repo: string): string {
  const result = Bun.spawnSync(['git', ...args], { cwd: repo, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode === 0) return result.stdout.toString();
  throw new Error(`Git command failed: git ${args.join(' ')}\n${result.stderr.toString().trim()}`);
}

function nulList(output: string): string[] {
  return output.split('\0').filter(entry => entry.length > 0);
}

/** Biome's `files.includes`, last match wins; a pattern also covers everything under it. */
export function biomeScope(biomeConfig: string): (path: string) => boolean {
  const config = Bun.JSONC.parse(biomeConfig) as { files?: { includes?: string[] } };
  const rules = (config.files?.includes ?? ['**']).map(pattern => {
    const glob = pattern.replace(/^!+/, '');
    return {
      include: !pattern.startsWith('!'),
      globs: [new Bun.Glob(glob), new Bun.Glob(`${glob}/**`)],
    };
  });
  return path => {
    if (!SOURCE_FILE.test(path) || path.endsWith('.d.ts')) return false;
    let included = false;
    for (const rule of rules) {
      if (rule.globs.some(glob => glob.match(path))) included = rule.include;
    }
    return included;
  };
}

/**
 * Head path → base path, or null for a file the base does not have. A rename is compared with
 * the file it was renamed from.
 */
function touchedPaths(mergeBase: string, repo: string): Map<string, string | null> {
  const touched = new Map<string, string | null>();
  const entries = nulList(git(['diff', '--name-status', '-z', '-M', mergeBase], repo));
  for (let index = 0; index < entries.length; ) {
    const status = entries[index++];
    if (status.startsWith('R')) {
      const from = entries[index++];
      touched.set(from, from);
      touched.set(entries[index++], from);
    } else {
      const path = entries[index++];
      touched.set(path, status === 'A' ? null : path);
    }
  }
  for (const path of nulList(git(['ls-files', '--others', '--exclude-standard', '-z'], repo))) {
    touched.set(path, null);
  }
  return touched;
}

function headContent(path: string, repo: string): string | null {
  const file = join(repo, path);
  return existsSync(file) ? readFileSync(file, 'utf8') : null;
}

function allowances(mergeBase: string, repo: string): Set<string> {
  const output = git(
    [
      'log',
      '--format=%(trailers:key=Ratchet-Allow,valueonly,separator=%x00)%x00',
      `${mergeBase}..HEAD`,
    ],
    repo
  );
  return new Set(nulList(output).map(value => value.trim()));
}

interface Scores {
  lines: number;
  units: Map<string, number>;
}

interface ScoredFile {
  path: string;
  base: Scores | null;
  head: Scores | null;
}

function scored(path: string, content: string | null): Scores | null {
  return content === null
    ? null
    : { lines: lineCount(content), units: cognitiveUnits(path, content) };
}

export interface RatchetResult {
  failures: string[];
  allowed: string[];
  /** The trailers that would allow every failure. */
  remedies: string[];
}

export function checkRatchet(repo: string, baseRef: string): RatchetResult {
  let mergeBase: string;
  try {
    mergeBase = git(['merge-base', baseRef, 'HEAD'], repo).trim();
  } catch (error) {
    const branch = baseRef.replace(/^origin\//, '');
    throw new Error(
      `Cannot find the merge base with ${baseRef}. Fetch it first: git fetch origin ${branch}\n${(error as Error).message}`
    );
  }
  const inScope = biomeScope(git(['show', `${mergeBase}:biome.jsonc`], repo));

  const files: ScoredFile[] = [];
  for (const [headPath, basePath] of touchedPaths(mergeBase, repo)) {
    const base =
      basePath !== null && inScope(basePath)
        ? scored(basePath, git(['show', `${mergeBase}:${basePath}`], repo))
        : null;
    const head = inScope(headPath) ? scored(headPath, headContent(headPath, repo)) : null;
    if (base !== null || head !== null) files.push({ path: headPath, base, head });
  }

  // Base units whose identity left their file: the candidates a moved function is compared with.
  const moved = new Map<string, { file: string; score: number }>();
  for (const file of files) {
    for (const [identity, before] of file.base?.units ?? []) {
      if (file.head?.units.has(identity)) continue;
      const current = moved.get(identity);
      if (current === undefined || before > current.score) {
        moved.set(identity, { file: file.path, score: before });
      }
    }
  }

  const allow = allowances(mergeBase, repo);
  const result: RatchetResult = { failures: [], allowed: [], remedies: [] };
  const report = (finding: string, key: string): void => {
    if (allow.has(key)) {
      result.allowed.push(`${finding} (allowed by Ratchet-Allow: ${key})`);
    } else {
      result.failures.push(finding);
      result.remedies.push(`Ratchet-Allow: ${key}`);
    }
  };

  for (const { path, base, head } of files) {
    if (head === null) continue;
    for (const [identity, after] of head.units) {
      const sameFile = base?.units.get(identity);
      const origin = sameFile === undefined ? moved.get(identity) : undefined;
      const before = sameFile ?? origin?.score;
      if (before === undefined || after <= before) continue;
      const from = origin === undefined ? '' : ` (base: ${origin.file})`;
      report(
        `${path}: \`${identity}\` cognitive complexity ${before} -> ${after}${from}`,
        `${path}:${identity}`
      );
    }
    if (base !== null && head.lines > base.lines) {
      report(`${path}: ${base.lines} -> ${head.lines} lines`, path);
    }
  }
  return result;
}

if (import.meta.main) {
  const baseBranch = process.env.GITHUB_BASE_REF || 'dev';
  const { failures, allowed, remedies } = checkRatchet(REPO_ROOT, `origin/${baseBranch}`);
  for (const line of allowed) console.log(line);
  if (failures.length > 0) {
    console.error(
      [
        'Complexity ratchet failed:',
        ...failures.map(failure => `  ${failure}`),
        'Bring each back to its base value or lower. To land an increase on purpose, add a commit trailer for it:',
        ...remedies.map(remedy => `  ${remedy}`),
      ].join('\n')
    );
    process.exit(1);
  }
  console.log('Ratchet check passed.');
}
