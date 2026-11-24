/**
 * Start the builds this pick chose, one archon-build-queue run per issue.
 *
 * With no message it starts every item that waits for a round, in pickup order. With
 * `orders_only` on, an item the queue never built is started only while it is a member of
 * an open work order, after each open order whose members all finished is marked done. An
 * item the queue has a record for is started either way, so a round begun from intake's
 * handoff, a message or a merge-queue return still gets its next round. A message starts the one
 * issue interpret resolved it to, or the person chose, and refuses with the reason when
 * that issue does not wait; a message that was a work order or new work starts nothing
 * here, and one that resolved to nothing refuses the run with interpret's reason.
 *
 * Every start is a fire of the operator's build-queue binding on the issue's item. The
 * binding admits what its capacity allows, and the engine skips an issue a build run
 * already holds, so an item still building, or one that found no slot, is fired again by
 * the next pick. The delivery id names this run, so a retried node fires no start twice.
 *
 * Bound inputs: INPUTS_REPO from start; INPUTS_INTERPRETED, interpret's output, and
 * INPUTS_CHOSEN, the option the person picked, each "null" when skipped; the workflow's
 * INPUTS_BUILD_QUEUE_BINDING and INPUTS_ORDERS_ONLY.
 */

import { emit, input, refuse, runId as workflowRunId, state, trigger } from 'archon:script';
import { buildWaits, waitingItem } from '../../.shared/build.ts';
import { type QualifiedPr, sameRepo } from '../../.shared/identity.ts';
import { nullableJson } from '../../.shared/inputs.ts';
import { openOrderMembers } from '../../.shared/order.ts';
import { itemKey, PICKUP_ORDER, read, readWorkItem, sortCandidates, type WorkItem } from '../../.shared/workitem.ts';

type Repo = QualifiedPr['repo'];

interface Interpreted {
  readonly decision: 'build' | 'choose' | 'order' | 'intake' | 'none';
  readonly number: number | null;
  readonly reason: string;
}

/** The issue the message names, `none` when it starts nothing here, or null with no message. */
function named(): number | 'none' | null {
  const interpreted = nullableJson(input('interpreted')) as Interpreted | null;
  if (interpreted === null) return null;
  switch (interpreted.decision) {
    case 'build':
      return waitingItem(Number(interpreted.number)).subject.number;
    case 'choose':
      return waitingItem(Number((nullableJson(input('chosen')) as { number?: unknown } | null)?.number)).subject.number;
    case 'order':
    case 'intake':
      return 'none';
    case 'none':
      throw new Error(`the message names nothing to build: ${interpreted.reason}`);
  }
}

/** Every item of the run's repository that waits for a round, in pickup order. */
function waiting(repo: Repo): WorkItem[] {
  const members = input('orders_only').trim() === 'true' ? openOrderMembers(new Date().toISOString()) : null;
  const items = state.listValues('work/')
    .map(stored => read(stored.name, stored))
    .filter(item => item !== undefined)
    .filter(({ doc }) => sameRepo(doc.subject.repo, repo) && buildWaits(doc))
    .filter(({ doc }) => members === null || members.has(doc.subject.number) || doc.facts.build !== undefined);
  return sortCandidates(items, PICKUP_ORDER).map(item => item.doc);
}

function main(): void {
  const binding = input('build_queue_binding').trim();
  if (binding === '') throw new Error('build_queue_binding is empty; the pick starts builds only through that binding');
  const repo = nullableJson(input('repo')) as Repo;
  const runId = workflowRunId();
  const issue = named();
  if (issue === 'none') {
    emit({ fired: [], summary: 'The message starts no build in this run.' });
    return;
  }
  const listed = issue === null ? waiting(repo).map(doc => doc.subject.number) : [issue];
  // Read again just before each fire: a build another pick started can decide an item
  // while this pick works down its list, and a start for it would then be refused.
  const numbers = listed.filter(number => {
    const doc = readWorkItem(number);
    return doc !== null && buildWaits(doc);
  });
  const lines = numbers.map(number => {
    const what = `issue ${String(number)}'s build`;
    // A refused fire, such as a mistyped binding path, fails the node; a busy slot is an admission status.
    const { disposition } = trigger.fire(
      binding,
      { repo_host: repo.host, repo_path: repo.path, number: String(number) },
      { deliveryId: `build-pick:${repo.host}/${repo.path}#${String(number)}:${runId}`, item: itemKey(number) }
    );
    if (disposition?.status === 'admitted') return `${what} started at once (run ${disposition.runId})`;
    if (disposition?.status === 'queued') return `${what} waits for the queue's capacity (request ${disposition.requestId})`;
    return `${what} did not start (its binding ${disposition?.status ?? 'admitted nothing'}), so the next pick starts it`;
  });
  emit({ fired: numbers, summary: lines.length === 0 ? 'No item waits for the build queue.' : lines.join('\n') });
}

try {
  main();
} catch (error) {
  refuse(`build-pick fire: ${error instanceof Error ? error.message : String(error)}`);
}
