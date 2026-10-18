import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { jobGates, testSuiteFailures, type NeedResult } from './test-suite-outcome';

const SCRIPT = resolve(import.meta.dir, 'test-suite-outcome.ts');
const WORKFLOW = readFileSync(resolve(import.meta.dir, '../.github/workflows/test.yml'), 'utf8');
const GATED = jobGates(WORKFLOW);

/**
 * The needs context of a round: `changes` decided `runTests`, and the workspace decision
 * follows it unless given, every other job as given.
 */
function needs(
  runTests: string,
  results: Record<string, string>,
  runWorkspaceTests = runTests
): Record<string, NeedResult> {
  return {
    changes: {
      result: 'success',
      outputs: { 'run-tests': runTests, 'run-workspace-tests': runWorkspaceTests },
    },
    ...Object.fromEntries(Object.entries(results).map(([job, result]) => [job, { result }])),
  };
}

/** Every gated job skipped, as on a prose-only pull request or a push a pull request run proved. */
const decisionSkips = Object.fromEntries([...GATED.keys()].map(job => [job, 'skipped']));
const ALWAYS = ['static'];
const alwaysSuccess = Object.fromEntries(ALWAYS.map(job => [job, 'success']));
const allSuccess = {
  ...Object.fromEntries([...GATED.keys()].map(job => [job, 'success'])),
  ...alwaysSuccess,
};

describe('Test Suite aggregate outcome', () => {
  test('reads the gated jobs from test.yml; jobs that run for every event are not gated', () => {
    expect(GATED.get('test')).toBe('run-workspace-tests');
    expect(GATED.get('test-scripts')).toBe('run-tests');
    expect(GATED.has('static')).toBe(false);
    expect(GATED.has('changes')).toBe(false);
  });

  test('passes when every job succeeds', () => {
    expect(testSuiteFailures(needs('true', allSuccess), GATED)).toEqual([]);
  });

  test('passes a decision that skips the gated jobs', () => {
    const results = { ...decisionSkips, ...alwaysSuccess };
    expect(testSuiteFailures(needs('false', results), GATED)).toEqual([]);
  });

  test.each(
    ALWAYS.flatMap(job => ['failure', 'cancelled', 'skipped'].map(result => [job, result]))
  )('fails always-run %s with %s even when the gated jobs skip', (job, result) => {
    expect(
      testSuiteFailures(
        needs('false', { ...decisionSkips, ...alwaysSuccess, [job]: result }),
        GATED
      )
    ).toEqual([`${job} finished with ${result}`]);
  });

  test('passes the workspace shards skipped on their own decision while the suite runs', () => {
    const results = { ...allSuccess, test: 'skipped' };
    expect(testSuiteFailures(needs('true', results, 'false'), GATED)).toEqual([]);
  });

  test('fails the workspace shards skipped when their decision said to run them', () => {
    const results = { ...allSuccess, test: 'skipped' };
    expect(testSuiteFailures(needs('true', results, 'true'), GATED)).toEqual([
      'test finished with skipped',
    ]);
  });

  test.each(['', 'maybe'])('fails an invalid workspace decision %j', value => {
    expect(testSuiteFailures(needs('true', allSuccess, value), GATED)).toEqual([
      `changes finished with success and run-workspace-tests=${value}`,
    ]);
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
    const failed = { ...needs('false', decisionSkips), changes: { result: 'failure' } };
    expect(testSuiteFailures(failed, GATED)).toEqual([
      'changes finished with failure and run-workspace-tests=undefined',
      'changes finished with failure and run-tests=undefined',
    ]);
    expect(testSuiteFailures(needs('', decisionSkips, 'false'), GATED)).toEqual([
      'changes finished with success and run-tests=',
    ]);
  });

  test('the script exits non-zero when CI hands it a failing always-run job', () => {
    const result = Bun.spawnSync(['bun', SCRIPT], {
      env: {
        ...process.env,
        NEEDS: JSON.stringify(needs('false', { ...decisionSkips, static: 'failure' })),
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain('static finished with failure');
  });
});

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Expected a workflow mapping');
  }
  return Object.fromEntries(Object.entries(value));
}

const jobs = record(record(Bun.YAML.parse(WORKFLOW)).jobs);
function jobSteps(job: Record<string, unknown>): Record<string, unknown>[] {
  if (!Array.isArray(job.steps)) throw new Error('Expected workflow steps');
  return job.steps.map(record);
}

describe('CI wiring', () => {
  test('static runs independently of the selector', () => {
    expect(record(jobs.static).needs).toBeUndefined();
    expect(record(jobs.static).if).toBe('${{ !github.event.pull_request.draft }}');
  });

  test('the test shards run only when their change decision selects them', () => {
    expect(record(jobs.test).needs).toBe('changes');
    expect(record(jobs.test).if).toBe("needs.changes.outputs.run-workspace-tests == 'true'");
    expect(record(jobs['test-scripts']).needs).toBe('changes');
    expect(record(jobs['test-scripts']).if).toBe("needs.changes.outputs.run-tests == 'true'");
  });

  test('publishes the workspace decision from the deciding step', () => {
    const changes = record(jobs.changes);
    expect(record(changes.outputs)['run-workspace-tests']).toBe(
      '${{ steps.decision.outputs.run-workspace-tests }}'
    );
    const decision = jobSteps(changes).find(step => step.id === 'decision');
    expect(decision?.run).toContain(
      'run_workspace_tests=$(bun scripts/should-run-test-suite.ts --workspace-tests)'
    );
    expect(decision?.run).toContain(
      'echo "run-workspace-tests=$run_workspace_tests" >> "$GITHUB_OUTPUT"'
    );
  });
});
