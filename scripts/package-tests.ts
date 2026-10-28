import { join } from 'node:path';
import {
  parseTestPart,
  partitionTestGroups,
  resolvePackageTestConcurrency,
  resolvePackageTestGroups,
} from './package-test-groups';
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
 *
 * `ARCHON_TEST_PART=<index>/<count>` runs one of `count` parts of the package's groups, split
 * by the measured group times in `test-weights.json` (see `partitionTestGroups`). CI uses it to
 * spread one shard across runners. Each group ends with a
 * `◀ <package> <first selector> <seconds>s` line, which `update-test-weights.ts` reads back
 * from a CI run to refresh the weights.
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

const part = parseTestPart(process.env.ARCHON_TEST_PART);
const packageName =
  typeof manifest === 'object' && manifest !== null && 'name' in manifest
    ? String(manifest.name)
    : packageDir;
const weights: Record<string, Record<string, number>> = await Bun.file(
  join(import.meta.dir, 'test-weights.json')
).json();
const groups = partitionTestGroups(
  resolvePackageTestGroups(packageDir, manifest),
  weights[packageName] ?? {},
  part?.count ?? 1
)[(part?.index ?? 1) - 1];
const concurrency = resolvePackageTestConcurrency(manifest);
if (part !== undefined) {
  console.log(`Part ${String(part.index)}/${String(part.count)}: ${String(groups.length)} groups`);
}

/** Runs one group and reports how long it took, for `update-test-weights.ts`. */
const timed = async (group: string[], runGroup: (group: string[]) => Promise<number>) => {
  const startedAt = performance.now();
  const code = await runGroup(group);
  console.log(
    `◀ ${packageName} ${group[0]} ${((performance.now() - startedAt) / 1000).toFixed(1)}s`
  );
  return code;
};

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
      const code = await timed(group, run);
      if (code !== 0) return code;
    }
    return 0;
  }
  let next = 0;
  let firstFailure = 0;
  const worker = async (): Promise<void> => {
    while (firstFailure === 0 && next < groups.length) {
      const code = await timed(groups[next++], runBuffered);
      if (firstFailure === 0) firstFailure = code;
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, groups.length) }, worker));
  return firstFailure;
}

// Not `process.exit`: on a pipe it can cut off the buffered group output written just before.
process.exitCode = await runGroups();
