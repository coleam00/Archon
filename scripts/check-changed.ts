import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  packRunnerInputs,
  shouldRunEveryJob,
  shouldRunPackTests,
  shouldRunTestSuite,
  workspaceTestInputs,
} from './should-run-test-suite';
import {
  REPO_ROOT,
  ROOT_TSC_PROJECTS,
  type TypeCheckTask,
  packageTask,
  reportTypeChecks,
  rootProjectTask,
  runTypeChecks,
  workspacePackages,
} from './type-check';

/**
 * `bun run check:changed`: type-check and test the packages a change touches plus every package
 * that depends on them, then run lint and the ratchet. It is the local check while building and
 * before pushing; CI stays the full validation, so this never reports a full pass.
 *
 * The scope comes from the package manifests (`workspace:` dependencies) and from CI's own change
 * classifier in `should-run-test-suite.ts`, so a file that CI treats as prose or as a reason to
 * run every job is treated the same way here. Each step runs a command its owner already has:
 * the package `type-check` and `test` scripts, `bun run test --plan scripts|pack`, `bun run lint`
 * and `bun run check:ratchet`.
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
}

export type ChangeScope =
  | { kind: 'everything'; because: string[] }
  | {
      kind: 'scoped';
      /** Package name to why it is checked: `changed` or `depends on <name>`. */
      packages: Map<string, string>;
      rootScripts: boolean;
      pack: boolean;
      /** Files CI's classifier treats as prose or inert: nothing checks them. */
      unchecked: string[];
    };

const SECTIONS = ['dependencies', 'devDependencies', 'peerDependencies'] as const;

function workspaceDependencies(manifest: Partial<Record<string, unknown>>): string[] {
  return SECTIONS.flatMap(section => {
    const entries = (manifest[section] ?? {}) as Record<string, string>;
    return Object.keys(entries).filter(name => entries[name].startsWith('workspace:'));
  });
}

export function loadGraph(root = REPO_ROOT): WorkspaceGraph {
  const packages = workspacePackages(root);
  const rootManifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Record<
    string,
    unknown
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

/** Root files that every tsc project or the lint configuration reads. */
const SHARED_CONFIG = ['tsconfig.json', 'biome.jsonc'];

type FileScope =
  | { kind: 'unchecked' }
  | { kind: 'everything'; because: string }
  | { kind: 'package'; name: string }
  | { kind: 'root-scripts'; allPackages: boolean; pack: boolean }
  | { kind: 'pack' };

function classify(file: string, graph: WorkspaceGraph, inputs: ClassifierInputs): FileScope {
  if (!shouldRunTestSuite([file])) return { kind: 'unchecked' };
  if (shouldRunEveryJob([file], inputs.packRunner)) {
    return { kind: 'everything', because: `${file} makes CI run every job` };
  }
  if (SHARED_CONFIG.includes(file)) {
    return { kind: 'everything', because: `${file} is read by every project` };
  }
  const packageDirectory = /^packages\/[^/]+/.exec(file)?.[0];
  if (packageDirectory !== undefined) {
    const name = [...graph.directories].find(([, directory]) => directory === packageDirectory);
    return name === undefined
      ? { kind: 'everything', because: `${file} is in ${packageDirectory}, which has no manifest` }
      : { kind: 'package', name: name[0] };
  }
  if (file.startsWith('scripts/')) {
    return {
      kind: 'root-scripts',
      allPackages: inputs.workspaceTest.has(file),
      // The pack's tsc projects extend this one.
      pack: file === 'scripts/tsconfig.json',
    };
  }
  if (file.startsWith('.archon/')) return { kind: 'pack' };
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
  const packages = new Map<string, string>();
  const unchecked: string[] = [];
  let rootScripts = false;
  let pack = false;
  for (const file of files) {
    const scope = classify(file, graph, inputs);
    if (scope.kind === 'unchecked') unchecked.push(file);
    else if (scope.kind === 'everything') because.push(scope.because);
    else if (scope.kind === 'package') packages.set(scope.name, 'changed');
    else if (scope.kind === 'pack') {
      // Root script tests import pack modules, so a pack change runs them too.
      pack = true;
      rootScripts = true;
    } else {
      rootScripts = true;
      pack ||= scope.pack;
      if (scope.allPackages) {
        for (const name of graph.directories.keys()) {
          if (!packages.has(name)) packages.set(name, `reads ${file}`);
        }
      }
    }
  }
  if (because.length > 0) return { kind: 'everything', because };

  for (const [name, reason] of dependents(graph, packages.keys())) {
    if (name === ROOT) rootScripts = true;
    else if (!packages.has(name)) packages.set(name, reason);
  }
  pack ||= shouldRunPackTests(files, inputs.packRunner);
  return { kind: 'scoped', packages, rootScripts, pack, unchecked };
}

function git(args: string[]): string {
  const result = spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

const nulList = (output: string): string[] => output.split('\0').filter(Boolean);

/** Committed, staged, unstaged and untracked changes since the merge base with `base`. */
function changedFiles(base: string): { mergeBase: string; files: string[] } {
  let mergeBase: string;
  try {
    mergeBase = git(['merge-base', base, 'HEAD']).trim();
  } catch (error) {
    const branch = base.replace(/^origin\//, '');
    throw new Error(
      `Cannot find the merge base with ${base}. Fetch it first: git fetch origin ${branch}\n${(error as Error).message}`
    );
  }
  const files = new Set([
    ...nulList(git(['diff', '--name-only', '--no-renames', '-z', mergeBase])),
    ...nulList(git(['ls-files', '--others', '--exclude-standard', '-z'])),
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

function printScope(scope: ChangeScope, graph: WorkspaceGraph): void {
  if (scope.kind === 'everything') {
    console.log('The change reaches everything, so this runs the full local set:');
    for (const reason of scope.because) console.log(`  ${reason}`);
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
}

type Step = { label: string; run: () => Promise<number> };

function command(label: string, args: string[], cwd = REPO_ROOT, env = process.env): Step {
  return {
    label,
    run: async () => {
      console.log(`\n=== ${label} ===\n$ ${args.join(' ')}`);
      return await Bun.spawn(args, { cwd, env, stdio: ['inherit', 'inherit', 'inherit'] }).exited;
    },
  };
}

function typeCheckStep(tasks: TypeCheckTask[]): Step {
  return {
    label: 'type-check',
    run: async () => {
      console.log(`\n=== type-check (${tasks.map(task => task.name).join(', ')}) ===`);
      return reportTypeChecks(await runTypeChecks(tasks), tasks.length);
    },
  };
}

/** The ratchet reads its base branch from `GITHUB_BASE_REF`, as CI sets it. */
function ratchetStep(base: string): Step {
  const branch = /^origin\/(.+)$/.exec(base)?.[1];
  const env = branch === undefined ? process.env : { ...process.env, GITHUB_BASE_REF: branch };
  return command('ratchet', ['bun', 'run', 'check:ratchet'], REPO_ROOT, env);
}

function steps(scope: ChangeScope, base: string): Step[] {
  const lint = command('lint (whole repository)', ['bun', 'run', 'lint']);
  if (scope.kind === 'everything') {
    return [
      command('type-check (every project)', ['bun', 'run', 'type-check']),
      command('tests (every package and root project)', ['bun', 'run', 'test']),
      lint,
      ratchetStep(base),
    ];
  }
  const packages = workspacePackages().filter(manifest => scope.packages.has(manifest.name));
  const tasks = [
    ...packages.flatMap(manifest => packageTask(manifest) ?? []),
    ...(scope.rootScripts ? [rootProjectTask('scripts/tsconfig.json')] : []),
    ...(scope.pack
      ? ROOT_TSC_PROJECTS.filter(p => p.startsWith('.archon/')).map(p => rootProjectTask(p))
      : []),
  ];
  // One package's test groups at a time keeps peak memory near a single package's.
  const tests = [
    ...packages
      .filter(manifest => manifest.scripts?.test !== undefined)
      .map(manifest =>
        command(`tests: ${manifest.name}`, ['bun', 'run', 'test'], join(REPO_ROOT, manifest.path))
      ),
    ...(scope.rootScripts
      ? [command('tests: scripts/', ['bun', 'run', 'test', '--plan', 'scripts'])]
      : []),
    ...(scope.pack
      ? [command('tests: .archon/scripts/', ['bun', 'run', 'test', '--plan', 'pack'])]
      : []),
  ];
  return [...(tasks.length > 0 ? [typeCheckStep(tasks)] : []), ...tests, lint, ratchetStep(base)];
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
  });
  printScope(scope, graph);
  console.log(LEFT_TO_CI);
  if (list) return 0;

  for (const step of steps(scope, base)) {
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
