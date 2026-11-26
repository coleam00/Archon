/**
 * What an item depends on. An active outgoing `depends_on` to an item that is open (by the
 * work-order rule, `readItemState`) means the item waits inside Archon: the stop list leaves
 * a quiet stop of its last step out while that holds (`stoppedItems`), and the item read
 * reports it (`dependsOn`). Once the blocker is merged, ended or done, or the link is ended,
 * the stop shows again. Nothing is stored and no timer runs.
 */
import { z } from 'zod';
import type { ItemLink, ItemLinkRead } from './schemas/item-link';
import { workOrderMemberStateSchema } from './schemas/work-order';
import { workflowItemSchema, type WorkflowItem } from './schemas/workflow-run';
import { readItemState, type WorkOrderStore } from './work-order';

/**
 * An item this one depends on through an active `depends_on`, with its state by the
 * work-order member rule (`readItemState`). While one is `open`, the item waits on it, and a
 * completed stop of its last step is not listed in attention.
 */
export const itemDependencySchema = z.object({
  item: workflowItemSchema,
  state: workOrderMemberStateSchema,
});
export type ItemDependency = z.infer<typeof itemDependencySchema>;

/** The items `itemId` depends on through an active `depends_on` in `links`, in link order. */
export async function readDependsOn(
  store: WorkOrderStore,
  itemId: string,
  links: readonly ItemLinkRead[]
): Promise<ItemDependency[]> {
  const blockers = links
    .filter(
      (link): link is ItemLink =>
        !('type' in link) &&
        link.kind === 'depends_on' &&
        link.ended === null &&
        link.from.id === itemId
    )
    .map(link => link.to);
  const deps: ItemDependency[] = [];
  for (const item of blockers) deps.push({ item, state: await readItemState(store, item) });
  return deps;
}

/**
 * The dependencies the item waits on: only an `open` one. An `unknown` one does not count,
 * so a blocker that cannot be read leaves a stop visible.
 */
export function waitsOn(deps: readonly ItemDependency[]): WorkflowItem[] {
  return deps.filter(dep => dep.state === 'open').map(dep => dep.item);
}
