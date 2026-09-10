import { existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

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
 */

/** One step of the no-argument run. */
export type RootTestStep = { kind: 'workspaces' } | { kind: 'root'; selectors: string[] };

/**
 * The no-argument run. `scripts/test-inventory.test.ts` reads the same array to prove
 * every tracked test is collected, so execution and inventory cannot drift apart.
 */
export const ROOT_TEST_PLAN: readonly RootTestStep[] = [
  { kind: 'workspaces' },
  { kind: 'root', selectors: ['./scripts/'] },
  { kind: 'root', selectors: ['./.archon/scripts/'] },
];

/** Each workspace runs its own `test` script, which owns that package's group splitting. */
const WORKSPACE_TEST_COMMAND = ['bun', '--filter', '*', '--parallel', 'test'];

const REPO_ROOT = join(import.meta.dir, '..');

/** Directories the root tests directly. Every other test belongs to a workspace package. */
const ROOT_OWNED_PREFIXES = ROOT_TEST_PLAN.flatMap((step): string[] =>
  step.kind === 'root'
    ? step.selectors.map((selector): string => selector.replace(/^\.\//, ''))
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
 * relative to that owner's working directory. Arguments this cannot place — flags, flag
 * values and substring filters — come back `undefined` and are forwarded verbatim.
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

  return ROOT_OWNED_PREFIXES.some((prefix): boolean => repoPath.startsWith(prefix))
    ? { owner: { label: 'the repository root', cwd: REPO_ROOT }, selector: `./${repoPath}` }
    : undefined;
}

async function run(command: string[], cwd: string): Promise<number> {
  const child = Bun.spawn(command, { cwd, stdio: ['inherit', 'inherit', 'inherit'] });
  return await child.exited;
}

async function runPlan(): Promise<number> {
  for (const step of ROOT_TEST_PLAN) {
    const command =
      step.kind === 'workspaces' ? WORKSPACE_TEST_COMMAND : ['bun', 'test', ...step.selectors];
    const code = await run(command, REPO_ROOT);
    if (code !== 0) return code;
  }
  return 0;
}

/**
 * Turns the requested arguments into one run per owner they name, in the order the owners
 * were first named. Arguments this cannot place go to every run, since a flag value or a
 * substring filter is meaningful to whichever owner the placed arguments chose. No named
 * owner means no run: the caller reports that rather than falling back to the full suite.
 */
export function planRequestedRuns(requested: string[]): RequestedRun[] {
  const routes = requested.map(
    (argument): { argument: string; route: RoutedArgument | undefined } => ({
      argument,
      route: routeArgument(argument),
    })
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
    const code = await run(['bun', 'test', ...args], owner.cwd);
    if (code !== 0) return code;
  }

  return 0;
}

if (import.meta.main) {
  const requested = Bun.argv.slice(2);
  process.exit(requested.length > 0 ? await runRequested(requested) : await runPlan());
}
