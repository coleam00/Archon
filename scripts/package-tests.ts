import { join } from 'node:path';
import { resolvePackageTestConcurrency, resolvePackageTestGroups } from './package-test-groups';
import { bunTestCommand, bunTestEnv } from './bun-test-command';

/**
 * Runs one package's tests, from that package's directory.
 *
 * A package splits its suite into groups that each get a fresh `bun test` process,
 * because mocks leak between files inside a single process. Expressing those groups
 * as `bun test ... && bun test ...` directly in the `test` script has a trap: `bun run`
 * appends its arguments to whatever the script expands to, so `bun run test <path>`
 * runs the whole chain and then tacks the path onto the last group. Going through this
 * runner makes the argument mean what it says.
 *
 * Execution and inventory share the resolver for manifest groups or file discovery.
 *
 * A package may set `testConcurrency` to run that many groups at once. Each group is still
 * its own process, so isolation is unchanged. Concurrent groups buffer their output and print
 * it whole when they exit, so logs never interleave; a start line names each group, so a hung
 * run shows which groups were in flight.
 */

const packageDir = process.cwd();
const manifestPath = join(packageDir, 'package.json');
const manifest: unknown = await Bun.file(manifestPath).json();

const run = async (args: string[]): Promise<number> => {
  const child = Bun.spawn(bunTestCommand(args), {
    cwd: packageDir,
    env: bunTestEnv(),
    stdio: ['inherit', 'inherit', 'inherit'],
  });
  return await child.exited;
};

const requested = Bun.argv.slice(2);

// Requested arguments go through verbatim. Do not add a path-existence check here:
// `bun test` already exits 1 when a selector matches no test file, and its selectors are
// substring filters rather than paths, so `bun run test logger` is a valid run that any
// such check would refuse. The exit-0-on-a-bad-path this runner was written to fix came
// from `bun run` appending the argument to a chain whose other selectors still matched.
if (requested.length > 0) process.exit(await run(requested));

const groups = resolvePackageTestGroups(packageDir, manifest);
const concurrency = resolvePackageTestConcurrency(manifest);

const runBuffered = async (group: string[]): Promise<number> => {
  console.log(`▶ ${group[0]}`);
  const child = Bun.spawn(bunTestCommand(group), {
    cwd: packageDir,
    env: bunTestEnv(),
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  return code;
};

/**
 * Runs the groups `concurrency` at a time and returns the first failure's code. After a
 * failure no new group starts, but the running ones finish so their output is not lost.
 */
async function runGroups(): Promise<number> {
  if (concurrency === 1) {
    for (const group of groups) {
      const code = await run(group);
      if (code !== 0) return code;
    }
    return 0;
  }
  let next = 0;
  let firstFailure = 0;
  const worker = async (): Promise<void> => {
    while (firstFailure === 0 && next < groups.length) {
      const code = await runBuffered(groups[next++]);
      if (firstFailure === 0) firstFailure = code;
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, groups.length) }, worker));
  return firstFailure;
}

// Not `process.exit`: on a pipe it can cut off the buffered group output written just before.
process.exitCode = await runGroups();
