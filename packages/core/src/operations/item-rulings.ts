/**
 * Recording and withdrawing a ruling on an item, shared by the CLI and the API. The surface
 * resolves who acts; this checks what an answer's attribution is checked for and writes.
 */
import type { ItemRuling, ItemRulingAct } from '@archon/workflows/schemas/item-ruling';
import type { RecordSurface } from '@archon/workflows/schemas/record-surface';
import { attentionAnswererSchema } from '@archon/workflows/schemas/workflow-run';
import type { IWorkflowStore } from '@archon/workflows/store';
import type { UserRole } from '../schemas/user';
import { answererOf, authorizeRunAction, type RunActor } from './run-authorization';

type RulingStore = Pick<
  IWorkflowStore,
  'recordItemRuling' | 'withdrawItemRuling' | 'getWorkflowRun'
>;

/** Only the operator or an admin may record or withdraw a ruling. */
export class ItemRulingForbiddenError extends Error {
  constructor() {
    super(
      'Only an admin can record or withdraw a ruling on an item. An operator can grant admin with `archon user role <user-id> admin`.'
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

/**
 * Who acts on an item, as a ruling or an ask's answer records it: the declared name or
 * user, checked as an answer's attribution is, and the run the call came from, which
 * must be one this store knows.
 */
export async function itemAct(
  store: Pick<IWorkflowStore, 'getWorkflowRun'>,
  actor: RunActor,
  via: RecordSurface
): Promise<ItemRulingAct> {
  const by = answererOf(actor) ?? null;
  if (by !== null && !attentionAnswererSchema.safeParse(by).success)
    throw new Error('The declared name must be 1 to 64 characters on one line.');
  const fromRun = actor.kind === 'operator' ? (actor.fromRun ?? null) : null;
  if (fromRun !== null && (await store.getWorkflowRun(fromRun.runId)) === null)
    throw new Error(
      `The call comes from inside run ${fromRun.runId}, which this store does not know.`
    );
  return { via, by, fromRun };
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
