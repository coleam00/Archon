import { join } from 'node:path';
import {
  parseTestPart,
  partitionTestGroups,
  resolvePackageTestConcurrency,
  resolvePackageTestGroups,
} from './package-test-groups';
import { bunTestCommand, bunTestEnv } from './bun-test-command';
import { resolveRequestedTestGroups } from './package-test-requests';
import { runNameFilteredGroup, type GroupRunner } from './package-test-results';
import { runnerErrorReport, runReportedGroup, writeCombinedReport } from './package-test-reports';

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

const run: GroupRunner = async (args, env) => {
  const child = Bun.spawn(bunTestCommand(args), {
    cwd: packageDir,
    env: bunTestEnv(env),
    stdio: ['inherit', 'inherit', 'inherit'],
  });
  return { code: await child.exited, pid: child.pid };
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

for (const error of request?.validationErrors ?? []) console.error(error.message);
// A single group's native exit already decides the whole request.
const observeNames = groups.length > 1 && request?.hasNameFilter === true && !request.allowsNoTests;
let filteredTests = 0;
let matchedTests = 0;
const reports = (request?.validationErrors ?? []).map(error =>
  runnerErrorReport(error.message, 'Test discovery')
);

/** Runs one group and reports how long it took, for `update-test-weights.ts`. */
const timed = async (group: string[], runGroup: GroupRunner) => {
  const startedAt = performance.now();
  let observedTests = 0;
  const execute = async (args: string[]) => {
    if (!observeNames) return (await runGroup(args)).code;
    const result = await runNameFilteredGroup(args, runGroup, bunTestEnv());
    observedTests = result.filtered + result.matched;
    filteredTests += result.filtered;
    matchedTests += result.matched;
    return result.code;
  };
  let code: number;
  if (observeNames || request?.reporterOutfile !== undefined) {
    const reported = await runReportedGroup(group, execute);
    reports.push(reported.report);
    code = reported.code;
    if (observeNames && code === 0 && reported.report.counts.tests !== observedTests) {
      const message = `Native test results incomplete: received ${observedTests} of ${reported.report.counts.tests} outcomes`;
      console.error(message);
      reports.push(runnerErrorReport(message, 'Native test observer'));
      code = 1;
    }
  } else {
    code = await execute(group);
  }
  console.log(
    `◀ ${packageName} ${group[0]} ${((performance.now() - startedAt) / 1000).toFixed(1)}s`
  );
  return code;
};

const runBuffered: GroupRunner = async (group, env) => {
  console.log(`▶ ${group[0]}`);
  const child = Bun.spawn(bunTestCommand(group), {
    cwd: packageDir,
    env: bunTestEnv(env),
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
  return { code, pid: child.pid };
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
process.exitCode =
  code ||
  (request?.validationErrors.length ? 1 : 0) ||
  (observeNames && filteredTests > 0 && matchedTests === 0 ? 1 : 0);
