import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { DEFAULT_TEST_TIMEOUT_MS } from '@archon/paths/test-utils';
import { parseTestArguments } from './package-test-requests';

/** One transpiler cache for every test process, whatever home a test gives its child. */
export const TEST_TRANSPILER_CACHE = join(
  import.meta.dir,
  '..',
  'node_modules',
  '.cache',
  'bun-transpiler'
);

const REPO_ROOT = join(import.meta.dir, '..');

/**
 * Names the directory a runner writes one JUnit report per test process into, for
 * `near-limit-tests.ts`. Only runners read it: `bunTestEnv` leaves it out of a test
 * process, so a test that starts a runner or `bun test` of its own reports nothing there.
 */
export const TEST_REPORT_DIR_ENV = 'ARCHON_TEST_REPORT_DIR';

let reportCount = 0;

/**
 * The `bun test` command for `selectors`. A runner passes the directory the process runs
 * in as `cwd`: with `ARCHON_TEST_REPORT_DIR` set, the process then writes a JUnit report to
 * `<dir>/<cwd relative to the repo, or root>/<pid>-<n>.xml`. A report's `file` is relative
 * to that cwd, and the same `src/x.test.ts` exists in several packages, so the directory
 * name is how the reader finds the source. A caller that names `--reporter` keeps its own.
 */
export function bunTestCommand(
  selectors: readonly string[],
  cwd?: string,
  env: NodeJS.ProcessEnv = process.env
): string[] {
  const reportDir = env[TEST_REPORT_DIR_ENV];
  const reports =
    cwd !== undefined &&
    reportDir !== undefined &&
    reportDir !== '' &&
    !parseTestArguments([...selectors]).optionTokens.some(token => token.name === 'reporter');
  const report: string[] = [];
  if (reports) {
    const directory = join(reportDir, relative(REPO_ROOT, cwd).replaceAll('\\', '/') || 'root');
    mkdirSync(directory, { recursive: true });
    reportCount += 1;
    const outfile = join(directory, `${String(process.pid)}-${String(reportCount)}.xml`);
    report.push('--reporter=junit', `--reporter-outfile=${outfile}`);
  }
  return ['bun', 'test', '--timeout', String(DEFAULT_TEST_TIMEOUT_MS), ...report, ...selectors];
}

const gitConfigFiles: string[] = [];
process.on('exit', () => {
  for (const file of gitConfigFiles) rmSync(file, { force: true });
});

/**
 * A global git config of its own for one test process. Git processes in tests read it, and
 * the product code under test writes it (`git config --global safe.directory`). Shared, it
 * is the operator's real ~/.gitconfig: on a Windows runner a reader that overlaps a writer
 * in a parallel suite fails with "unable to access ... Permission denied" (#2924). It has
 * to be in the environment the test process starts with: on Windows, Bun.spawn children
 * do not inherit a variable the process set after startup, so a preload cannot provide it.
 */
function privateGitConfig(): string {
  const file = join(tmpdir(), `archon-test-gitconfig-${process.pid}-${gitConfigFiles.length}`);
  gitConfigFiles.push(file);
  return file;
}

/**
 * Environment for a `bun test` process. Tests never send telemetry: a test that
 * starts a real CLI or engine with a temp `ARCHON_HOME` would otherwise mint a
 * fresh install id per run and report it as a real install. A test that covers
 * telemetry itself re-enables it by setting the variable in its own child env.
 *
 * Bun keeps its runtime transpiler cache under the home directory (`USERPROFILE` on
 * Windows, `HOME` elsewhere), so a test that gives its child a scratch home would start
 * that child cold and have it write a fresh cache into the scratch home. On windows-latest
 * that is measurably slower per spawn and adds small-file writes to the OS disk that
 * already saturates under the parallel suite (#3294). Pinning the path keeps every such
 * child warm; a caller's own setting wins.
 *
 * `ARCHON_TEST_REPORT_DIR` is for the runner that starts test processes, so it stays only
 * when the child is itself a runner (`runner: true`).
 */
export function bunTestEnv(
  env: NodeJS.ProcessEnv = process.env,
  { runner = false }: { runner?: boolean } = {}
): NodeJS.ProcessEnv {
  const { [TEST_REPORT_DIR_ENV]: reportDir, ...inherited } = env;
  return {
    ...inherited,
    ...(runner && reportDir !== undefined ? { [TEST_REPORT_DIR_ENV]: reportDir } : {}),
    GIT_CONFIG_GLOBAL: privateGitConfig(),
    ARCHON_TELEMETRY_DISABLED: env.ARCHON_TELEMETRY_DISABLED ?? '1',
    BUN_RUNTIME_TRANSPILER_CACHE_PATH:
      env.BUN_RUNTIME_TRANSPILER_CACHE_PATH ?? TEST_TRANSPILER_CACHE,
  };
}
