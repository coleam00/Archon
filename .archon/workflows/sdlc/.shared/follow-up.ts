/**
 * Start a queue's follow-up run through the operator's own trigger binding.
 *
 * `archon trigger fire` admits the run under the binding's resource, capacity and
 * overlap policy, like a scheduled pass, and the delivery key makes one decision start
 * at most one run. The binding owns the workflow, its inputs, run-as user, host and
 * resource; the follow-up names only the issue. A follow-up that does not start is
 * noted, and the item waits for the next queue run.
 *
 * A fire from a run on an engine item hands that item to the run it starts unless the
 * fire names one, and nothing declines it. So a fire names the item whenever the run it
 * starts works one issue, and a fire that names none is made only from a run on no item.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { artifactsDir } from 'archon:script';
import { archonCommand } from './host.ts';
import { nullableJson, record } from './inputs.ts';

/** The admission the fired binding's request got, as `trigger fire` prints its receipt. */
function disposition(stdout: string): Record<string, unknown> | undefined {
  const receipt = record(nullableJson(stdout));
  const bindings = Array.isArray(receipt?.bindings) ? receipt.bindings : [];
  return record(record(bindings[0])?.disposition);
}

/** How a fire ended: the run it started, its place in the binding's queue, or why it started nothing. */
export type Fired =
  | { readonly status: 'admitted'; readonly runId: string }
  | { readonly status: 'queued'; readonly requestId: string }
  | { readonly status: 'not_started'; readonly why: string };

/**
 * Fire `binding` (an absolute binding config path) with `inputs` as its event inputs,
 * keyed by `deliveryId`, which must be built from values a retry repeats. `item` is the
 * engine item the started run is on.
 */
export function fire(binding: string, deliveryId: string, inputs: Record<string, string>, item?: string): Fired {
  // Stable key order: the receipt digest covers the inputs as written.
  const sorted = Object.fromEntries(Object.entries(inputs).sort(([a], [b]) => (a < b ? -1 : 1)));
  const dir = join(artifactsDir(), 'follow-up');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${deliveryId.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
  writeFileSync(file, JSON.stringify(sorted));
  const named = item === undefined ? [] : ['--item', item];
  const result = Bun.spawnSync(
    [...archonCommand(), 'trigger', 'fire', '--config', binding, '--delivery-id', deliveryId, '--inputs', file, ...named],
    { env: process.env, stdout: 'pipe', stderr: 'pipe' }
  );
  if (result.exitCode !== 0) {
    // The first line says why, so a refused fire (a mistyped binding path) does not read like a full queue.
    const refused = result.stderr.toString().trim().split('\n')[0] ?? '';
    return { status: 'not_started', why: refused || `trigger fire exited ${String(result.exitCode)}` };
  }
  const admitted = disposition(result.stdout.toString());
  if (admitted?.status === 'admitted') return { status: 'admitted', runId: String(admitted.runId) };
  if (admitted?.status === 'queued') return { status: 'queued', requestId: String(admitted.requestId) };
  return { status: 'not_started', why: `its binding ${String(admitted?.status ?? 'admitted nothing')}` };
}

/**
 * Fire a queue's follow-up and say how `what` proceeds, for the run's summary. `later`
 * says what starts `what` when this fire does not; `item` is as `fire` takes it.
 */
export function followUp(
  binding: string,
  deliveryId: string,
  inputs: Record<string, string>,
  what: string,
  { later = 'the next queue run picks it up', item }: { readonly later?: string; readonly item?: string } = {}
): string {
  if (binding === '') return `no follow-up binding is set, so ${what} did not start and ${later}`;
  const fired = fire(binding, deliveryId, inputs, item);
  if (fired.status === 'admitted') return `${what} started at once (run ${fired.runId})`;
  if (fired.status === 'queued') return `${what} waits for the queue's capacity (request ${fired.requestId})`;
  console.error(`${what} did not start, so ${later}: ${fired.why}`);
  return `${what} did not start (${fired.why}), so ${later}`;
}

/**
 * Start a build pick now through the operator's build-pick binding, for an item intake
 * just routed. The fire names no issue: the pick starts every waiting item in rank order
 * under its own `orders_only`. Intake runs on no item, so neither does the pick.
 */
export function nextPick(binding: string, key: string): string {
  return followUp(binding, `build-pick:${key}`, {}, 'a build pick', { later: 'the next scheduled pick starts the item' });
}
