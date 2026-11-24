import { appendFileSync, existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SaxesParser } from 'saxes';
import { RUNNER_SUITE } from './package-test-reports';

/**
 * CI's backstop for a package test leg that failed: reruns each failing test file once, by
 * itself, through the package's `test` script, and passes only if every rerun passes.
 *
 * Usage: `bun scripts/retry-failed-test-files.ts <package dir> <JUnit report of the failed run>`
 *
 * The private CI runner is small, and some upstream tests are bound to wall-clock budgets that
 * it misses now and then. A rerun of the one file separates that from a real failure without
 * touching the test code. Each rerun prints `RETRIED <file>` to the log and, in Actions, the job
 * summary, so a retry is never silent. Failures are read from the JUnit report, never from test
 * output text. Bun writes no suite for a file that throws while loading; the runner's error for
 * that file's group names it, so a file a failed group names with no suite in the report is
 * rerun alone too. A failure the report ties to no file it can rerun (a failed group whose files
 * all reported and all passed) fails the leg without a rerun.
 */

interface FailedFiles {
  /**
   * Files to rerun, in report order: those with a failing or erroring test or suite, then those
   * a failed group names that left no suite in the report.
   */
  files: string[];
  /** Failures, errors and failed groups that leave no file to rerun. */
  unattributed: number;
}

/** An element the parser is inside: its tag, its `file`, and a suite's or case's `name`. */
interface Open {
  name: string;
  file: string | undefined;
  testcase: string | undefined;
}

export function failedTestFiles(xml: string): FailedFiles {
  const files = new Set<string>();
  // Every file the report has a suite for, failing or not.
  const reported = new Set<string>();
  // The selectors of each group whose process exited non-zero (the runner's own suite).
  const failedGroups: string[][] = [];
  let unattributed = 0;
  const open: Open[] = [];
  const parser = new SaxesParser();
  parser.on('opentag', tag => {
    const attr = (name: string): string | undefined => {
      const value = tag.attributes[name];
      return typeof value === 'string' ? value : undefined;
    };
    const file = attr('file')?.replaceAll('\\', '/');
    if (tag.name === 'testsuite' && file !== undefined) {
      reported.add(file);
      if (Number(attr('errors') ?? 0) > 0) files.add(file);
    }
    if (tag.name === 'failure' || tag.name === 'error') {
      const innermost = (matches: (element: Open) => boolean): Open | undefined =>
        [...open].reverse().find(matches);
      const owner = innermost(element => element.file !== undefined)?.file;
      const inRunnerSuite = open.some(
        element => element.name === 'testsuite' && element.testcase === RUNNER_SUITE
      );
      const group = innermost(element => element.name === 'testcase')?.testcase;
      if (owner !== undefined) files.add(owner);
      else if (inRunnerSuite && group !== undefined) failedGroups.push(group.split(' '));
      else unattributed++;
    }
    open.push({
      name: tag.name,
      file,
      testcase: tag.name === 'testcase' || tag.name === 'testsuite' ? attr('name') : undefined,
    });
  });
  parser.on('closetag', () => {
    open.pop();
  });
  parser.write(xml).close();
  // A failed group is accounted for by its files that failed and by its files that never
  // reported (a file that threw while loading); each of those is rerun alone. One failing file
  // does not account for a silent sibling. A failed group with neither has no file to rerun.
  const bare = (selector: string): string => selector.replace(/^\.\//, '');
  for (const group of failedGroups) {
    for (const selector of group) {
      if (![...reported].some(file => file.includes(bare(selector)))) files.add(bare(selector));
    }
    if (![...files].some(file => group.some(selector => file.includes(bare(selector))))) {
      unattributed++;
    }
  }
  return { files: [...files], unattributed };
}

async function main(): Promise<number> {
  const [packageArg, reportArg] = Bun.argv.slice(2);
  if (packageArg === undefined || reportArg === undefined) {
    console.error('Usage: retry-failed-test-files.ts <package dir> <JUnit report>');
    return 2;
  }
  const packageDir = resolve(packageArg);
  if (!existsSync(reportArg)) {
    console.error(`::error::No JUnit report at ${reportArg}; nothing tells which file failed`);
    return 1;
  }
  const failed = failedTestFiles(readFileSync(reportArg, 'utf8'));
  if (failed.unattributed > 0 || failed.files.length === 0) {
    console.error(
      `::error::The leg failed, but ${reportArg} leaves ${String(failed.unattributed || 'its')} failure(s) with no test file to rerun alone; see the test output above`
    );
    return 1;
  }
  const summary = process.env.GITHUB_STEP_SUMMARY;
  const reports = mkdtempSync(join(tmpdir(), 'archon-test-retry-'));
  let code = 0;
  for (const [index, file] of failed.files.entries()) {
    const line = `RETRIED ${packageArg}/${file}`;
    console.log(line);
    const child = Bun.spawn(
      [
        process.execPath,
        'run',
        'test',
        file,
        '--reporter=junit',
        `--reporter-outfile=${join(reports, `${String(index)}.xml`)}`,
      ],
      { cwd: packageDir, stdio: ['inherit', 'inherit', 'inherit'] }
    );
    const exitCode = await child.exited;
    const verdict = exitCode === 0 ? 'passed on rerun' : 'failed again';
    console.log(`${line}: ${verdict}`);
    if (summary) appendFileSync(summary, `- \`${line}\`: ${verdict}\n`);
    if (exitCode !== 0) code = 1;
  }
  return code;
}

if (import.meta.main) process.exitCode = await main();
