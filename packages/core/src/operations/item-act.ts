/** Resolving who acts on an item, shared by rulings, links and answers to asks. */
import type { ItemAct } from '@archon/workflows/schemas/item-act';
import type { RecordSurface } from '@archon/workflows/schemas/record-surface';
import { attentionAnswererSchema } from '@archon/workflows/schemas/workflow-run';
import type { IWorkflowStore } from '@archon/workflows/store';
import { answererOf, type RunActor } from './run-authorization';

/** Checks what an answer's attribution is checked for: the declared name and the run named. */
export async function itemAct(
  store: Pick<IWorkflowStore, 'getWorkflowRun'>,
  actor: RunActor,
  via: RecordSurface
): Promise<ItemAct> {
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
