import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import { gitOutput } from './check-test-cleanup-drift';

/**
 * Bun's `mock.module(specifier, factory)` merges the factory over the real module: an export the
 * factory leaves out keeps its real implementation. When a mocked module gains an export, every
 * factory that does not list it starts running real code (a database, the network, the
 * filesystem) under a test that still passes. This check fails on every `mock.module` factory
 * whose keys do not cover the value exports of the module it mocks, naming the site and the
 * missing names.
 *
 * - A factory that spreads the real module (`...(await import('<specifier>'))`) provides every
 *   export. That is how a test declares a deliberate partial mock: what it does not override
 *   stays real on purpose, including exports the module gains later.
 * - Sites that were incomplete when the check landed are grandfathered in
 *   `scripts/mock-module-baseline.json`: each site by file and specifier, and for each module the
 *   exports those sites omitted then. A grandfathered site may omit only those names, so a new
 *   export still fails at every one of them. The committed baseline must equal the computed one,
 *   so it only shrinks: fix a site, then run `bun run check:mock-modules --write`. The ratchet
 *   (`scripts/check-ratchet.ts`) refuses entries the baseline gains unless a commit carries
 *   `Ratchet-Allow: scripts/mock-module-baseline.json`.
 *
 * Limits:
 * - Factory keys come from the factory's type, so an `as` cast can misstate them.
 * - Only literal specifiers are checked; a non-literal one is refused rather than skipped.
 * - A module TypeScript cannot read (no type declarations, or a path that does not resolve) is
 *   refused unless its site is grandfathered.
 * - A grandfathered factory that drops a key another grandfathered site of the same module
 *   already omits is not caught.
 * - It says nothing about a client a test never stubbed, or about I/O outside `mock.module`;
 *   the adapters package's preloaded `no-network` and `no-archon-home-writes` guards cover part
 *   of that, with their own limits. It runs in validate and CI, not inside `bun test`.
 */

const REPO_ROOT = resolve(import.meta.dir, '..');
export const BASELINE_PATH = 'scripts/mock-module-baseline.json';
const CHECKED_FILE = /\.(?:[cm]?ts|tsx)$/;

export interface MockSite {
  file: string;
  line: number;
  specifier: string;
  moduleKey: string;
  /** Value exports the factory does not provide; 'unknown' when TypeScript cannot read the module. */
  omitted: string[] | 'unknown';
  /** Why TypeScript cannot read the module, for an 'unknown' site. */
  reason?: string;
}

export interface Baseline {
  /** Grandfathered sites: repo-relative file to the specifiers it mocks incompletely. */
  factories: Record<string, string[]>;
  /** Per module, the exports grandfathered sites may omit. */
  exports: Record<string, string[]>;
}

export interface Collected {
  sites: MockSite[];
  /** Sites the check cannot judge at all; never grandfathered. */
  errors: string[];
}

const toPosix = (path: string): string => path.split(sep).join('/');

function owningConfig(root: string, file: string): string {
  for (let dir = dirname(file); ; dir = dirname(dir)) {
    const config = join(dir, 'tsconfig.json');
    if (existsSync(config)) return config;
    if (dir === root || dirname(dir) === dir) {
      throw new Error(`No tsconfig.json owns ${relative(root, file)}`);
    }
  }
}

function isMockModuleCall(node: ts.Node): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === 'module' &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === 'mock'
  );
}

class ProgramReader {
  private readonly checker: ts.TypeChecker;

  constructor(
    private readonly root: string,
    private readonly program: ts.Program,
    private readonly options: ts.CompilerOptions
  ) {
    this.checker = program.getTypeChecker();
  }

  /** The module symbol and its key, or undefined when TypeScript cannot read the module. */
  module(specifier: string, file: string): { symbol?: ts.Symbol; key: string } {
    const resolved = ts.resolveModuleName(specifier, file, this.options, ts.sys).resolvedModule;
    const path = resolved?.resolvedFileName;
    const inRepo =
      path !== undefined &&
      !path.includes('/node_modules/') &&
      !relative(this.root, path).startsWith('..');
    const key = inRepo ? toPosix(relative(this.root, path)) : specifier.replace(/^node:/, '');
    const source = path === undefined ? undefined : this.program.getSourceFile(path);
    const symbol =
      (source && this.checker.getSymbolAtLocation(source)) ??
      this.checker
        .getAmbientModules()
        .find(
          ambient =>
            ambient.getName() === `"${specifier}"` ||
            ambient.getName() === `"${specifier.replace(/^node:/, '')}"`
        );
    return { symbol, key };
  }

  valueExports(module: ts.Symbol): string[] {
    return this.checker
      .getExportsOfModule(module)
      .filter(exported => {
        const symbol =
          exported.flags & ts.SymbolFlags.Alias
            ? this.checker.getAliasedSymbol(exported)
            : exported;
        return (symbol.flags & ts.SymbolFlags.Value) !== 0;
      })
      .map(exported => exported.getName());
  }

  /** The factory's (awaited) return keys, or an error message. */
  factoryKeys(factory: ts.Expression | undefined): Set<string> | string {
    if (factory === undefined) return 'has no factory';
    const signature = this.checker.getTypeAtLocation(factory).getCallSignatures()[0];
    if (signature === undefined) return 'has a factory TypeScript cannot call';
    const returned = signature.getReturnType();
    const value = this.checker.getAwaitedType(returned) ?? returned;
    if (value.flags & ts.TypeFlags.Any) return 'has a factory typed `any`; its keys are unknown';
    return new Set(value.getProperties().map(property => property.getName()));
  }
}

function unreadableReason(specifier: string, file: string): string {
  try {
    Bun.resolveSync(specifier, dirname(file));
    return 'has no type declarations TypeScript can read';
  } catch {
    return 'does not resolve; a mock of a path nothing imports is dead';
  }
}

function readSite(
  reader: ProgramReader,
  root: string,
  file: string,
  call: ts.CallExpression
): MockSite | string {
  const rel = toPosix(relative(root, file));
  const line = call.getSourceFile().getLineAndCharacterOfPosition(call.getStart()).line + 1;
  const [specifierNode, factory] = call.arguments;
  if (specifierNode === undefined || !ts.isStringLiteralLike(specifierNode)) {
    return `${rel}:${line} mock.module() cannot check a non-literal specifier`;
  }
  const specifier = specifierNode.text;
  const keys = reader.factoryKeys(factory);
  if (typeof keys === 'string') return `${rel}:${line} mock.module('${specifier}') ${keys}`;
  const { symbol, key } = reader.module(specifier, file);
  const base = { file: rel, line, specifier, moduleKey: key };
  if (symbol === undefined) {
    return { ...base, omitted: 'unknown', reason: unreadableReason(specifier, file) };
  }
  return { ...base, omitted: reader.valueExports(symbol).filter(name => !keys.has(name)) };
}

function mockCalls(source: ts.SourceFile): ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (isMockModuleCall(node)) calls.push(node);
    node.forEachChild(visit);
  };
  visit(source);
  return calls;
}

function compilerOptions(config: string): { options: ts.CompilerOptions; ambient: string[] } {
  const parsed = ts.getParsedCommandLineOfConfigFile(
    config,
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: diagnostic => {
        throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
      },
    }
  );
  if (parsed === undefined) throw new Error(`Cannot read ${config}`);
  return {
    options: { ...parsed.options, noEmit: true },
    // Ambient declarations the project includes (text imports, globals) shape what resolves.
    ambient: parsed.fileNames.filter(name => name.endsWith('.d.ts')),
  };
}

/**
 * The TypeScript files the literal specifiers in `files` resolve to. They join the program as
 * roots, because a test need not import the module it mocks.
 */
function mockedModules(files: readonly string[], options: ts.CompilerOptions): string[] {
  return files.flatMap(file => {
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest);
    return mockCalls(source).flatMap(call => {
      const specifier = call.arguments[0];
      if (specifier === undefined || !ts.isStringLiteralLike(specifier)) return [];
      const resolved = ts.resolveModuleName(specifier.text, file, options, ts.sys).resolvedModule;
      const path = resolved?.resolvedFileName;
      return path !== undefined && CHECKED_FILE.test(path) ? [path] : [];
    });
  });
}

/** Every `mock.module` call in `files` (absolute paths), read through each file's own tsconfig. */
export function collectSites(root: string, files: readonly string[]): Collected {
  const groups = new Map<string, string[]>();
  for (const file of files) {
    const config = owningConfig(root, file);
    groups.set(config, [...(groups.get(config) ?? []), file]);
  }
  const results = [...groups].flatMap(([config, group]) => {
    const { options, ambient } = compilerOptions(config);
    const roots = new Set([...group, ...ambient, ...mockedModules(group, options)]);
    const program = ts.createProgram([...roots], options);
    const reader = new ProgramReader(root, program, options);
    return group.flatMap(file => {
      const source = program.getSourceFile(file);
      if (source === undefined) throw new Error(`Cannot read ${file}`);
      return mockCalls(source).map(call => readSite(reader, root, file, call));
    });
  });
  return {
    sites: results.filter((result): result is MockSite => typeof result !== 'string'),
    errors: results.filter((result): result is string => typeof result === 'string'),
  };
}

const sorted = (values: Iterable<string>): string[] => [...new Set(values)].sort();

function sortedRecord(record: Map<string, Set<string>>): Record<string, string[]> {
  return Object.fromEntries(
    [...record.keys()].sort().map(key => [key, sorted(record.get(key) ?? [])])
  );
}

const isIncomplete = (site: MockSite): boolean =>
  site.omitted === 'unknown' || site.omitted.length > 0;

/** The baseline the current sites need: every incomplete site and the names it omits. */
export function computeBaseline(sites: readonly MockSite[]): Baseline {
  const factories = new Map<string, Set<string>>();
  const exports = new Map<string, Set<string>>();
  for (const site of sites.filter(isIncomplete)) {
    factories.set(site.file, (factories.get(site.file) ?? new Set()).add(site.specifier));
    if (site.omitted === 'unknown') continue;
    const names = exports.get(site.moduleKey) ?? new Set();
    for (const name of site.omitted) names.add(name);
    exports.set(site.moduleKey, names);
  }
  return { factories: sortedRecord(factories), exports: sortedRecord(exports) };
}

function siteFailure(site: MockSite, baseline: Baseline): string | null {
  const grandfathered = baseline.factories[site.file]?.includes(site.specifier) ?? false;
  const at = `${site.file}:${site.line} mock.module('${site.specifier}')`;
  if (site.omitted === 'unknown') {
    return grandfathered ? null : `${at} ${site.reason}`;
  }
  const allowed = new Set(grandfathered ? (baseline.exports[site.moduleKey] ?? []) : []);
  const missing = site.omitted.filter(name => !allowed.has(name));
  if (missing.length === 0) return null;
  return `${at} omits ${missing.join(', ')}; an omitted export keeps its real implementation. Mock each one, or spread the real module (...(await import('${site.specifier}'))) to keep the rest real on purpose.`;
}

function staleEntries(committed: Baseline, needed: Baseline): string[] {
  const stale: string[] = [];
  for (const [file, specifiers] of Object.entries(committed.factories)) {
    for (const specifier of specifiers) {
      if (!needed.factories[file]?.includes(specifier)) {
        stale.push(`${BASELINE_PATH}: ${file} no longer mocks '${specifier}' incompletely`);
      }
    }
  }
  for (const [module, names] of Object.entries(committed.exports)) {
    const stillOmitted = new Set(needed.exports[module] ?? []);
    const gone = names.filter(name => !stillOmitted.has(name));
    if (gone.length > 0) {
      stale.push(`${BASELINE_PATH}: no grandfathered site of ${module} omits ${gone.join(', ')}`);
    }
  }
  if (stale.length > 0) {
    stale.push('The baseline only shrinks: run `bun run check:mock-modules --write` to drop them.');
  }
  return stale;
}

/** Failure lines: sites that omit more than the baseline allows, then stale baseline entries. */
export function compareBaseline(sites: readonly MockSite[], committed: Baseline): string[] {
  const failures = sites.flatMap(site => siteFailure(site, committed) ?? []);
  return [...failures, ...staleEntries(committed, computeBaseline(sites))];
}

/** One string per entry, so the ratchet can refuse entries a change adds. */
export function baselineEntries(baseline: Baseline): Set<string> {
  return new Set([
    ...Object.entries(baseline.factories).flatMap(([file, specifiers]) =>
      specifiers.map(specifier => `factory ${file} '${specifier}'`)
    ),
    ...Object.entries(baseline.exports).flatMap(([module, names]) =>
      names.map(name => `export ${module} ${name}`)
    ),
  ]);
}

export function parseBaseline(text: string): Baseline {
  const parsed = JSON.parse(text) as Partial<Baseline>;
  return { factories: parsed.factories ?? {}, exports: parsed.exports ?? {} };
}

/** Tracked and untracked TypeScript under packages/ and scripts/ that calls mock.module. */
function mockingFiles(root: string): string[] {
  return gitOutput(['ls-files', '--cached', '--others', '--exclude-standard'], root)
    .split('\n')
    .filter(
      path =>
        CHECKED_FILE.test(path) &&
        (path.startsWith('packages/') || path.startsWith('scripts/')) &&
        !path.includes('node_modules/')
    )
    .map(path => join(root, path))
    .filter(path => existsSync(path) && readFileSync(path, 'utf8').includes('mock.module('));
}

if (import.meta.main) {
  const { sites, errors } = collectSites(REPO_ROOT, mockingFiles(REPO_ROOT));
  const baselineFile = join(REPO_ROOT, BASELINE_PATH);
  if (process.argv.includes('--write')) {
    writeFileSync(baselineFile, `${JSON.stringify(computeBaseline(sites), null, 2)}\n`);
    const format = Bun.spawnSync(['bun', 'x', 'biome', 'format', '--write', baselineFile], {
      cwd: REPO_ROOT,
      stdout: 'inherit',
      stderr: 'inherit',
    });
    if (format.exitCode !== 0) process.exit(format.exitCode);
  }
  const committed = existsSync(baselineFile)
    ? parseBaseline(readFileSync(baselineFile, 'utf8'))
    : { factories: {}, exports: {} };
  const failures = [...errors, ...compareBaseline(sites, committed)];
  if (failures.length > 0) {
    console.error(['mock.module() check failed:', ...failures.map(line => `  ${line}`)].join('\n'));
    process.exit(1);
  }
  const grandfathered = sites.filter(isIncomplete).length;
  console.log(
    `mock.module() check passed: ${sites.length} sites, ${grandfathered} grandfathered in ${BASELINE_PATH}.`
  );
}
