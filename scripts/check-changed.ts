import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { BASELINE_PATH } from './check-mock-modules';
import type { PackageManifest } from './check-package-edges';
import { LINT_CHECKS, type LintStep, lintSteps } from './lint';
import {
  packRunnerInputs,
  rootScriptImports,
  shouldRunEveryJob,
  shouldRunPackTests,
  shouldRunTestSuite,
  trackedFiles,
  workspaceTestInputs,
} from './should-run-test-suite';
import {
  REPO_ROOT,
  ROOT_TSC_PROJECTS,
  type TypeCheckTask,
  type WorkspaceManifest,
  packageCheck,
  reportTypeChecks,
  runTypeChecks,
  typeCheckTasks,
  workspacePackages,
} from './type-check';
import { VALIDATE_CHECKS } from './validate';

/**
 * `bun run check:changed`: type-check and test the packages a change touches plus every package
 * that depends on them, then run lint scoped to them and the ratchet. It is the local check while
 * building and before pushing; CI stays the full validation, so this never reports a full pass.
 *
 * The scope comes from the package manifests (`workspace:` dependencies) and from CI's own change
 * classifier in `should-run-test-suite.ts`, so a file that CI treats as prose or as a reason to
 * run every job is treated the same way here. Steps run commands their owners already have: one
 * `tsc -b` over the scoped projects from `type-check.ts` (which also brings their dependencies up
 * to date from cache), each package's own `test` script, the lint checks `scripts/lint.ts` lists
 * (see `lintPlan`), and the `validate.ts` checks by id for the ratchet, the type-check and the
 * root and pack tests.
 */

/** The root manifest as a graph node: its devDependencies name workspace packages. */
export const ROOT = 'root';

export interface WorkspaceGraph {
  /** Package name to its directory relative to the repository root, e.g. `packages/paths`. */
  directories: ReadonlyMap<string, string>;
  /** Package name, or `ROOT`, to the workspace packages it declares. */
  dependsOn: ReadonlyMap<string, readonly string[]>;
}

/** CI's classifier inputs, computed from the checkout; a parameter so the scope stays pure. */
export interface ClassifierInputs {
  packRunner: ReadonlySet<string>;
  workspaceTest: ReadonlySet<string>;
  /** Changed files outside `packages/` that a workspace package ships, to the packages that do. */
  shipped: ReadonlyMap<string, ReadonlySet<string>>;
}

export interface ScopedChange {
  kind: 'scoped';
  /** Package name to why it is checked: `changed`, `imported` or `depends on <name>`. */
  packages: Map<string, string>;
  rootScripts: boolean;
  pack: boolean;
  /** Files CI's classifier treats as prose or inert: nothing checks them. */
  unchecked: string[];
}

export type ChangeScope = { kind: 'everything'; because: string[] } | ScopedChange;

const SECTIONS = ['dependencies', 'devDependencies', 'peerDependencies'] as const;

function workspaceDependencies(manifest: Omit<PackageManifest, 'path'>): string[] {
  return SECTIONS.flatMap(section =>
    Object.entries(manifest[section] ?? {})
      .filter(([, version]) => version.startsWith('workspace:'))
      .map(([name]) => name)
  );
}

export function loadGraph(root = REPO_ROOT): WorkspaceGraph {
  const packages = workspacePackages(root);
  const rootManifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Omit<
    PackageManifest,
    'path'
  >;
  return {
    directories: new Map(packages.map(manifest => [manifest.name, manifest.path])),
    dependsOn: new Map([
      ...packages.map((manifest): [string, string[]] => [
        manifest.name,
        workspaceDependencies(manifest),
      ]),
      [ROOT, workspaceDependencies(rootManifest)],
    ]),
  };
}

type FileScope =
  | { kind: 'unchecked' }
  | { kind: 'everything'; because: string }
  | { kind: 'checked'; packages: string[]; reason: string; rootScripts: boolean; pack: boolean };

/**
 * The changed files outside `packages/` that a workspace package ships, each to the packages that
 * ship it, derived the way CI derives root-script inputs: a tracked non-Markdown file under a
 * package that names the file's path makes that package an owner. `.claude/skills/` is here
 * because `packages/cli/src/bundled-skill.ts` imports it as text.
 */
export function packageShippedInputs(
  repo: string,
  directories: ReadonlyMap<string, string>,
  changed: Iterable<string>
): Map<string, Set<string>> {
  const wanted = new Set(changed);
  const owners = new Map<string, Set<string>>();
  if (wanted.size === 0) return owners;
  const byDirectory = new Map([...directories].map(([name, directory]) => [directory, name]));
  for (const file of trackedFiles(repo, 'packages')) {
    if (file.endsWith('.md') || file.endsWith('.mdx')) continue;
    const name = byDirectory.get(/^packages\/[^/]+/.exec(file)?.[0] ?? '');
    if (name === undefined) continue;
    for (const target of namedFiles(repo, file, wanted)) {
      owners.set(target, (owners.get(target) ?? new Set()).add(name));
    }
  }
  return owners;
}

/** The changed files `file` names: a repository path, or an import relative to `file`. */
function namedFiles(repo: string, file: string, wanted: ReadonlySet<string>): string[] {
  const source = readFileSync(join(repo, file), 'utf8');
  const found: string[] = [];
  for (const match of source.matchAll(/[\w./-]+\.(?:md|mdx|sql|txt|yaml|yml)\b/g)) {
    const token = match[0];
    // `./` and `../` name a path relative to the naming file only; anything else is a
    // repository path. Looking a relative reference up at the root as well would give a
    // package an unrelated root file that happens to share the relative path.
    const target =
      token.startsWith('./') || token.startsWith('../')
        ? normalize(join(dirname(file), token)).replaceAll('\\', '/')
        : token;
    if (wanted.has(target)) found.push(target);
  }
  return found;
}

function packageScope(file: string, graph: WorkspaceGraph): FileScope | undefined {
  const packageDirectory = /^packages\/[^/]+/.exec(file)?.[0];
  if (packageDirectory === undefined) return undefined;
  const name = [...graph.directories].find(([, directory]) => directory === packageDirectory);
  return name === undefined
    ? { kind: 'everything', because: `${file} is in ${packageDirectory}, which has no manifest` }
    : { kind: 'checked', packages: [name[0]], reason: 'changed', rootScripts: false, pack: false };
}

function classify(file: string, graph: WorkspaceGraph, inputs: ClassifierInputs): FileScope {
  // CI's classifier reads all of packages/docs-web as documentation, because no job of its own
  // checks the site. Here a package's code selects that package, so only Markdown defers to it.
  const inPackage = packageScope(file, graph);
  if (inPackage !== undefined && !/\.mdx?$/.test(file)) return inPackage;
  if (!shouldRunTestSuite([file])) return { kind: 'unchecked' };
  if (inPackage !== undefined) return inPackage;
  if (shouldRunEveryJob([file], inputs.packRunner)) {
    return { kind: 'everything', because: `${file} makes CI run every job` };
  }
  if (file.startsWith('scripts/')) {
    return {
      kind: 'checked',
      packages: inputs.workspaceTest.has(file) ? [...graph.directories.keys()] : [],
      reason: `reads ${file}`,
      rootScripts: true,
      // The pack's tsc projects extend this one.
      pack: file === 'scripts/tsconfig.json',
    };
  }
  if (file.startsWith('.archon/')) {
    // Root script tests import pack modules, so a pack change runs them too.
    return { kind: 'checked', packages: [], reason: '', rootScripts: true, pack: true };
  }
  const shipped = inputs.shipped.get(file);
  if (shipped !== undefined && shipped.size > 0) {
    return {
      kind: 'checked',
      packages: [...shipped],
      reason: 'imported',
      rootScripts: false,
      pack: false,
    };
  }
  return { kind: 'everything', because: `${file} maps to no package or root project` };
}

/** Every package that depends on one of `changed`, directly or not, with the first it reached. */
function dependents(graph: WorkspaceGraph, changed: Iterable<string>): Map<string, string> {
  const reverse = new Map<string, string[]>();
  for (const [name, dependencies] of graph.dependsOn) {
    for (const dependency of dependencies) {
      reverse.set(dependency, [...(reverse.get(dependency) ?? []), name]);
    }
  }
  const reached = new Map<string, string>();
  const queue = [...changed];
  const seen = new Set(queue);
  for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
    for (const dependent of reverse.get(name) ?? []) {
      if (seen.has(dependent)) continue;
      seen.add(dependent);
      reached.set(dependent, `depends on ${name}`);
      queue.push(dependent);
    }
  }
  return reached;
}

export function changeScope(
  files: readonly string[],
  graph: WorkspaceGraph,
  inputs: ClassifierInputs
): ChangeScope {
  const because: string[] = [];
  const scope: ScopedChange = {
    kind: 'scoped',
    packages: new Map(),
    rootScripts: false,
    pack: shouldRunPackTests(files, inputs.packRunner),
    unchecked: [],
  };
  for (const file of files) {
    const fileScope = classify(file, graph, inputs);
    if (fileScope.kind === 'unchecked') scope.unchecked.push(file);
    else if (fileScope.kind === 'everything') because.push(fileScope.because);
    else {
      for (const name of fileScope.packages) {
        if (!scope.packages.has(name)) scope.packages.set(name, fileScope.reason);
      }
      scope.rootScripts ||= fileScope.rootScripts;
      scope.pack ||= fileScope.pack;
    }
  }
  if (because.length > 0) return { kind: 'everything', because };
  return withDependents(scope, graph);
}

/** Adds every package that depends on a scoped one; the root manifest brings the root scripts. */
function withDependents(scope: ScopedChange, graph: WorkspaceGraph): ScopedChange {
  for (const [name, reason] of dependents(graph, scope.packages.keys())) {
    if (name === ROOT) scope.rootScripts = true;
    else if (!scope.packages.has(name)) scope.packages.set(name, reason);
  }
  return scope;
}

/** The lint checks this change runs, and why they all run whole when they do. */
export interface LintPlan {
  steps: LintStep[];
  wholeBecause: string[];
}

const TSCONFIG = /(?:^|\/)tsconfig[^/]*\.json$/;

/**
 * Files whose change can alter a lint result anywhere: the lint scripts and the root scripts
 * they import, and the mock.module() baseline. Any tsconfig counts too (see `lintPlan`).
 */
export function lintInputs(repo: string, changed: Iterable<string>): Set<string> {
  const scripts = LINT_CHECKS.flatMap(check =>
    check.args.filter(arg => arg.startsWith('scripts/'))
  );
  return new Set([
    BASELINE_PATH,
    ...rootScriptImports(repo, ['scripts/lint.ts', ...scripts], changed),
  ]);
}

/**
 * Lint runs whole when the change reaches everything or touches a lint input, since then any
 * file's result can change. Otherwise it runs scoped to the packages in scope (changed ones and
 * their dependents) and the root scripts when they are in scope.
 */
export function lintPlan(
  scope: ChangeScope,
  files: readonly string[],
  graph: WorkspaceGraph,
  inputs: ReadonlySet<string>
): LintPlan {
  if (scope.kind === 'everything') {
    return { steps: lintSteps(), wholeBecause: ['the change reaches everything'] };
  }
  const touched = files.filter(file => inputs.has(file) || TSCONFIG.test(file));
  if (touched.length > 0) {
    return { steps: lintSteps(), wholeBecause: touched.map(file => `${file} is a lint input`) };
  }
  const directories = [
    ...[...scope.packages.keys()].flatMap(name => graph.directories.get(name) ?? []).sort(),
    ...(scope.rootScripts ? ['scripts'] : []),
  ];
  return { steps: lintSteps({ directories }), wholeBecause: [] };
}

function git(args: string[], repo: string): string {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

const nulList = (output: string): string[] => output.split('\0').filter(Boolean);

/** Committed, staged, unstaged and untracked changes since the merge base with `base`. */
export function changedFiles(
  base: string,
  repo = REPO_ROOT
): { mergeBase: string; files: string[] } {
  let mergeBase: string;
  try {
    mergeBase = git(['merge-base', base, 'HEAD'], repo).trim();
  } catch (error) {
    const branch = base.replace(/^origin\//, '');
    throw new Error(
      `Cannot find the merge base with ${base}. Fetch it first: git fetch origin ${branch}\n${(error as Error).message}`
    );
  }
  const files = new Set([
    ...nulList(git(['diff', '--name-only', '--no-renames', '-z', mergeBase], repo)),
    ...nulList(git(['ls-files', '--others', '--exclude-standard', '-z'], repo)),
  ]);
  return { mergeBase, files: [...files].sort() };
}

export function parseArguments(argv: readonly string[]): { base: string; list: boolean } {
  let base = 'origin/dev';
  let list = false;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--list') list = true;
    else if (argument === '--base' && argv[index + 1] !== undefined) base = argv[++index];
    else if (argument.startsWith('--base=') && argument.length > '--base='.length) {
      base = argument.slice('--base='.length);
    } else {
      throw new Error(
        `unsupported argument: ${argument}\nUsage: bun run check:changed [--base <ref>] [--list]`
      );
    }
  }
  return { base, list };
}

const LEFT_TO_CI =
  'Left to CI: generated-files, package-edges, cli-import-boundary, format, installer, the ' +
  'Windows and macOS jobs, and couplings the manifests do not declare (packages that launch ' +
  'packages/cli/src/cli.ts, root tests that read package files, web types generated from the ' +
  'server API).';

function printLint(lint: LintPlan): void {
  console.log('Lint checks:');
  for (const step of lint.steps) {
    console.log(`  ${step.id}: ${step.run}${step.note === '' ? '' : ` (${step.note})`}`);
  }
  if (lint.wholeBecause.length > 0) {
    console.log(`  Whole because: ${lint.wholeBecause.join('; ')}`);
  }
}

function printScope(scope: ChangeScope, graph: WorkspaceGraph, lint: LintPlan): void {
  if (scope.kind === 'everything') {
    console.log('The change reaches everything, so this runs the full local set:');
    for (const reason of scope.because) console.log(`  ${reason}`);
    printLint(lint);
    return;
  }
  const all = [...graph.directories.keys()].sort();
  console.log('Packages checked:');
  for (const name of all.filter(name => scope.packages.has(name))) {
    console.log(`  ${name} (${scope.packages.get(name) ?? ''})`);
  }
  if (scope.packages.size === 0) console.log('  none');
  console.log(
    `Packages skipped: ${all.filter(name => !scope.packages.has(name)).join(', ') || 'none'}`
  );
  console.log(`Root scripts (scripts/): ${scope.rootScripts ? 'checked' : 'skipped'}`);
  console.log(`Pack (.archon/scripts, .archon/workflows): ${scope.pack ? 'checked' : 'skipped'}`);
  if (scope.unchecked.length > 0) {
    console.log('Prose and inert files, which nothing checks:');
    for (const file of scope.unchecked) console.log(`  ${file}`);
  }
  printLint(lint);
}

type Step = { label: string; run: () => Promise<number> };

function command(label: string, args: readonly string[], cwd = REPO_ROOT): Step {
  return {
    label,
    run: async () => {
      console.log(`\n=== ${label} ===\n$ ${args.join(' ')}`);
      return await Bun.spawn([...args], { cwd, stdio: ['inherit', 'inherit', 'inherit'] }).exited;
    },
  };
}

/** The type-check tasks for a scoped change: its packages, plus the root projects it reaches. */
export function scopedTypeChecks(
  scope: ScopedChange,
  packages: readonly WorkspaceManifest[]
): TypeCheckTask[] {
  const checks = packages.flatMap(manifest => packageCheck(manifest) ?? []);
  return typeCheckTasks(
    [
      ...checks.flatMap(check => (check.kind === 'project' ? [check.path] : [])),
      ...(scope.rootScripts ? ['scripts/tsconfig.json'] : []),
      ...(scope.pack ? ROOT_TSC_PROJECTS.filter(p => p.startsWith('.archon/')) : []),
    ],
    checks.flatMap(check => (check.kind === 'script' ? [check.task] : []))
  );
}

function typeCheckStep(tasks: TypeCheckTask[]): Step {
  return {
    label: 'type-check',
    run: async () => {
      console.log('\n=== type-check ===');
      return reportTypeChecks(await runTypeChecks(tasks), tasks.length);
    },
  };
}

/** The commands `scripts/validate.ts` owns for one check id, as one step each. */
function validateSteps(id: string, label: string, extra: readonly string[] = []): Step[] {
  const check = VALIDATE_CHECKS.find(candidate => candidate.id === id);
  if (check === undefined) throw new Error(`scripts/validate.ts has no check named ${id}`);
  return check.commands.map(args => command(label, [...args, ...extra]));
}

function steps(scope: ChangeScope, lint: LintPlan, base: string): Step[] {
  const tail = [
    ...lint.steps
      .filter(step => step.run !== 'skipped')
      .map(step =>
        command(`lint: ${step.id} (${step.run}${step.note && `: ${step.note}`})`, step.args)
      ),
    ...validateSteps('ratchet', `ratchet against ${base}`, ['--base', base]),
  ];
  if (scope.kind === 'everything') {
    return [
      ...validateSteps('type-check', 'type-check (every project)'),
      // The root test runner owns the whole plan, so there is no list of test checks to repeat.
      command('tests (every package and root project)', ['bun', 'run', 'test']),
      ...tail,
    ];
  }
  const packages = workspacePackages().filter(manifest => scope.packages.has(manifest.name));
  const tasks = scopedTypeChecks(scope, packages);
  // One package's test groups at a time keeps peak memory near a single package's.
  const tests = [
    ...packages
      .filter(manifest => manifest.scripts?.test !== undefined)
      .map(manifest =>
        command(`tests: ${manifest.name}`, ['bun', 'run', 'test'], join(REPO_ROOT, manifest.path))
      ),
    ...(scope.rootScripts ? validateSteps('script-tests', 'tests: scripts/') : []),
    ...(scope.pack ? validateSteps('pack-tests', 'tests: .archon/scripts/') : []),
  ];
  return [...(tasks.length > 0 ? [typeCheckStep(tasks)] : []), ...tests, ...tail];
}

async function main(argv: readonly string[]): Promise<number> {
  const { base, list } = parseArguments(argv);
  const { mergeBase, files } = changedFiles(base);
  console.log(
    `Scoped check against ${base} (merge base ${mergeBase.slice(0, 10)}). This is not a full pass; CI runs the full validation.`
  );
  if (files.length === 0) {
    console.log('Nothing changed against the merge base, so there is nothing to check.');
    return 0;
  }
  const graph = loadGraph();
  const scope = changeScope(files, graph, {
    packRunner: packRunnerInputs(REPO_ROOT, files),
    workspaceTest: workspaceTestInputs(REPO_ROOT, files),
    shipped: packageShippedInputs(REPO_ROOT, graph.directories, files),
  });
  const lint = lintPlan(scope, files, graph, lintInputs(REPO_ROOT, files));
  printScope(scope, graph, lint);
  console.log(LEFT_TO_CI);
  if (list) return 0;

  for (const step of steps(scope, lint, base)) {
    const code = await step.run();
    if (code !== 0) {
      console.error(`\ncheck:changed failed at: ${step.label} (exit ${String(code)})`);
      return code;
    }
  }
  const checked =
    scope.kind === 'everything'
      ? 'every package and root project'
      : `${String(scope.packages.size)} of ${String(graph.directories.size)} packages`;
  console.log(`\nscoped checks passed (${checked}). CI runs the full validation.`);
  return 0;
}

if (import.meta.main) {
  try {
    process.exitCode = await main(Bun.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
