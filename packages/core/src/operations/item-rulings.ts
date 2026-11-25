/**
 * Recording and withdrawing a ruling on an item, shared by the CLI and the API. The surface
 * resolves who acts; this checks what an answer's attribution is checked for and writes.
 */
import type { ItemRuling } from '@archon/workflows/schemas/item-ruling';
import type { RecordSurface } from '@archon/workflows/schemas/record-surface';
import type { IWorkflowStore } from '@archon/workflows/store';
import type { UserRole } from '../schemas/user';
import { itemAct } from './item-act';
import { authorizeRunAction, type RunActor } from './run-authorization';

type RulingStore = Pick<
  IWorkflowStore,
  'recordItemRuling' | 'withdrawItemRuling' | 'getWorkflowRun'
>;

/** Only the operator or an admin may record or withdraw a ruling, or end an item. */
export class ItemRulingForbiddenError extends Error {
  constructor() {
    super(
      'Only an admin can record or withdraw a ruling on an item, or end an item. An operator can grant admin with `archon user role <user-id> admin`.'
    );
    this.name = 'ItemRulingForbiddenError';
  }
}

/**
 * A ruling reaches every later run on the item, including runs other users started, so
 * the per-run "starter or admin" rule does not fit. A ruling has no starter: passing none
 * to the run rule leaves the operator and an admin.
 */
export function assertMayRule(actor: RunActor, role: UserRole | undefined): void {
  if (!authorizeRunAction(actor, null, role)) throw new ItemRulingForbiddenError();
}

export async function recordItemRuling(
  store: RulingStore,
  target: { projectKey: string; key: string; text: string },
  actor: RunActor,
  via: RecordSurface
): Promise<ItemRuling> {
  return store.recordItemRuling({ ...target, ...(await itemAct(store, actor, via)) });
}

/** `projectKey` scopes the withdrawal: a ruling on another project's item is refused. */
export async function withdrawItemRuling(
  store: RulingStore,
  target: { rulingId: string; projectKey?: string },
  actor: RunActor,
  via: RecordSurface
): Promise<ItemRuling> {
  return store.withdrawItemRuling({ ...target, ...(await itemAct(store, actor, via)) });
}
