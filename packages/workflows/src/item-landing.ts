/**
 * Where an item's change lands: the branch the item records, else the branch of the
 * nearest item it is `part_of`, so a work order's members land where the work order lands.
 * Every reader (a start, the item read) resolves through here, so they cannot disagree.
 */
import type { ResolvedItemLanding } from './schemas/item-landing';
import type { WorkflowItem } from './schemas/workflow-run';
import type { IWorkflowStore } from './store';

/** The landing branch cannot be told: a row on the way does not read, or two parents disagree. */
export class ItemLandingUnresolvedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ItemLandingUnresolvedError';
  }
}

type LandingStore = Pick<IWorkflowStore, 'getItemLanding' | 'listItemLinks'>;

async function recordedBranch(store: LandingStore, item: WorkflowItem): Promise<string | null> {
  const landing = await store.getItemLanding(item.id);
  if (landing === null) return null;
  if ('type' in landing)
    throw new ItemLandingUnresolvedError(
      `The landing branch recorded on item '${item.key}' could not be read.`
    );
  return landing.branch;
}

/** The items `item` is part of through an active link. */
async function parentsOf(store: LandingStore, item: WorkflowItem): Promise<WorkflowItem[]> {
  const parents: WorkflowItem[] = [];
  for (const link of await store.listItemLinks(item.id)) {
    // An unreadable link may be the `part_of` that names the branch; guessing past it
    // would cut the run from the wrong base.
    if ('type' in link)
      throw new ItemLandingUnresolvedError(
        `Link '${link.linkId}' of item '${item.key}' could not be read, so where the item lands is unknown.`
      );
    if (link.kind === 'part_of' && link.ended === null && link.from.id === item.id)
      parents.push(link.to);
  }
  return parents;
}

/**
 * The branch a run on `item` lands on, and where it came from; null when neither the item
 * nor anything it is part of records one. The nearest depth that records a branch decides:
 * two items there with different branches throw, since picking one would be a guess.
 * Links are operator data and may form a cycle; each item is visited once.
 */
export async function resolveItemLanding(
  store: LandingStore,
  item: WorkflowItem
): Promise<ResolvedItemLanding | null> {
  const own = await recordedBranch(store, item);
  if (own !== null) return { branch: own, from: { kind: 'own' } };
  const visited = new Set([item.id]);
  let frontier = await nextDepth(store, [item], visited);
  while (frontier.length > 0) {
    const landing = await landingAtDepth(store, item, frontier);
    if (landing !== null) return landing;
    frontier = await nextDepth(store, frontier, visited);
  }
  return null;
}

/** The items the frontier is part of that the walk has not visited, marked visited. */
async function nextDepth(
  store: LandingStore,
  frontier: readonly WorkflowItem[],
  visited: Set<string>
): Promise<WorkflowItem[]> {
  const next: WorkflowItem[] = [];
  for (const child of frontier)
    for (const parent of await parentsOf(store, child)) {
      if (visited.has(parent.id)) continue;
      visited.add(parent.id);
      next.push(parent);
    }
  return next;
}

/** The one branch the items at this depth record, null when none does; two different ones throw. */
async function landingAtDepth(
  store: LandingStore,
  item: WorkflowItem,
  depth: readonly WorkflowItem[]
): Promise<ResolvedItemLanding | null> {
  const found: { item: WorkflowItem; branch: string }[] = [];
  for (const parent of depth) {
    const branch = await recordedBranch(store, parent);
    if (branch !== null) found.push({ item: parent, branch });
  }
  const [first] = found;
  if (first === undefined) return null;
  const other = found.find(entry => entry.branch !== first.branch);
  if (other !== undefined)
    throw new ItemLandingUnresolvedError(
      `Item '${item.key}' is part of '${first.item.key}', which lands on '${first.branch}', and of '${other.item.key}', which lands on '${other.branch}'. Record the branch on '${item.key}' itself with 'archon workflow landing'.`
    );
  return { branch: first.branch, from: { kind: 'part_of', item: first.item } };
}

/** How a reader names where the branch came from: `own`, or `part_of <key>`. */
export function landingSourceText(landing: ResolvedItemLanding): string {
  return landing.from.kind === 'own' ? 'own' : `part_of ${landing.from.item.key}`;
}
