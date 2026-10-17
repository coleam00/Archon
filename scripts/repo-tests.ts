import { existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { bunTestCommand, bunTestEnv } from './bun-test-command';

/**
 * Runs the repository's tests, from the repository root.
 *
 * With no arguments it walks `ROOT_TEST_PLAN`, which is the work the
 * `bun --filter '*' --parallel test && bun test ./scripts/ && bun test ./.archon/scripts/`
 * chain used to do. The chain had to go because `bun run` appends its arguments to
 * whatever the script expands to, so `bun run test <path>` ran the whole chain and then
 * tacked the path onto its last step — green even when the path was wrong.
 *
 * With arguments, an argument that names a path inside a workspace package or inside a
 * root-owned test directory decides where `bun test` runs; every other argument (flags,
 * substring filters, flag values) is forwarded unchanged. Arguments that name several
 * owners run one owner at a time and stop at the first failure, because each owner needs
 * its own working directory and its own process. When nothing names an owner the run
 * fails: the root cannot guess a working directory, and answering with a full green suite
 * is what made a mistyped path look like a pass.
 *
 * `--plan <shard>` walks only the plan steps of that shard. CI runs each shard on its own
 * runner so they finish side by side, except `pack`: CI runs it only on a manual dispatch
 * that asks for it, and `bun run test --plan pack` runs it locally.
 */

/**
 * One step of the no-argument run. A `workspace` step runs one package alone; the
 * `workspaces` step runs every package no `workspace` step names, so no package can fall
 * between them.
 */
export type RootTestStep =
  | { kind: 'workspace'; shard: string; package: string }
  | { kind: 'workspaces'; shard: string }
  | { kind: 'root'; shard: string; selectors: readonly string[] };

/**
 * The no-argument run. `scripts/test-inventory.test.ts` reads the same array to prove
 * every tracked test is collected, so execution and inventory cannot drift apart.
 *
 * Root steps run serially. Under `bun test --parallel`, `./scripts/` timed out
 * (`docker-safe-directory.test.ts`) and on Linux CI the git fixtures of
 * `.archon/scripts/__tests__/deliver-checks-harness.ts` failed in every intake test.
 */
export const ROOT_TEST_PLAN = [
  { kind: 'workspace', shard: 'cli', package: '@archon/cli' },
  { kind: 'workspaces', shard: 'packages' },
  { kind: 'root', shard: 'scripts', selectors: ['./scripts/'] },
  { kind: 'root', shard: 'pack', selectors: ['./.archon/scripts/'] },
] as const satisfies readonly RootTestStep[];

export type TestShard = (typeof ROOT_TEST_PLAN)[number]['shard'];

const TEST_SHARDS: readonly TestShard[] = [
  ...new Set(ROOT_TEST_PLAN.map((step): TestShard => step.shard)),
];

/**
 * The command one plan step runs. Each workspace runs its own `test` script, which owns that
 * package's group splitting and concurrency.
 */
export function planStepCommand(step: RootTestStep): string[] {
  if (step.kind === 'workspace') return ['bun', '--filter', step.package, 'test'];
  if (step.kind === 'root') return bunTestCommand(step.selectors);
  // A negated filter alone already leaves out the root package, so no `'*'` goes beside it.
  const solo = ROOT_TEST_PLAN.flatMap((other: RootTestStep): string[] =>
    other.kind === 'workspace' ? ['--filter', `!${other.package}`] : []
  );
  return ['bun', ...(solo.length > 0 ? solo : ['--filter', '*']), '--parallel', 'test'];
}

const REPO_ROOT = join(import.meta.dir, '..');

/** Directories the root tests directly. Every other test belongs to a workspace package. */
const ROOT_OWNED_DIRECTORIES = ROOT_TEST_PLAN.flatMap((step: RootTestStep): string[] =>
  step.kind === 'root'
    ? step.selectors.map((selector): string =>
        normalizePath(relative(REPO_ROOT, resolve(REPO_ROOT, selector)))
      )
    : []
);

export interface TestOwner {
  /** How the owner is named in messages, and the identity two arguments are grouped by. */
  label: string;
  cwd: string;
}

/** One `bun test` invocation: the directory it runs in and the arguments it receives. */
export interface RequestedRun {
  owner: TestOwner;
  args: string[];
}

interface RoutedArgument {
  owner: TestOwner;
  selector: string;
}

function normalizePath(path: string): string {
  return path.replaceAll('\\', '/');
}

/**
 * Places one argument with the owner that can run it, rewriting the path so it is
 * relative to that owner's working directory. Arguments this cannot place come back
 * `undefined` and are forwarded verbatim. The caller excludes test-name option values.
 *
 * A relative argument is read against the repository root, which is where `bun run test`
 * always runs from. Reading it against some other working directory would let the same
 * argument mean different packages on different invocations.
 */
function routeArgument(argument: string): RoutedArgument | undefined {
  if (argument.startsWith('-')) return undefined;

  const repoPath = normalizePath(relative(REPO_ROOT, resolve(REPO_ROOT, argument)));
  if (repoPath === '' || repoPath.startsWith('../')) return undefined;

  const packageMatch = /^packages\/([^/]+)\/(.+)$/.exec(repoPath);
  if (packageMatch !== null) {
    const packageName = packageMatch[1];
    const packageDirectory = join(REPO_ROOT, 'packages', packageName);
    return existsSync(join(packageDirectory, 'package.json'))
      ? {
          owner: { label: `packages/${packageName}`, cwd: packageDirectory },
          selector: packageMatch[2],
        }
      : undefined;
  }

  return ROOT_OWNED_DIRECTORIES.some(
    (directory): boolean => repoPath === directory || repoPath.startsWith(`${directory}/`)
  )
    ? { owner: { label: 'the repository root', cwd: REPO_ROOT }, selector: `./${repoPath}` }
    : undefined;
}

/**
 * The environment of a root-owned run. Pack tests run the host CLI through
 * `ARCHON_CLI_COMMAND`, the same contract a workflow run gives pack scripts, because the
 * pack may not reach into `packages/`. A value already set wins, so the pack tests can run
 * against a release binary.
 */
export function rootTestEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...env,
    ARCHON_CLI_COMMAND:
      env.ARCHON_CLI_COMMAND ||
      JSON.stringify([
        process.execPath,
        '--no-env-file',
        join(REPO_ROOT, 'packages/cli/src/cli.ts'),
      ]),
  };
}

async function run(command: string[], cwd: string): Promise<number> {
  const child = Bun.spawn(command, {
    cwd,
    env: bunTestEnv(cwd === REPO_ROOT ? rootTestEnv() : process.env),
    stdio: ['inherit', 'inherit', 'inherit'],
  });
  return await child.exited;
}

async function runPlan(shard?: TestShard): Promise<number> {
  for (const step of ROOT_TEST_PLAN) {
    if (shard !== undefined && step.shard !== shard) continue;
    const code = await run(planStepCommand(step), REPO_ROOT);
    if (code !== 0) return code;
  }
  return 0;
}

/**
 * The shard `--plan <shard>` selects, or `undefined` when the arguments are not a `--plan`
 * request. `bun test` has no `--plan` flag, so the form cannot shadow a forwarded argument.
 */
export function planShard(requested: readonly string[]): TestShard | undefined {
  if (requested[0] !== '--plan') return undefined;
  const shard = TEST_SHARDS.find((candidate): boolean => candidate === requested[1]);
  if (requested.length !== 2 || shard === undefined) {
    throw new Error(`Usage: bun run test --plan <${TEST_SHARDS.join('|')}>`);
  }
  return shard;
}

/**
 * Turns the requested arguments into one run per owner they name, in the order the owners
 * were first named. Arguments this cannot place go to every run, since a flag value or a
 * substring filter is meaningful to whichever owner the placed arguments chose. No named
 * owner means no run: the caller reports that rather than falling back to the full suite.
 */
export function planRequestedRuns(requested: string[]): RequestedRun[] {
  let expectsTestName = false;
  const routes = requested.map(
    (argument): { argument: string; route: RoutedArgument | undefined } => {
      const route = expectsTestName ? undefined : routeArgument(argument);
      expectsTestName =
        !expectsTestName && (argument === '-t' || argument === '--test-name-pattern');
      return { argument, route };
    }
  );

  const owners = new Map<string, TestOwner>();
  for (const { route } of routes) {
    if (route !== undefined) owners.set(route.owner.label, route.owner);
  }

  return [...owners.values()].map(
    (owner): RequestedRun => ({
      owner,
      args: routes
        .filter(({ route }): boolean => route === undefined || route.owner.label === owner.label)
        .map(({ argument, route }): string => route?.selector ?? argument),
    })
  );
}

async function runRequested(requested: string[]): Promise<number> {
  const runs = planRequestedRuns(requested);

  if (runs.length === 0) {
    console.error(
      [
        `No argument named a test path this runner can place: ${requested.join(' ')}`,
        'Name a path under packages/<name>/, scripts/ or .archon/scripts/, or run',
        '`bun run test <selector>` from the package directory the selector belongs to.',
      ].join('\n')
    );
    return 1;
  }

  for (const { owner, args } of runs) {
    const code = await run(bunTestCommand(args), owner.cwd);
    if (code !== 0) return code;
  }

  return 0;
}

async function main(requested: string[]): Promise<number> {
  let shard: TestShard | undefined;
  try {
    shard = planShard(requested);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  if (shard !== undefined) return await runPlan(shard);
  return requested.length > 0 ? await runRequested(requested) : await runPlan();
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)));
