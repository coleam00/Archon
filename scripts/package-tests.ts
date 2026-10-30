import { join } from 'node:path';
import {
  parseTestPart,
  partitionTestGroups,
  resolvePackageTestConcurrency,
  resolvePackageTestGroups,
} from './package-test-groups';
import { bunTestCommand, bunTestEnv } from './bun-test-command';
import { resolveRequestedTestGroups } from './package-test-requests';
import { runReportedGroup, writeCombinedReport, type TestReport } from './package-test-reports';

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

const part = requested.length === 0 ? parseTestPart(process.env.ARCHON_TEST_PART) : undefined;
const packageName =
  typeof manifest === 'object' && manifest !== null && 'name' in manifest
    ? String(manifest.name)
    : packageDir;
const weights: Record<string, Record<string, number>> = await Bun.file(
  join(import.meta.dir, 'test-weights.json')
).json();
const request =
  requested.length > 0 ? resolveRequestedTestGroups(packageDir, manifest, requested) : undefined;
const groups =
  request?.groups ??
  partitionTestGroups(
    resolvePackageTestGroups(packageDir, manifest),
    weights[packageName] ?? {},
    part?.count ?? 1
  )[(part?.index ?? 1) - 1];
const concurrency = resolvePackageTestConcurrency(manifest);
if (part !== undefined) {
  console.log(`Part ${String(part.index)}/${String(part.count)}: ${String(groups.length)} groups`);
}

const singleGroupOption =
  request?.namePattern !== undefined
    ? 'Name filters require'
    : request?.hasShard
      ? 'Sharding requires'
      : undefined;
if (groups.length > 1 && singleGroupOption !== undefined) {
  throw new Error(
    `${singleGroupOption} one isolation group; selected ${groups.length}:\n${groups.map((group, index) => `  ${index + 1}: ${group.join(' ')}`).join('\n')}\nSelect files from one group or run each group separately.`
  );
}
const reports: TestReport[] = [];

/** Runs one group and reports how long it took, for `update-test-weights.ts`. */
const timed = async (group: string[], runGroup: (group: string[]) => Promise<number>) => {
  const startedAt = performance.now();
  let result: number;
  if (request?.reporterOutfile !== undefined) {
    const reported = await runReportedGroup(group, runGroup);
    reports.push(reported.report);
    result = reported.code;
  } else {
    result = await runGroup(group);
  }
  console.log(
    `◀ ${packageName} ${group[0]} ${((performance.now() - startedAt) / 1000).toFixed(1)}s`
  );
  return result;
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
 * failure a full run stops admitting groups; requested runs finish every selected group.
 */
async function runGroups(): Promise<number> {
  if (concurrency === 1) {
    let firstFailure = 0;
    for (const group of groups) {
      const code = await timed(group, run);
      if (firstFailure === 0) firstFailure = code;
      if (code !== 0 && request === undefined) return code;
    }
    return firstFailure;
  }
  let next = 0;
  let firstFailure = 0;
  const worker = async (): Promise<void> => {
    while ((request !== undefined || firstFailure === 0) && next < groups.length) {
      const code = await timed(groups[next++], runBuffered);
      if (firstFailure === 0) firstFailure = code;
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, groups.length) }, worker));
  return firstFailure;
}

// Not `process.exit`: on a pipe it can cut off the buffered group output written just before.
const code = await runGroups();
if (request?.reporterOutfile !== undefined) writeCombinedReport(request.reporterOutfile, reports);
process.exitCode = code;
