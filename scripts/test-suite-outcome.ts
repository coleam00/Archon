import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Decides the `Test Suite` aggregate check in `.github/workflows/test.yml` from the results of
 * the jobs it needs. A gate that reads only this check has to be able to trust it, so every
 * needed job is judged, including on a documentation-only change:
 *   - a job gated on the `changes` decision may be `skipped` only when that decision is "false";
 *   - every other job, including the ones that run for every event, must be `success`;
 *   - `failure`, `cancelled` and any unexpected `skipped` fail the check.
 *
 * Which jobs are gated is read from the workflow file itself, so a new job cannot be judged by a
 * stale list.
 */

const WORKFLOW = resolve(import.meta.dir, '../.github/workflows/test.yml');
const AGGREGATE_JOB = 'test-suite';
const DECISION_JOB = 'changes';
const RUN_TESTS_GATE = "needs.changes.outputs.run-tests == 'true'";

/** One entry of the Actions `needs` context. */
export interface NeedResult {
  result: string;
  outputs?: Record<string, string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Jobs the aggregate needs that run only when the `changes` decision says to. */
export function jobsGatedOnRunTests(workflowYaml: string): Set<string> {
  const parsed: unknown = Bun.YAML.parse(workflowYaml);
  const jobs = isRecord(parsed) && isRecord(parsed.jobs) ? parsed.jobs : {};
  const aggregate = jobs[AGGREGATE_JOB];
  const needs = isRecord(aggregate) ? aggregate.needs : undefined;
  if (!Array.isArray(needs)) throw new Error(`${AGGREGATE_JOB} has no needs list`);
  return new Set(
    needs.filter((id): id is string => {
      const job = jobs[id];
      return typeof id === 'string' && isRecord(job) && job.if === RUN_TESTS_GATE;
    })
  );
}

/** The reasons the aggregate fails; empty when every needed job finished acceptably. */
export function testSuiteFailures(
  needs: Record<string, NeedResult>,
  gatedOnRunTests: ReadonlySet<string>
): string[] {
  const decision = needs[DECISION_JOB];
  if (decision === undefined) return [`${DECISION_JOB} is not among the needed jobs`];
  const runTests = decision.outputs?.['run-tests'];
  if (decision.result !== 'success' || (runTests !== 'true' && runTests !== 'false')) {
    return [`${DECISION_JOB} finished with ${decision.result} and run-tests=${String(runTests)}`];
  }

  return Object.entries(needs).flatMap(([job, { result }]) => {
    if (job === DECISION_JOB || result === 'success') return [];
    if (result === 'skipped' && runTests === 'false' && gatedOnRunTests.has(job)) return [];
    return [`${job} finished with ${result}`];
  });
}

/** Reads the `needs` context the workflow passes as JSON in `NEEDS`. */
function main(): void {
  const raw = process.env.NEEDS;
  if (!raw) throw new Error('NEEDS must be set to the JSON of the needs context');
  const needs = JSON.parse(raw) as Record<string, NeedResult>;
  const failures = testSuiteFailures(needs, jobsGatedOnRunTests(readFileSync(WORKFLOW, 'utf8')));
  if (failures.length > 0) {
    for (const failure of failures) console.error(failure);
    process.exitCode = 1;
    return;
  }
  console.log('Every test-suite job finished as expected.');
}

if (import.meta.main) main();
