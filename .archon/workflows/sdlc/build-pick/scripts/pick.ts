/**
 * Start build-queue runs for the work items that wait for the build queue.
 *
 * It lists the waiting items in the pack's pickup order and fires the operator's
 * build-queue binding for the first `limit` of them, each with the issue's number and on
 * the issue's item. It claims nothing: each run it starts claims its own issue by number.
 * The binding admits as many as its capacity takes and queues the rest in the order
 * fired. An item an earlier pass fired and that still waits keeps its rank and is fired
 * again with the same delivery, which the engine starts once, so the queue stays about
 * `limit` deep and each pass ranks afresh.
 *
 * A fire that answers with a run that has already ended, for an item that still waits,
 * is a start that died before it claimed the issue. A claim is a write and moves the
 * work item's revision, so a replay that answers with an ended run for an item still
 * waiting at that revision can only be a start that never claimed. No later pass starts
 * that item, so the pick names it and ends as a failed outcome; it fires nothing new for
 * it.
 *
 * With `orders_only` on it first marks done each open work order whose members all
 * finished, and starts only members of an open order. With `revisit_blocked` on it also
 * fires one start that names no issue, which revisits the blocked items and builds
 * nothing.
 *
 * Bound inputs: INPUTS_BUILD_QUEUE_BINDING, INPUTS_LIMIT, INPUTS_ORDERS_ONLY and
 * INPUTS_REVISIT_BLOCKED, the workflow's inputs.
 */

import { emit, input, refuse, runId as workflowRunId } from 'archon:script';
import { BUILD_PICKUP, startRevisit, startWaiting } from '../../.shared/build.ts';
import type { Fired } from '../../.shared/follow-up.ts';
import { runStatus } from '../../.shared/host.ts';
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

function limit(): number {
  const parsed = Number(input('limit').trim());
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error('limit must be a positive integer');
  return parsed;
}

/** The statuses of a run that will do nothing more. */
const ENDED: readonly string[] = ['completed', 'failed', 'cancelled'];

/** One fired item: what the fire answered, and the ended run it answered with, when it did. */
interface Start {
  readonly number: number;
  readonly fired: Fired;
  readonly ended: string | null;
}

function start(number: number, fired: Fired): Start {
  const status = fired.status === 'admitted' ? runStatus(fired.runId) : '';
  return { number, fired, ended: ENDED.includes(status) ? status : null };
}

function said(what: string, fired: Fired): string {
  if (fired.status === 'admitted') return `${what} (run ${fired.runId})`;
  if (fired.status === 'queued') return `${what} (queued, request ${fired.requestId})`;
  return `${what} (did not start: ${fired.why})`;
}

function saidStart({ number, fired, ended }: Start): string {
  const issue = `#${String(number)}`;
  if (ended === null || fired.status !== 'admitted') return said(issue, fired);
  return `${issue} (stranded: run ${fired.runId} ${ended} before it claimed the issue, and nothing starts it again; start it with --input number=${String(number)} --item issue-${String(number)}, or re-triage it)`;
}

function main(): void {
  const at = new Date().toISOString();
  const runId = workflowRunId();
  const binding = input('build_queue_binding').trim();
  const waiting = waitingItems(at, runId, pickup(at));
  const starts = waiting
    .slice(0, limit())
    .map(({ doc, revision }) => start(doc.subject.number, startWaiting(binding, doc.subject, revision)));
  const revisit = input('revisit_blocked').trim() === 'true' ? startRevisit(binding, at) : null;
  const items =
    starts.length === 0
      ? idleOutcome('No item waits for the build queue.', stuckItems(runId, 'build'))
      : {
          summary: `${String(waiting.length)} item(s) wait for the build queue; this pass fired the first ${String(starts.length)} in rank order: ${starts.map(saidStart).join(', ')}.`,
          healthy: true,
        };
  const stranded = starts.filter(({ ended }) => ended !== null).map(({ number }) => number);
  emit({
    started: starts.filter(({ fired, ended }) => fired.status !== 'not_started' && ended === null).map(({ number }) => number),
    stranded,
    summary: revisit === null ? items.summary : `${items.summary} ${said('The revisit of blocked items', revisit)}.`,
    // A fire that starts nothing leaves its work to the next pick, and a stranded item to a person.
    healthy:
      items.healthy &&
      stranded.length === 0 &&
      [...starts.map(({ fired }) => fired), revisit].every(fired => fired?.status !== 'not_started'),
  });
}

try {
  main();
} catch (error) {
  refuse(`build-pick: ${error instanceof Error ? error.message : String(error)}`);
}
