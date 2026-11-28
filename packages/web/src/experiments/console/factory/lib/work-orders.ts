/**
 * The project's work orders: each item others are `part_of`, with its members. Read from the
 * item links both ways; whether an order is resolved is its own read's `standing` (an order
 * stands `done` once every part is), never counted again here.
 */
import { getItem, ITEM_STATES, listItems, type ItemRead } from '../../skills/items';
import { isMoving } from '../../routes/board/standing';

/** The work order an item is part of: the item its active `part_of` link points at. */
export function orderOf(read: ItemRead): ItemRead['item'] | undefined {
  return read.links.find(
    link => link.kind === 'part_of' && link.direction === 'outgoing' && link.ended === null
  )?.other;
}

/** A member of a work order, with its read when it has a run (the window lists only those). */
export interface Member {
  item: ItemRead['item'];
  read: ItemRead | undefined;
}

export interface WorkOrder {
  item: ItemRead['item'];
  /** The order's own read, when it is among the items read. */
  read: ItemRead | undefined;
  members: Member[];
}

/** Whether a link joins a member to its work order, now. */
const activePartOf = (link: ItemRead['links'][number]): boolean =>
  link.kind === 'part_of' && link.ended === null;

const isOpenMember = (member: Member): boolean =>
  member.read !== undefined && isMoving(member.read);

/**
 * Every work order with a member: each item others are `part_of`, with those members, open
 * ones first, then by their newest member. Membership is read from both ends of each link:
 * a member's own read, and the order's read, which also names members with no run yet. An
 * order's title is its own read's when that is among `items`. `items` come most recently
 * active first, as the item read pages them.
 */
export function workOrders(items: readonly ItemRead[]): WorkOrder[] {
  const reads = new Map(items.map(read => [read.item.id, read]));
  const orders = new Map<string, { item: ItemRead['item']; members: Map<string, Member> }>();
  const join = (order: ItemRead['item'], member: ItemRead['item']): void => {
    const entry = orders.get(order.id) ?? {
      item: reads.get(order.id)?.item ?? order,
      members: new Map<string, Member>(),
    };
    entry.members.set(member.id, { item: member, read: reads.get(member.id) });
    orders.set(order.id, entry);
  };
  for (const read of items) {
    const order = orderOf(read);
    if (order !== undefined) join(order, read.item);
  }
  for (const read of items)
    for (const link of read.links)
      if (activePartOf(link) && link.direction === 'incoming') join(read.item, link.other);
  const listed = [...orders.entries()].map(([id, { item, members }]) => ({
    item,
    read: reads.get(id),
    members: [...members.values()],
  }));
  const open = (order: WorkOrder): boolean => order.members.some(isOpenMember);
  // Stable, so orders keep their newest member's order within open and the rest.
  return listed.sort((a, b) => Number(open(b)) - Number(open(a)));
}

export interface OrderSummary {
  merged: number;
  total: number;
  /** Members with no run, so no read. */
  unstarted: number;
  /** The order's own read stands `done`: every part is done. */
  resolved: boolean;
}

export function orderSummary(order: WorkOrder): OrderSummary {
  const { members } = order;
  return {
    merged: members.filter(({ read }) => read != null && read.merged !== null).length,
    total: members.length,
    unstarted: members.filter(({ read }) => read === undefined).length,
    resolved: order.read?.standing.state === 'done',
  };
}

/**
 * Every item of a project, and the read of each work order among their links that has no
 * run of its own, so the window does not list it: its links name the members with no run.
 * The Board and the Overview both read this, under `K.boardOrders`.
 */
export async function listOrderItems(projectId: string): Promise<ItemRead[]> {
  const items = await listItems(projectId, ITEM_STATES);
  const read = new Set(items.map(item => item.item.id));
  const missing = new Map(
    items.flatMap(item => {
      const order = orderOf(item);
      return order === undefined || read.has(order.id) ? [] : [[order.id, order.key] as const];
    })
  );
  const orders = await Promise.all([...missing.values()].map(key => getItem(projectId, key)));
  return [...items, ...orders];
}
