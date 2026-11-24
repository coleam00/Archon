/**
 * Recording and ending a link between items. The CLI acts as the operator, who always may,
 * so no authorization step is taken here; a surface that serves other users adds one.
 */
import type { ItemLink, ItemLinkKind } from '@archon/workflows/schemas/item-link';
import type { RecordSurface } from '@archon/workflows/schemas/record-surface';
import type { IWorkflowStore } from '@archon/workflows/store';
import { itemAct } from './item-act';
import type { RunActor } from './run-authorization';

type LinkStore = Pick<IWorkflowStore, 'recordItemLink' | 'endItemLink' | 'getWorkflowRun'>;

export async function recordItemLink(
  store: LinkStore,
  target: { projectKey: string; fromKey: string; toKey: string; kind: ItemLinkKind },
  actor: RunActor,
  via: RecordSurface
): Promise<{ link: ItemLink; created: boolean }> {
  return store.recordItemLink({ ...target, ...(await itemAct(store, actor, via)) });
}

/** `projectKey` scopes the end: a link from another project's item is refused. */
export async function endItemLink(
  store: LinkStore,
  target: { linkId: string; projectKey?: string },
  actor: RunActor,
  via: RecordSurface
): Promise<ItemLink> {
  return store.endItemLink({ ...target, ...(await itemAct(store, actor, via)) });
}
