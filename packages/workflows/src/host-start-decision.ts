/**
 * What a host's drain does with its queued starts, decided in one place. The drain admits
 * from it, a new start of the host is ordered behind it, and the run-limit report reads its
 * reasons from it, so what is reported waiting is what the next drain holds.
 */
import { itemHoldKey } from './item-hold';
import {
  checkoutHolder,
  checkoutKeys,
  queuedItemHolder,
  validQueuedStarts,
  type QueuedStart,
  type ResourceSlotOccupancy,
} from './resource-start-store';

/**
 * One queued start of the host and what its drain does with it: admit it, or hold it, for
 * the run limit's room (`run-limit`) or for its resource's capacity, a checkout or its item
 * (`resource`).
 */
export type HostStartVerdict = { start: QueuedStart; resource: string } & (
  | { verdict: 'admit' }
  | { verdict: 'held'; by: 'run-limit' | 'resource' }
);

/** One resource as the walk leaves it: its admitted starts count and hold their checkouts. */
interface SlotState {
  slot: ResourceSlotOccupancy;
  free: number;
  held: Map<string, string>;
  foreign: Map<string, string>;
}

/**
 * Walk `hostId`'s queued starts in its queue order (`order`, the host's request ids by queue
 * position) across every resource it queues on, and decide each as a drain would. An
 * admitted start takes a unit of its resource's capacity, one of the run limit's `room`
 * (`Infinity` without a limit), its item, and its checkout: on its own resource, and as a
 * foreign holder on every other, as the stores read an admitted run's row afterwards. A start
 * whose checkout or item a live run or an earlier admit holds keeps its place and is passed
 * over. A start that is not a valid queued start of the host on one of `slots` is left out,
 * as a drain leaves it.
 */
export function decideHostStarts(input: {
  hostId: string;
  slots: ReadonlyMap<string, ResourceSlotOccupancy>;
  order: readonly string[];
  room: number;
}): HostStartVerdict[] {
  const states = new Map<string, SlotState>();
  const queued = new Map<
    string,
    { entry: { start: QueuedStart; resource: string }; state: SlotState }
  >();
  const heldItems = new Map<string, string>();
  for (const [resource, slot] of input.slots) {
    const state = {
      slot,
      free: slot.capacity - slot.holders.length - slot.waiters.length,
      held: new Map(slot.heldCheckouts),
      foreign: new Map(slot.foreignHeldCheckouts),
    };
    states.set(resource, state);
    for (const [key, holder] of slot.heldItems) heldItems.set(key, holder);
    for (const start of validQueuedStarts(slot))
      if (start.hostId === input.hostId)
        queued.set(start.id, { entry: { start, resource }, state });
  }
  let room = input.room;
  const verdicts: HostStartVerdict[] = [];
  for (const id of input.order) {
    const found = queued.get(id);
    if (found === undefined) continue;
    const { entry, state } = found;
    if (resourceHolds(state, heldItems, entry.start)) {
      verdicts.push({ ...entry, verdict: 'held', by: 'resource' });
      continue;
    }
    if (room <= 0) {
      verdicts.push({ ...entry, verdict: 'held', by: 'run-limit' });
      continue;
    }
    room -= 1;
    admit(states, heldItems, entry);
    verdicts.push({ ...entry, verdict: 'admit' });
  }
  return verdicts;
}

/** Whether the start's resource keeps it: no capacity left, or its checkout or item is held. */
function resourceHolds(
  state: SlotState,
  heldItems: ReadonlyMap<string, string>,
  start: QueuedStart
): boolean {
  if (state.free <= 0) return true;
  const slot = { ...state.slot, heldCheckouts: state.held, foreignHeldCheckouts: state.foreign };
  return (
    checkoutHolder(slot, start.launch) !== undefined ||
    queuedItemHolder(heldItems, start) !== undefined
  );
}

/**
 * Record what an admitted start holds: the checkout keys its run row gives a store's next
 * read (its launch checkout, its recorded working path and their registered aliases), local
 * on its own resource and foreign on the others, and its item.
 */
function admit(
  states: ReadonlyMap<string, SlotState>,
  heldItems: Map<string, string>,
  { start, resource }: { start: QueuedStart; resource: string }
): void {
  for (const [name, state] of states) {
    const keys = checkoutKeys(
      start.launch,
      start.launch.run.working_path,
      state.slot.reusableCheckouts
    );
    const held = name === resource ? state.held : state.foreign;
    for (const key of keys) if (!held.has(key)) held.set(key, start.id);
    if (name === resource) state.free -= 1;
  }
  if (start.itemId !== null)
    heldItems.set(itemHoldKey(start.launch.run.workflow_name, start.itemId), start.id);
}

/**
 * The queued requests a drain by `hostId` admits now on one resource, with no run limit, in
 * order: `decideHostStarts` for that resource alone. A request of another host is passed
 * over: it waits only for its own host's drain and blocks no other host (see
 * `resourceStartBlocker`).
 */
export function drainableStarts(slot: ResourceSlotOccupancy, hostId: string): QueuedStart[] {
  return decideHostStarts({
    hostId,
    slots: new Map([['', slot]]),
    order: slot.queue.map(start => start.id),
    room: Infinity,
  }).flatMap(verdict => (verdict.verdict === 'admit' ? [verdict.start] : []));
}
