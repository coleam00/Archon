import { join } from 'node:path';
import {
  parseTestPart,
  partitionTestGroups,
  resolvePackageTestConcurrency,
  resolvePackageTestGroups,
  discoverPackageTestFiles,
  selectWindowsTestFiles,
} from './package-test-groups';
import { bunTestCommand, bunTestEnv } from './bun-test-command';
import { parseTestArguments, resolveRequestedTestGroups } from './package-test-requests';
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
 *
 * Each group gets ten minutes of wall clock, or `ARCHON_TEST_GROUP_LIMIT_SECONDS` when set.
 * Bun's own `--timeout` bounds a pending await and names the case, but a case that spins or
 * deadlocks the runtime outlives it and would hold a CI job until the job is cancelled, with
 * buffered output lost. At the limit the runner kills the group's process by its handle,
 * names the group's files on stderr, prints the output it had so far, and fails the group.
 *
 * `--windows` runs only the package's files marked `WINDOWS_TEST_DIRECTIVE`, each named by its
 * exact path, in the package's isolation groups. A package with none runs nothing and passes.
 */

const packageDir = process.cwd();
const manifestPath = join(packageDir, 'package.json');
const manifest: unknown = await Bun.file(manifestPath).json();

/** Fails loudly on a bad override: a typo that disabled the limit would bring the hang back. */
const groupLimitSeconds = (raw: string | undefined): number => {
  if (raw === undefined || raw === '') return 600;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`ARCHON_TEST_GROUP_LIMIT_SECONDS must be a positive number, got "${raw}"`);
  }
  return seconds;
};
const groupLimit = groupLimitSeconds(process.env.ARCHON_TEST_GROUP_LIMIT_SECONDS);

/**
 * Waits for a group's process and kills it at the group limit. Returns the exit code and
 * whether the limit was hit; a killed group always fails.
 */
const exitWithinLimit = async (
  child: Bun.Subprocess,
  group: string[]
): Promise<{ code: number; killed: boolean }> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limitHit = new Promise<'limit'>(resolve => {
    timer = setTimeout(() => resolve('limit'), groupLimit * 1000);
  });
  const first = await Promise.race([child.exited, limitHit]);
  clearTimeout(timer);
  if (first !== 'limit') return { code: first, killed: false };
  child.kill('SIGKILL');
  await child.exited;
  console.error(
    `✖ ${packageName} group exceeded ${String(groupLimit)}s and was killed (pid ${String(child.pid)}): ${selectedFiles(group).join(' ') || 'Test process'}`
  );
  return { code: 1, killed: true };
};

const run = async (args: string[]): Promise<number> => {
  const child = Bun.spawn(bunTestCommand(args), {
    cwd: packageDir,
    env: bunTestEnv(),
    stdio: ['inherit', 'inherit', 'inherit'],
  });
  return (await exitWithinLimit(child, args)).code;
};

const requested = Bun.argv.slice(2);
const windowsSet = requested.length === 1 && requested[0] === '--windows';

const part =
  requested.length === 0 && !windowsSet ? parseTestPart(process.env.ARCHON_TEST_PART) : undefined;
const packageName =
  typeof manifest === 'object' && manifest !== null && 'name' in manifest
    ? String(manifest.name)
    : packageDir;
const weights: Record<string, Record<string, number>> = await Bun.file(
  join(import.meta.dir, 'test-weights.json')
).json();
const request =
  requested.length > 0 && !windowsSet
    ? resolveRequestedTestGroups(packageDir, manifest, requested)
    : undefined;
/**
 * The marked files, as `./` paths: Bun reads a `./` argument as that one file, where a bare
 * path is a substring filter that also runs any file whose path ends the same way.
 */
const windowsGroups = (): string[][] => {
  const marked = selectWindowsTestFiles(packageDir, discoverPackageTestFiles(packageDir));
  if (marked.length === 0) return [];
  return resolvePackageTestGroups(packageDir, manifest, marked)
    .filter(group => group.length > 0)
    .map(group => group.map(file => `./${file}`));
};
/** Whether every selected group runs even after one fails, as a requested run does. */
const finishEveryGroup = request !== undefined || windowsSet;
const groups =
  (windowsSet ? windowsGroups() : undefined) ??
  request?.groups ??
  partitionTestGroups(
    resolvePackageTestGroups(packageDir, manifest),
    weights[packageName] ?? {},
    part?.count ?? 1
  )[(part?.index ?? 1) - 1];
const concurrency = resolvePackageTestConcurrency(manifest);
if (windowsSet && groups.length === 0) console.log(`${packageName}: no file in the Windows set`);
if (part !== undefined) {
  console.log(`Part ${String(part.index)}/${String(part.count)}: ${String(groups.length)} groups`);
}

const selectedFiles = (group: string[]): string[] =>
  parseTestArguments(group).positionals.map(token => token.value);

const singleGroupOption =
  request?.namePattern !== undefined
    ? 'Name filters require'
    : request?.hasShard
      ? 'Sharding requires'
      : undefined;
if (groups.length > 1 && singleGroupOption !== undefined) {
  throw new Error(
    `${singleGroupOption} one isolation group; selected ${groups.length}:\n${groups.map((group, index) => `  ${index + 1}: ${selectedFiles(group).join(' ')}`).join('\n')}\nSelect files from one group or run each group separately.`
  );
}
const reports: TestReport[] = [];

/**
 * Runs one group and reports how long it took, for `update-test-weights.ts`. A killed group
 * prints its line too; that script reads only jobs that succeeded, so the limit never
 * becomes a weight.
 */
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
    `◀ ${packageName} ${selectedFiles(group)[0] ?? 'Test process'} ${((performance.now() - startedAt) / 1000).toFixed(1)}s`
  );
  return result;
};

const runBuffered = async (group: string[]): Promise<number> => {
  console.log(`▶ ${selectedFiles(group)[0] ?? 'Test process'}`);
  const child = Bun.spawn(bunTestCommand(group), {
    cwd: packageDir,
    env: bunTestEnv(),
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = collect(child.stdout);
  const stderr = collect(child.stderr);
  const { code, killed } = await exitWithinLimit(child, group);
  // After a kill, a grandchild that inherited a pipe can hold it open, so EOF may never come:
  // print what arrived instead of waiting for the rest.
  if (!killed) await Promise.all([stdout.done, stderr.done]);
  for (const chunk of stdout.chunks) process.stdout.write(chunk);
  for (const chunk of stderr.chunks) process.stderr.write(chunk);
  return code;
};

/** Reads a stream as it arrives, so a killed group's partial output can still be printed. */
const collect = (stream: ReadableStream<Uint8Array>) => {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  const done = (async () => {
    for (let read = await reader.read(); !read.done; read = await reader.read()) {
      chunks.push(read.value);
    }
  })();
  return { chunks, done };
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
      if (code !== 0 && !finishEveryGroup) return code;
    }
    return firstFailure;
  }
  let next = 0;
  let firstFailure = 0;
  const worker = async (): Promise<void> => {
    while ((finishEveryGroup || firstFailure === 0) && next < groups.length) {
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
