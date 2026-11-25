/**
 * The one rule for a work order's state. A work order is an item other items are
 * `part_of` through an active link; it is open while any member is open, and done once
 * every member has merged (a merge on record), ended (an end that holds, `readHoldingItemEnd`)
 * or is itself a work order that is done. The state is derived on every read from the
 * links, merges and ends the store already holds, so it cannot drift from its members:
 * nothing is written, no timer decides, and no stage ends a work order.
 */
import { readHoldingItemEnd, type ItemEndStore } from './item-end';
import type { ItemLink, ItemLinkRead } from './schemas/item-link';
import type {
  WorkOrder,
  WorkOrderMemberState,
  WorkOrderMemberUnreadable,
} from './schemas/work-order';
import type { WorkflowItem } from './schemas/workflow-run';
import type { IWorkflowStore } from './store';

type WorkOrderStore = ItemEndStore & Pick<IWorkflowStore, 'listItemLinks' | 'getItemMerge'>;

/** The walk's shared state: links are operator data and may form a cycle. */
interface Walk {
  store: WorkOrderStore;
  /** The work orders being walked now; a member among them is skipped, which ends a cycle. */
  walking: Set<string>;
  /** Members already read, listed again with the state they read first. */
  read: Map<string, WorkOrderMemberState>;
  degraded: WorkOrderMemberUnreadable[];
}

/** The items `itemId` is the `to` of through an active `part_of`. Mirrors `parentsOf`. */
function membersOf(links: readonly ItemLinkRead[], itemId: string): WorkflowItem[] {
  return links
    .filter(
      (link): link is ItemLink =>
        !('type' in link) && link.kind === 'part_of' && link.ended === null && link.to.id === itemId
    )
    .map(link => link.from);
}

/** A readable open member keeps it open; otherwise anything unread makes it unknown. */
function stateOf(
  members: readonly { state: WorkOrderMemberState }[],
  unreadable: boolean
): WorkOrder['state'] {
  if (members.some(member => member.state === 'open')) return 'open';
  if (unreadable || members.some(member => member.state === 'unknown')) return 'unknown';
  return 'done';
}

/** The work order `item` is, from its links; null when nothing is part of it. */
async function walkWorkOrder(
  walk: Walk,
  item: WorkflowItem,
  links: readonly ItemLinkRead[]
): Promise<WorkOrder | null> {
  const found = membersOf(links, item.id).filter(member => !walk.walking.has(member.id));
  if (found.length === 0) return null;
  walk.walking.add(item.id);
  const members: WorkOrder['members'] = [];
  for (const member of found)
    members.push({ item: member, state: await memberState(walk, member) });
  walk.walking.delete(item.id);
  const unreadableLink = links.some(link => 'type' in link);
  return { state: stateOf(members, unreadableLink), members };
}

/** A member's state, in order: its merge, its end that holds, its own members, else open. */
async function memberState(walk: Walk, member: WorkflowItem): Promise<WorkOrderMemberState> {
  const known = walk.read.get(member.id);
  if (known !== undefined) return known;
  const state = await readMemberState(walk, member);
  walk.read.set(member.id, state);
  return state;
}

async function readMemberState(walk: Walk, member: WorkflowItem): Promise<WorkOrderMemberState> {
  const unreadable = (report: WorkOrderMemberUnreadable['report']) =>
    walk.degraded.push({ type: 'degraded', reason: 'member_unreadable', member, report });
  const merge = await walk.store.getItemMerge(member.id);
  if (merge !== null && !('type' in merge)) return 'merged';
  if (merge !== null) unreadable(merge);
  const end = await readHoldingItemEnd(walk.store, member.id);
  if (end !== null && !('type' in end)) return 'ended';
  if (end !== null) unreadable(end);
  const links = await walk.store.listItemLinks(member.id);
  for (const link of links) if ('type' in link) unreadable(link);
  const own = await walkWorkOrder(walk, member, links);
  // An unread merge or end may be the fact that closes the member, so only a readable
  // open member of its own still says open.
  const unread = merge !== null || end !== null;
  if (own === null) return unread || links.some(link => 'type' in link) ? 'unknown' : 'open';
  if (own.state === 'open') return 'open';
  return unread ? 'unknown' : own.state;
}

/**
 * The work order `item` is, from `links`, the item's own links as the item read listed
 * them; `workOrder` is null when no active `part_of` points at it. Each part of a member
 * that could not be read is in `degraded`; the item's own unreadable links are the
 * caller's to report.
 */
export async function readWorkOrder(
  store: WorkOrderStore,
  item: WorkflowItem,
  links: readonly ItemLinkRead[]
): Promise<{ workOrder: WorkOrder | null; degraded: WorkOrderMemberUnreadable[] }> {
  const walk: Walk = { store, walking: new Set(), read: new Map(), degraded: [] };
  const workOrder = await walkWorkOrder(walk, item, links);
  return { workOrder, degraded: walk.degraded };
}
