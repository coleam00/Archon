/**
 * Start one build-queue run for every work item that waits for the build queue.
 *
 * It lists the waiting items in the pack's pickup order and fires the operator's
 * build-queue binding once for each, with the issue's number and on the issue's item.
 * It claims nothing: each run it starts claims its own issue by number. The binding
 * admits as many as its capacity takes and queues the rest in the order fired. With
 * `orders_only` on it first marks done each open work order whose members all finished,
 * and starts only members of an open order.
 *
 * Bound inputs: INPUTS_BUILD_QUEUE_BINDING and INPUTS_ORDERS_ONLY, the workflow's inputs.
 */

import { emit, input, refuse, runId as workflowRunId } from 'archon:script';
import { BUILD_PICKUP, startWaiting } from '../../.shared/build.ts';
import type { Fired } from '../../.shared/follow-up.ts';
import { openOrderMembers } from '../../.shared/order.ts';
import { idleOutcome, stuckItems } from '../../.shared/stuck.ts';
import { type Pickup, waitingItems } from '../../.shared/workitem.ts';

/**
 * With `orders_only` on, an item waits only while it is a member of an open work order,
 * so no open order starts nothing.
 */
function pickup(at: string): Pickup {
  if (input('orders_only').trim() !== 'true') return BUILD_PICKUP;
  const members = openOrderMembers(at);
  return { ...BUILD_PICKUP, waits: doc => members.has(doc.subject.number) && BUILD_PICKUP.waits(doc) };
}

function said(number: number, fired: Fired): string {
  const issue = `#${String(number)}`;
  if (fired.status === 'admitted') return `${issue} (run ${fired.runId})`;
  if (fired.status === 'queued') return `${issue} (queued, request ${fired.requestId})`;
  return `${issue} (did not start: ${fired.why})`;
}

function main(): void {
  const at = new Date().toISOString();
  const runId = workflowRunId();
  const waiting = waitingItems(at, runId, pickup(at));
  if (waiting.length === 0) {
    emit({ started: [], ...idleOutcome('No item waits for the build queue.', stuckItems(runId, 'build')) });
    return;
  }
  const binding = input('build_queue_binding').trim();
  const fires = waiting.map(({ doc, revision }) => ({
    number: doc.subject.number,
    fired: startWaiting(binding, doc.subject, revision),
  }));
  const started = fires.filter(({ fired }) => fired.status !== 'not_started');
  emit({
    started: started.map(({ number }) => number),
    summary: `${String(waiting.length)} item(s) wait for the build queue, in rank order: ${fires.map(({ number, fired }) => said(number, fired)).join(', ')}.`,
    // A fire that starts nothing leaves its issue to the next pick, and a person should see why.
    healthy: started.length === fires.length,
  });
}

try {
  main();
} catch (error) {
  refuse(`build-pick: ${error instanceof Error ? error.message : String(error)}`);
}
