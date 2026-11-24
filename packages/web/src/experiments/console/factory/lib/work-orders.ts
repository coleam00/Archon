/**
 * Work orders, as pure derivation: an item other items are `part_of`. Which order an item
 * belongs to comes from the engine's item links first and, only when it has no active
 * `part_of` link, from the work order its order run's result names (the view file's `partOf`).
 * An order is not work the factory does: one with no run of its own is no card, and only its
 * members count anywhere. Read-only; nothing here records or ends a link.
 */
import type { FactoryItem } from '../../skills/factory';
import { displayItemKey } from './item-key';
import type { BoardModel, Pill, PlacedCard } from './board';
import { UNPLACED_LABEL } from './placement';
import { SET_ASIDE_LABEL } from './set-aside';

type ItemLink = FactoryItem['links'][number];

/** What membership reads: the engine's item read, with the board's progress when a view applies. */
export type MemberSource = Pick<FactoryItem, 'item' | 'links'> & {
  progress?: FactoryItem['progress'];
};

/** The item's active outgoing `part_of` links, in recording order. */
function activeOrderLinks(item: MemberSource): ItemLink[] {
  return item.links.filter(
    link => link.kind === 'part_of' && link.direction === 'outgoing' && link.ended === null
  );
}

/** The work order an item belongs to, and where that was read. */
export interface Membership {
  order: string;
  source: 'link' | 'output';
}

/**
 * The item's work order: its newest active `part_of` link, else the order its latest
 * completed order run named; null when neither names one. A link wins over a disagreeing
 * result, since links are the engine's record and a result only proposes. An item naming
 * itself is in no order.
 */
export function membershipOf(item: MemberSource): Membership | null {
  // `links` is in recording order; with two active, the one recorded last is the newer word.
  const link = activeOrderLinks(item).at(-1);
  if (link !== undefined) return { order: link.other.key, source: 'link' };
  const named = item.progress?.partOf;
  if (named == null || named === item.item.key) return null;
  return { order: named, source: 'output' };
}

/** How a person reads the item's key: as a member of its work order when it is in one. */
export function displayKeyOf(item: MemberSource): string {
  return displayItemKey(item.item.key, membershipOf(item)?.order ?? null);
}

interface WorkOrderMember {
  key: string;
  title: string;
  pill: Pill;
  /** The pill's words when its card names them (an `awaits` label); else the pill's own. */
  pillLabel?: string;
  landed: boolean;
  /** The column or ending the member sits in; `NOT_STARTED` for a member with no run yet. */
  where: string;
}

export interface WorkOrder {
  key: string;
  /** The order's own title when it has runs (it is on the board), else its key as a person reads it. */
  title: string;
  /** Board members newest activity first, then members with no run yet. */
  members: WorkOrderMember[];
  landed: number;
}

/** What a member that has no run yet shows: it waits, in no column. */
export const NOT_STARTED = 'Not started';

/** What a person reads for an order with no title of its own: "Work order #48". */
export function orderTitle(key: string): string {
  return `Work order ${displayItemKey(key, null)}`;
}

/**
 * Every work order with at least one member, ordered by its newest member's activity.
 * `items` are the board's items, newest activity first; `model` is the board they make
 * (unfiltered, so a filter never changes an order's count); `members` is the items read's
 * map of each read order key to the keys linked to it, which also counts members with no run.
 * A member with no run is read only from that map, so it counts under every order it has an
 * active link to; a member on the board counts under its one `membershipOf` order.
 */
export function workOrders(
  items: readonly FactoryItem[],
  model: BoardModel,
  members: Readonly<Record<string, readonly string[]>>
): WorkOrder[] {
  const placed = placedByKey(model);
  const grouped = new Map<string, WorkOrderMember[]>();
  const add = (order: string, member: WorkOrderMember): void => {
    grouped.set(order, [...(grouped.get(order) ?? []), member]);
  };
  for (const item of items) {
    const membership = membershipOf(item);
    const where = placed.get(item.item.key);
    if (membership !== null && where !== undefined) add(membership.order, onBoard(where));
  }
  for (const [order, keys] of Object.entries(members))
    for (const key of keys)
      if (!placed.has(key))
        add(order, {
          key,
          title: displayItemKey(key, order),
          pill: 'waiting',
          landed: false,
          where: NOT_STARTED,
        });
  return [...grouped].map(([key, list]) => ({
    key,
    title: placed.get(key)?.placed.item.progress?.title ?? orderTitle(key),
    members: list,
    landed: list.filter(member => member.landed).length,
  }));
}

interface Where {
  placed: PlacedCard;
  label: string;
  landed: boolean;
}

/** Every card on the board, unfiltered, with the stage it sits in or why it is not in one. */
function placedByKey(model: BoardModel): Map<string, Where> {
  const placed = new Map<string, Where>();
  for (const column of model.columns)
    for (const card of column.cards) {
      // Named by its stage, not its column: a member page says where it is, as precisely as
      // the item page does.
      const stage = card.column !== null && 'stage' in card.column ? card.column.stage : null;
      placed.set(card.card.key, {
        placed: card,
        label: stage?.label ?? column.label,
        landed: stage?.id === model.landedStage,
      });
    }
  // A member the board set aside still resolves, named by why: its ending or parked label.
  for (const entry of model.setAside)
    placed.set(entry.placed.card.key, {
      placed: entry.placed,
      label: entry.kind === 'idle' ? SET_ASIDE_LABEL : entry.why,
      landed: false,
    });
  for (const card of model.unplaced)
    placed.set(card.card.key, { placed: card, label: UNPLACED_LABEL, landed: false });
  return placed;
}

function onBoard({ placed, label, landed }: Where): WorkOrderMember {
  const { card } = placed;
  return {
    key: card.key,
    title: card.title,
    pill: card.pill,
    pillLabel: card.pillLabel,
    landed,
    where: label,
  };
}

/** The keys a highlighted order lights on the board: its members and the order itself. */
export function highlightedKeys(order: WorkOrder | undefined): ReadonlySet<string> | null {
  if (order === undefined) return null;
  return new Set([order.key, ...order.members.map(member => member.key)]);
}

/** `?order=<key>` lights one work order's members on the board and dims the rest. */
export const ORDER_PARAM = 'order';

/** The search a link sets to light `order`, keeping the board's other params (view, show). */
export function orderSearch(params: URLSearchParams, order: string | null): string {
  const updated = new URLSearchParams(params);
  if (order === null) updated.delete(ORDER_PARAM);
  else updated.set(ORDER_PARAM, order);
  const search = updated.toString();
  return search === '' ? '' : `?${search}`;
}
