import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { jobsGatedOnRunTests, testSuiteFailures, type NeedResult } from './test-suite-outcome';

const SCRIPT = resolve(import.meta.dir, 'test-suite-outcome.ts');
const WORKFLOW = readFileSync(resolve(import.meta.dir, '../.github/workflows/test.yml'), 'utf8');
const GATED = jobsGatedOnRunTests(WORKFLOW);

/** The needs context of a round: `changes` decided `runTests`, every other job as given. */
function needs(runTests: string, results: Record<string, string>): Record<string, NeedResult> {
  return {
    changes: { result: 'success', outputs: { 'run-tests': runTests } },
    ...Object.fromEntries(Object.entries(results).map(([job, result]) => [job, { result }])),
  };
}

/** Every gated job skipped, as on a documentation-only change. */
const docsOnlySkips = Object.fromEntries([...GATED].map(job => [job, 'skipped']));
const ALWAYS = ['static', 'test', 'workflow-fixtures', 'workflow-fixtures-windows'];
const alwaysSuccess = Object.fromEntries(ALWAYS.map(job => [job, 'success']));
const allSuccess = {
  ...Object.fromEntries([...GATED].map(job => [job, 'success'])),
  ...alwaysSuccess,
};

describe('Test Suite aggregate outcome', () => {
  test('reads the gated jobs from test.yml; jobs that run for every event are not gated', () => {
    expect(GATED.has('test')).toBe(false);
    expect(GATED.has('static')).toBe(false);
    expect(GATED.has('workflow-fixtures-windows')).toBe(false);
    expect(GATED.has('workflow-fixtures')).toBe(false);
    expect(GATED.has('changes')).toBe(false);
  });

  test('passes when every job succeeds', () => {
    expect(testSuiteFailures(needs('true', allSuccess), GATED)).toEqual([]);
  });

  test('passes a documentation-only change that skips the gated jobs', () => {
    const results = { ...docsOnlySkips, ...alwaysSuccess };
    expect(testSuiteFailures(needs('false', results), GATED)).toEqual([]);
  });

  test.each(
    ALWAYS.flatMap(job => ['failure', 'cancelled', 'skipped'].map(result => [job, result]))
  )('fails always-run %s with %s even on docs-only changes', (job, result) => {
    expect(
      testSuiteFailures(
        needs('false', { ...docsOnlySkips, ...alwaysSuccess, [job]: result }),
        GATED
      )
    ).toEqual([`${job} finished with ${result}`]);
  });

  test('fails a gated job skipped when the decision said to run it', () => {
    const results = { ...allSuccess, 'docker-build': 'skipped' };
    expect(testSuiteFailures(needs('true', results), GATED)).toEqual([
      'docker-build finished with skipped',
    ]);
  });

  test.each(['failure', 'cancelled'])('fails a gated job that finished with %s', result => {
    const results = { ...allSuccess, 'docker-build': result };
    expect(testSuiteFailures(needs('true', results), GATED)).toEqual([
      `docker-build finished with ${result}`,
    ]);
  });

  test('fails when the decision itself did not succeed or wrote no decision', () => {
    const failed = { ...needs('false', docsOnlySkips), changes: { result: 'failure' } };
    expect(testSuiteFailures(failed, GATED)).toEqual([
      'changes finished with failure and run-tests=undefined',
    ]);
    expect(testSuiteFailures(needs('', docsOnlySkips), GATED)).toEqual([
      'changes finished with success and run-tests=',
    ]);
  });

  test('the script exits non-zero when CI hands it a failing always-run job', () => {
    const result = Bun.spawnSync(['bun', SCRIPT], {
      env: {
        ...process.env,
        NEEDS: JSON.stringify(needs('false', { ...docsOnlySkips, 'workflow-fixtures': 'failure' })),
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain('workflow-fixtures finished with failure');
  });
});
