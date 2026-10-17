import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Decides the `Test Suite` aggregate check in `.github/workflows/test.yml` from the results of
 * the jobs it needs. A gate that reads only this check has to be able to trust it, so every
 * needed job is judged, including when the `changes` decision skips the gated jobs (a prose-only
 * pull request, or a push a pull request run already proved):
 *   - a job gated on a `changes` output may be `skipped` only when that output is "false";
 *   - every other job, including the ones that run for every event, must be `success`;
 *   - `failure`, `cancelled` and any unexpected `skipped` fail the check.
 *
 * Which jobs are gated, and on which output, is read from the workflow file itself, so a new job
 * cannot be judged by a stale list. A job is gated on output `k` when its `if` is exactly
 * `needs.changes.outputs.<k> == 'true'`; every output that gates a job must be "true" or "false".
 */

const WORKFLOW = resolve(import.meta.dir, '../.github/workflows/test.yml');
const AGGREGATE_JOB = 'test-suite';
const DECISION_JOB = 'changes';

/** One entry of the Actions `needs` context. */
export interface NeedResult {
  result: string;
  outputs?: Record<string, string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Each job the aggregate needs that runs only when a `changes` output says so, to that output. */
export function jobGates(workflowYaml: string): Map<string, string> {
  const parsed: unknown = Bun.YAML.parse(workflowYaml);
  const jobs = isRecord(parsed) && isRecord(parsed.jobs) ? parsed.jobs : {};
  const aggregate = jobs[AGGREGATE_JOB];
  const needs = isRecord(aggregate) ? aggregate.needs : undefined;
  if (!Array.isArray(needs)) throw new Error(`${AGGREGATE_JOB} has no needs list`);
  const decision = jobs[DECISION_JOB];
  const outputs = isRecord(decision) && isRecord(decision.outputs) ? decision.outputs : {};
  const gates = new Map<string, string>();
  for (const id of needs) {
    const job = typeof id === 'string' ? jobs[id] : undefined;
    if (!isRecord(job)) continue;
    const output = Object.keys(outputs).find(
      key => job.if === `needs.${DECISION_JOB}.outputs.${key} == 'true'`
    );
    if (output !== undefined) gates.set(id, output);
  }
  return gates;
}

/** The reasons the aggregate fails; empty when every needed job finished acceptably. */
export function testSuiteFailures(
  needs: Record<string, NeedResult>,
  gates: ReadonlyMap<string, string>
): string[] {
  const decision = needs[DECISION_JOB];
  if (decision === undefined) return [`${DECISION_JOB} is not among the needed jobs`];
  const undecided = [...new Set(gates.values())].flatMap(output => {
    const value = decision.outputs?.[output];
    return decision.result === 'success' && (value === 'true' || value === 'false')
      ? []
      : [`${DECISION_JOB} finished with ${decision.result} and ${output}=${String(value)}`];
  });
  if (undecided.length > 0) return undecided;

  return Object.entries(needs).flatMap(([job, { result }]) => {
    if (job === DECISION_JOB || result === 'success') return [];
    const gate = gates.get(job);
    if (result === 'skipped' && gate !== undefined && decision.outputs?.[gate] === 'false') {
      return [];
    }
    return [`${job} finished with ${result}`];
  });
}

/** Reads the `needs` context the workflow passes as JSON in `NEEDS`. */
function main(): void {
  const raw = process.env.NEEDS;
  if (!raw) throw new Error('NEEDS must be set to the JSON of the needs context');
  const needs = JSON.parse(raw) as Record<string, NeedResult>;
  const failures = testSuiteFailures(needs, jobGates(readFileSync(WORKFLOW, 'utf8')));
  if (failures.length > 0) {
    for (const failure of failures) console.error(failure);
    process.exitCode = 1;
    return;
  }
  console.log('Every test-suite job finished as expected.');
}

if (import.meta.main) main();
