import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import ts from 'typescript';

const REPO_ROOT = resolve(import.meta.dir, '..');
const SOURCE_FILE = /\.(?:[cm]?ts|[cm]?js|tsx)$/;
const TEST_FILE = /\.(?:test|spec)\.(?:[cm]?ts|[cm]?js|tsx)$/;
const FS_MODULES = new Set(['fs', 'node:fs', 'fs/promises', 'node:fs/promises']);
const RM_NAMES = new Set(['rm', 'rmSync']);
const RETRY_OPTIONS = new Set(['maxRetries', 'retryDelay']);

/**
 * `retry-options` is repo-wide law: Bun parses and ignores `maxRetries`/`retryDelay`, so any
 * occurrence is inert code. `recursive-cleanup` predates the shared helpers and still has a
 * frozen inventory, so it is scoped per file against `LEGACY_RECURSIVE_CLEANUP`.
 */
export type DriftRule = 'retry-options' | 'recursive-cleanup';

export interface DriftViolation {
  file: string;
  line: number;
  rule: DriftRule;
  message: string;
}

interface FsBindings {
  functions: Map<string, string>;
  namespaces: Set<string>;
  promiseNamespaces: Set<string>;
}

function fsBindings(sourceFile: ts.SourceFile): FsBindings {
  const functions = new Map<string, string>();
  const namespaces = new Set<string>();
  const promiseNamespaces = new Set<string>();

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
      continue;
    const module = statement.moduleSpecifier.text;
    if (!FS_MODULES.has(module) || statement.importClause === undefined) continue;

    const { importClause } = statement;
    const isPromiseModule = module === 'fs/promises' || module === 'node:fs/promises';
    if (importClause.name !== undefined) {
      (isPromiseModule ? promiseNamespaces : namespaces).add(importClause.name.text);
    }
    const bindings = importClause.namedBindings;
    if (bindings === undefined) continue;
    if (ts.isNamespaceImport(bindings)) {
      (isPromiseModule ? promiseNamespaces : namespaces).add(bindings.name.text);
      continue;
    }
    for (const element of bindings.elements) {
      const importedName = element.propertyName?.text ?? element.name.text;
      if (importedName === 'promises' && !isPromiseModule) {
        promiseNamespaces.add(element.name.text);
      } else if (RM_NAMES.has(importedName) && (!isPromiseModule || importedName === 'rm')) {
        functions.set(element.name.text, importedName);
      }
    }
  }

  return { functions, namespaces, promiseNamespaces };
}

function rmCallName(call: ts.CallExpression, bindings: FsBindings): string | undefined {
  if (ts.isIdentifier(call.expression)) {
    return bindings.functions.get(call.expression.text);
  }
  if (!ts.isPropertyAccessExpression(call.expression)) return undefined;

  const { expression, name } = call.expression;
  if (ts.isIdentifier(expression)) {
    if (bindings.namespaces.has(expression.text) && RM_NAMES.has(name.text)) return name.text;
    if (bindings.promiseNamespaces.has(expression.text) && name.text === 'rm') return 'rm';
  }
  if (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    bindings.namespaces.has(expression.expression.text) &&
    expression.name.text === 'promises' &&
    name.text === 'rm'
  ) {
    return 'rm';
  }
  return undefined;
}

function propertyName(property: ts.PropertyAssignment): string | undefined {
  const { name } = property;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return ts.isComputedPropertyName(name) && ts.isStringLiteral(name.expression)
    ? name.expression.text
    : undefined;
}

function hasOption(
  call: ts.CallExpression,
  matches: (property: ts.PropertyAssignment) => boolean
): boolean {
  const options = call.arguments[1];
  if (options === undefined || !ts.isObjectLiteralExpression(options)) return false;
  return options.properties.some(
    property => ts.isPropertyAssignment(property) && matches(property)
  );
}

const hasRecursiveOption = (call: ts.CallExpression): boolean =>
  hasOption(
    call,
    property =>
      propertyName(property) === 'recursive' &&
      property.initializer.kind === ts.SyntaxKind.TrueKeyword
  );

const hasRetryOption = (call: ts.CallExpression): boolean =>
  hasOption(call, property => RETRY_OPTIONS.has(propertyName(property) ?? ''));

/**
 * `before*` counts as cleanup too: clearing stale state at setup time removes the same tree with
 * the same Windows lock exposure, so the shared helpers apply there for the same reason.
 */
const HOOK_NAMES = new Set(['afterEach', 'afterAll', 'beforeEach', 'beforeAll']);

interface CleanupBindings {
  hooks: Set<string>;
  namespaces: Set<string>;
  /** Same-file functions a hook reaches, by reference or through a call chain. */
  reachable: Set<string>;
}

/** Same-file `function` declarations and `const`-bound function expressions, by name. */
function sameFileFunctions(sourceFile: ts.SourceFile): Map<string, ts.Node> {
  const byName = new Map<string, ts.Node>();
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
      byName.set(node.name.text, node);
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      byName.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return byName;
}

/** Bare identifiers called within a node; a `foo.bar()` member call is not one. */
function calledNames(node: ts.Node): string[] {
  const names: string[] = [];
  const visit = (current: ts.Node): void => {
    if (ts.isCallExpression(current) && ts.isIdentifier(current.expression)) {
      names.push(current.expression.text);
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return names;
}

function isHookCall(call: ts.CallExpression, hooks: Set<string>, namespaces: Set<string>): boolean {
  if (ts.isIdentifier(call.expression)) return hooks.has(call.expression.text);
  return (
    ts.isPropertyAccessExpression(call.expression) &&
    ts.isIdentifier(call.expression.expression) &&
    namespaces.has(call.expression.expression.text) &&
    HOOK_NAMES.has(call.expression.name.text)
  );
}

function cleanupBindings(sourceFile: ts.SourceFile): CleanupBindings {
  const hooks = new Set(HOOK_NAMES);
  const namespaces = new Set<string>();

  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== 'bun:test' ||
      statement.importClause === undefined
    ) {
      continue;
    }

    const bindings = statement.importClause.namedBindings;
    if (bindings === undefined) continue;
    if (ts.isNamespaceImport(bindings)) {
      namespaces.add(bindings.name.text);
      continue;
    }
    for (const element of bindings.elements) {
      const importedName = element.propertyName?.text ?? element.name.text;
      if (HOOK_NAMES.has(importedName)) hooks.add(element.name.text);
    }
  }

  const functions = sameFileFunctions(sourceFile);
  const reachable = new Set<string>();
  const pending: string[] = [];
  const reach = (name: string): void => {
    if (reachable.has(name)) return;
    reachable.add(name);
    pending.push(name);
  };

  const collect = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isHookCall(node, hooks, namespaces)) {
      for (const argument of node.arguments) {
        if (ts.isIdentifier(argument)) reach(argument.text);
        else if (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)) {
          for (const called of calledNames(argument)) reach(called);
        }
      }
    }
    ts.forEachChild(node, collect);
  };
  collect(sourceFile);

  // Cleanup is routinely one hop further out than the hook body, so follow the call chain to a
  // fixed point. Names that resolve to no same-file function (an import, `rm` itself) drop out.
  for (let name = pending.pop(); name !== undefined; name = pending.pop()) {
    const declaration = functions.get(name);
    if (declaration === undefined) continue;
    for (const called of calledNames(declaration)) reach(called);
  }

  return { hooks, namespaces, reachable };
}

function isInlineCleanupCallback(node: ts.Node, bindings: CleanupBindings): boolean {
  if (!ts.isArrowFunction(node) && !ts.isFunctionExpression(node)) return false;
  const parent = node.parent;
  return (
    ts.isCallExpression(parent) &&
    parent.arguments.includes(node as ts.Expression) &&
    isHookCall(parent, bindings.hooks, bindings.namespaces)
  );
}

/**
 * Extracting a hook body into a shared function is exactly what this checker's own message asks
 * for, so the rule has to follow the reference. Resolution is same-file and by name only: a
 * callback imported from another module is not tracked.
 */
function isReachableCleanup(node: ts.Node, reachable: Set<string>): boolean {
  if (ts.isFunctionDeclaration(node)) {
    return node.name !== undefined && reachable.has(node.name.text);
  }
  if (!ts.isArrowFunction(node) && !ts.isFunctionExpression(node)) return false;
  const parent = node.parent;
  return (
    ts.isVariableDeclaration(parent) &&
    ts.isIdentifier(parent.name) &&
    reachable.has(parent.name.text)
  );
}

function isInCleanup(node: ts.Node, bindings: CleanupBindings): boolean {
  for (let current: ts.Node | undefined = node; current !== undefined; current = current.parent) {
    if (
      ts.isBlock(current) &&
      ts.isTryStatement(current.parent) &&
      current.parent.finallyBlock === current
    ) {
      return true;
    }
    if (isInlineCleanupCallback(current, bindings)) return true;
    if (isReachableCleanup(current, bindings.reachable)) return true;
  }
  return false;
}

export function checkSource(file: string, source: string): DriftViolation[] {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const bindings = fsBindings(sourceFile);
  const cleanup = cleanupBindings(sourceFile);
  const violations: DriftViolation[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const name = rmCallName(node, bindings);
      if (name !== undefined) {
        const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
        if (hasRetryOption(node)) {
          violations.push({
            file,
            line,
            rule: 'retry-options',
            message: `${name} options must not use maxRetries or retryDelay; Bun ignores them`,
          });
        }
        if (TEST_FILE.test(file) && hasRecursiveOption(node) && isInCleanup(node, cleanup)) {
          violations.push({
            file,
            line,
            rule: 'recursive-cleanup',
            message: `recursive ${name} test cleanup must use removeTempTree or trackTempRoots`,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return violations;
}

/**
 * The ledger is edited by hand on every cleanup, so it validates itself at module load: a
 * duplicate key would otherwise keep the last value silently, which a conflict resolution can
 * produce and no later check would notice.
 */
export function buildLedger(entries: readonly (readonly [string, number])[]): Map<string, number> {
  const ledger = new Map<string, number>();
  for (const [file, count] of entries) {
    if (ledger.has(file)) throw new Error(`Duplicate cleanup ledger entry for ${file}`);
    if (!Number.isInteger(count) || count < 1) {
      throw new Error(`Cleanup ledger entry for ${file} must be a positive integer, got ${count}`);
    }
    ledger.set(file, count);
  }
  return ledger;
}

/**
 * Recursive test cleanup that predates the shared helpers from PR #2874. Rewriting this
 * inventory is out of scope for #2885, so these counts freeze it: a file may not gain a site,
 * and an entry must be lowered or deleted once a file is cleaned up. The counts are exact
 * rather than a ceiling so the ledger cannot rot high after a cleanup and quietly reopen the
 * hole it was recording.
 */
export const LEGACY_RECURSIVE_CLEANUP: ReadonlyMap<string, number> = buildLedger([
  ['.archon/scripts/__tests__/marketplace-fetch-source.test.ts', 2],
  ['.archon/scripts/maintainer-standup-persist.test.ts', 1],
  ['packages/cli/src/commands/doctor.test.ts', 2],
  ['packages/cli/src/commands/serve.test.ts', 1],
  ['packages/cli/src/commands/setup.test.ts', 4],
  ['packages/cli/src/commands/skill.test.ts', 2],
  ['packages/cli/src/commands/telemetry.test.ts', 2],
  ['packages/cli/src/commands/validate.test.ts', 1],
  ['packages/cli/src/commands/workflow.test.ts', 5],
  ['packages/cli/src/utils/safe-console.test.ts', 1],
  ['packages/cli/src/utils/stdout.test.ts', 1],
  ['packages/core/src/config/run-config.test.ts', 1],
  ['packages/core/src/credentials/config.test.ts', 1],
  ['packages/core/src/db/workflow-events.test.ts', 1],
  ['packages/core/src/github-auth/credential-helper-install.test.ts', 1],
  ['packages/core/src/utils/token-crypto.test.ts', 2],
  ['packages/git/src/git.test.ts', 2],
  ['packages/paths/src/archon-paths.test.ts', 7],
  ['packages/paths/src/env-integration.test.ts', 2],
  ['packages/paths/src/env-loader.test.ts', 1],
  ['packages/paths/src/strip-cwd-env.test.ts', 3],
  ['packages/paths/src/telemetry.test.ts', 5],
  ['packages/paths/src/tier-notice.test.ts', 1],
  ['packages/paths/src/update-check.test.ts', 2],
  ['packages/providers/src/claude/provider.test.ts', 1],
  ['packages/providers/src/codex/provider.test.ts', 5],
  ['packages/providers/src/community/opencode/provider.test.ts', 1],
  ['packages/providers/src/community/pi/model-store.integration.test.ts', 1],
  ['packages/providers/src/community/pi/options-translator.test.ts', 1],
  ['packages/providers/src/community/pi/provider.test.ts', 6],
  ['packages/providers/src/community/pi/request-auth.integration.test.ts', 1],
  ['packages/providers/src/community/pi/request-auth.test.ts', 1],
  ['packages/providers/src/community/pi/resource-loader.test.ts', 1],
  ['packages/providers/src/shared/skills.test.ts', 2],
  ['packages/server/src/routes/api.workflow-runs.test.ts', 2],
  ['packages/server/src/routes/api.workflows.test.ts', 29],
  ['packages/workflows/src/artifacts-index.test.ts', 1],
  ['packages/workflows/src/dag-executor.test.ts', 57],
  ['packages/workflows/src/defaults/generate-bundled-defaults.test.ts', 6],
  ['packages/workflows/src/dry-run.test.ts', 1],
  ['packages/workflows/src/executor-preamble.test.ts', 1],
  ['packages/workflows/src/executor.test.ts', 3],
  ['packages/workflows/src/load-command-prompt.test.ts', 3],
  ['packages/workflows/src/loader.test.ts', 7],
  ['packages/workflows/src/logger.test.ts', 1],
  ['packages/workflows/src/script-node-deps.test.ts', 1],
  ['packages/workflows/src/state-migration.test.ts', 2],
  ['packages/workflows/src/subrun.test.ts', 8],
  ['packages/workflows/src/validator.test.ts', 5],
  ['packages/workflows/src/workflow-discovery-command-scan.test.ts', 1],
  ['packages/workflows/src/workflow-source-binary.test.ts', 1],
  ['packages/workflows/src/workflow-source.test.ts', 1],
]);

export function gitOutput(args: string[], cwd = REPO_ROOT): string {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode === 0) return result.stdout.toString();
  throw new Error(`Git command failed: git ${args.join(' ')}\n${result.stderr.toString().trim()}`);
}

/** Working-tree sources, tracked and untracked, excluding ignored paths. */
function repositorySources(root: string): Set<string> {
  const listed = [
    ...gitOutput(['ls-files'], root).split('\n'),
    ...gitOutput(['ls-files', '--others', '--exclude-standard'], root).split('\n'),
  ];
  return new Set(listed.filter(path => SOURCE_FILE.test(path)));
}

/**
 * Scans the whole working tree rather than the changed files: both rules are repository law, and
 * a diff-scoped check would accept drift that an earlier merge already introduced.
 */
export function checkRepository(root = REPO_ROOT, baseline = LEGACY_RECURSIVE_CLEANUP): string[] {
  const failures: string[] = [];
  const cleanup = new Map<string, DriftViolation[]>();

  for (const file of repositorySources(root)) {
    const path = join(root, file);
    if (!existsSync(path)) continue;
    for (const violation of checkSource(file, readFileSync(path, 'utf8'))) {
      switch (violation.rule) {
        case 'retry-options':
          failures.push(`${file}:${violation.line} ${violation.message}`);
          break;
        case 'recursive-cleanup':
          cleanup.set(file, [...(cleanup.get(file) ?? []), violation]);
          break;
        default:
          // A new DriftRule must choose its scope here rather than inherit the ledger's.
          violation.rule satisfies never;
          throw new Error(`Unhandled drift rule: ${String(violation.rule)}`);
      }
    }
  }

  for (const file of new Set([...cleanup.keys(), ...baseline.keys()])) {
    const found = cleanup.get(file) ?? [];
    const recorded = baseline.get(file) ?? 0;
    if (found.length === recorded) continue;

    if (found.length < recorded) {
      const correction =
        found.length === 0
          ? 'delete its LEGACY_RECURSIVE_CLEANUP entry'
          : `lower its LEGACY_RECURSIVE_CLEANUP entry to ${found.length}`;
      failures.push(
        `${file}: ${found.length} recursive cleanup sites, recorded ${recorded}; ${correction}`
      );
    } else if (recorded === 0) {
      // Nothing recorded, so every site is new and its line is the actionable detail.
      failures.push(...found.map(({ line, message }) => `${file}:${line} ${message}`));
    } else {
      // Listing every line of a legacy file buries the new one; the author's diff has it.
      failures.push(
        `${file}: ${found.length} recursive cleanup sites exceed the recorded ${recorded}; new recursive cleanup must use removeTempTree or trackTempRoots`
      );
    }
  }

  return failures;
}

if (import.meta.main) {
  const failures = checkRepository();
  if (failures.length > 0) {
    console.error(
      ['Test-cleanup drift detected:', ...failures.map(failure => `  ${failure}`)].join('\n')
    );
    process.exit(1);
  }
  console.log('Test-cleanup drift check passed.');
}
