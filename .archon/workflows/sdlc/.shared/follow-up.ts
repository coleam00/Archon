/**
 * Start a queue's follow-up run through the operator's own trigger binding.
 *
 * `archon trigger fire` admits the run under the binding's resource, capacity and
 * overlap policy, like a scheduled pass, and the delivery key makes one decision start
 * at most one run. The binding owns the workflow, its inputs, run-as user, host and
 * resource; the follow-up names only the item. A follow-up that does not start is
 * noted, and the item waits for the next queue run.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { archonCommand, record } from './forge.ts';
import { artifactsDir, note, nullableJson } from './io.ts';

/** The admission the fired binding's request got, as `trigger fire` prints its receipt. */
function disposition(stdout: string): Record<string, unknown> | undefined {
  const receipt = record(nullableJson(stdout));
  const bindings = Array.isArray(receipt?.bindings) ? receipt.bindings : [];
  return record(record(bindings[0])?.disposition);
}

/**
 * Fire `binding` (an absolute timer-binding config path) with `inputs` as its event
 * inputs, keyed by `deliveryId`, which must be built from values a retry repeats.
 * Returns how `what` proceeds, for the run's summary.
 */
export function followUp(binding: string, deliveryId: string, inputs: Record<string, string>, what: string): string {
  if (binding === '') return `no follow-up binding is set, so the next queue run picks up ${what}`;
  // Stable key order: the receipt digest covers the inputs as written.
  const sorted = Object.fromEntries(Object.entries(inputs).sort(([a], [b]) => (a < b ? -1 : 1)));
  const dir = join(artifactsDir(), 'follow-up');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${deliveryId.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
  writeFileSync(file, JSON.stringify(sorted));
  const result = Bun.spawnSync(
    [...archonCommand(), 'trigger', 'fire', '--config', binding, '--delivery-id', deliveryId, '--inputs', file],
    { env: process.env, stdout: 'pipe', stderr: 'pipe' }
  );
  const admitted = result.exitCode === 0 ? disposition(result.stdout.toString()) : undefined;
  if (admitted?.status === 'admitted') return `${what} started at once (run ${String(admitted.runId)})`;
  if (admitted?.status === 'queued') return `${what} waits for the queue's capacity (request ${String(admitted.requestId)})`;
  // The summary says why, so a refused fire (a mistyped binding path) does not read like a full queue.
  const why =
    result.exitCode === 0
      ? `its binding ${String(admitted?.status ?? 'admitted nothing')}`
      : (result.stderr.toString().trim().split('\n')[0] ?? '') || `trigger fire exited ${String(result.exitCode)}`;
  note(`${what} did not start, so the next queue run picks it up: ${why}`);
  return `${what} did not start (${why}), so the next queue run picks it up`;
}
