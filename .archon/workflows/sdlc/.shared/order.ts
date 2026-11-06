/**
 * Work orders: the work items an operator approved for the factory, one state document
 * `work-order/<id>` each. With `orders_only` on, the build queue claims only members
 * of an open order.
 *
 * An order holds no progress of its own: whether it is done is read from its members'
 * work items. A later step that packages a done order adds its result as a new field;
 * the parse below ignores fields it does not read.
 */

import { note } from './io.ts';
import { record } from './forge.ts';
import { type Stored, stateDocuments, statePut } from './state.ts';
import { read, type WorkItem } from './workitem.ts';

export const ORDER_PREFIX = 'work-order/';

/** `done_at` is when the build queue found every member finished. */
export type OrderStatus =
  | { readonly status: 'open'; readonly done_at: null }
  | { readonly status: 'done'; readonly done_at: string };

export type WorkOrder = OrderStatus & {
  readonly version: 1;
  /** Issue numbers whose work items (`work/<number>`) the order holds, in the operator's rough order. */
  readonly members: readonly number[];
  /** Who approved the order for the factory, and when. */
  readonly approved: { readonly by: string; readonly at: string };
};

/** A stored order, checked as far as the pickup reads it. */
export function parseWorkOrder(value: unknown): WorkOrder {
  const doc = record(value);
  const approved = record(doc?.approved);
  if (
    doc?.version !== 1 ||
    !Array.isArray(doc.members) ||
    doc.members.length === 0 ||
    !doc.members.every(member => Number.isInteger(member) && member > 0) ||
    typeof approved?.by !== 'string' ||
    approved.by === '' ||
    typeof approved.at !== 'string' ||
    !((doc.status === 'open' && doc.done_at === null) || (doc.status === 'done' && typeof doc.done_at === 'string'))
  ) {
    throw new Error('not a version 1 work order');
  }
  return doc as unknown as WorkOrder;
}

/**
 * Whether the item's latest decision is a merge: the merge queue's record is the one fact
 * the pack keeps that an item landed. A build or re-triage after it means the item is
 * being worked again, so an earlier merge no longer finishes it.
 */
function finished(doc: WorkItem): boolean {
  const merge = doc.facts.merge;
  return (
    merge?.status === 'merged' && merge.at >= (doc.facts.build?.at ?? '') && merge.at >= (doc.facts.triage?.at ?? '')
  );
}

function finishedNumbers(): Set<number> {
  const numbers = new Set<number>();
  for (const stored of stateDocuments('work/')) {
    const item = read(stored.name, stored);
    if (item !== undefined && finished(item.doc)) numbers.add(item.doc.subject.number);
  }
  return numbers;
}

/**
 * A malformed order refuses: the switch means "build only what I chose", so guessing
 * past an order the operator wrote wrong would build the wrong thing, or nothing,
 * without saying why.
 */
function storedOrder(stored: Stored & { readonly name: string }): WorkOrder {
  try {
    return parseWorkOrder(stored.value);
  } catch (error) {
    throw new Error(`${stored.name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * The issue numbers of every open order's members, after marking done each open order
 * whose members have all finished. A lost write leaves the order open for the next pickup
 * to mark.
 */
export function openOrderMembers(at: string): Set<number> {
  const open = stateDocuments(ORDER_PREFIX)
    .map(stored => ({ stored, order: storedOrder(stored) }))
    .filter(({ order }) => order.status === 'open');
  if (open.length === 0) return new Set();
  const finishedItems = finishedNumbers();
  const members = new Set<number>();
  for (const { stored, order } of open) {
    if (order.members.every(number => finishedItems.has(number))) {
      const done: WorkOrder = { ...order, status: 'done', done_at: at };
      if (statePut(stored.name, done, stored.revision) === 'ok') note(`${stored.name} is done: every member merged`);
    } else {
      for (const number of order.members) members.add(number);
    }
  }
  return members;
}
