/**
 * The one rule for a work order's state. A work order is an item other items are
 * `part_of` through an active link; it is open while any member is open, and done once
 * every member has merged (a merge on record), ended (an end that holds, `readHoldingItemEnd`)
 * or is itself a work order that is done. A work order's own merge or end does not close it:
 * only its members do. The state is derived on every read from the
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

/**
 * The walk's shared state. Links are operator data and may form a cycle. A member's state
 * depends only on the member and the work orders above it on the walk, never on the order
 * links were recorded in, so nothing read on one path is reused on another.
 */
interface Walk {
  store: WorkOrderStore;
  /** The work orders being walked now; a member among them is in a cycle. */
  walking: Set<string>;
  /** Keyed by member and report, so an item reached by two paths is reported once. */
  degraded: Map<string, WorkOrderMemberUnreadable>;
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

/**
 * The work order `item` is, from its links; null when nothing is part of it. A member that
 * is already on the walk closes a cycle, which no fact resolves, so it reads `unknown`.
 */
async function walkWorkOrder(
  walk: Walk,
  item: WorkflowItem,
  links: readonly ItemLinkRead[]
): Promise<WorkOrder | null> {
  const found = membersOf(links, item.id);
  if (found.length === 0) return null;
  walk.walking.add(item.id);
  const members: WorkOrder['members'] = [];
  for (const member of found)
    members.push({
      item: member,
      state: walk.walking.has(member.id) ? 'unknown' : await memberState(walk, member),
    });
  walk.walking.delete(item.id);
  const unreadableLink = links.some(link => 'type' in link);
  return { state: stateOf(members, unreadableLink), members };
}

/**
 * A member's state. A member that is a work order itself has the state its own members
 * give it; its merge and end stay facts of its own and do not close it. Any other member
 * is merged, ended (an end that holds), or open. A link of the member that cannot be read
 * may be the `part_of` that makes it a work order, so the member then reads unknown. Every
 * fact of the member that cannot be read is reported, whichever of them decides its state.
 */
async function memberState(walk: Walk, member: WorkflowItem): Promise<WorkOrderMemberState> {
  const links = await walk.store.listItemLinks(member.id);
  const merge = await walk.store.getItemMerge(member.id);
  const end = await readHoldingItemEnd(walk.store, member.id);
  for (const read of [...links, merge, end])
    if (read !== null && 'type' in read)
      walk.degraded.set(`${member.id}:${JSON.stringify(read)}`, {
        type: 'degraded',
        reason: 'member_unreadable',
        member,
        report: read,
      });
  const own = await walkWorkOrder(walk, member, links);
  if (own !== null) return own.state;
  if (links.some(link => 'type' in link)) return 'unknown';
  if (merge !== null && !('type' in merge)) return 'merged';
  if (end !== null && !('type' in end)) return 'ended';
  // An unread merge or end may be the fact that closes the member.
  return merge !== null || end !== null ? 'unknown' : 'open';
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
  const walk: Walk = { store, walking: new Set(), degraded: new Map() };
  const workOrder = await walkWorkOrder(walk, item, links);
  return { workOrder, degraded: [...walk.degraded.values()] };
}
