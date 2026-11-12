import { createLogger } from '@archon/paths';
import {
  readAttentionFeed,
  type AttentionDelivery,
  type AttentionFeedStore,
} from './attention-feed';
import { WorkflowEventCursorError } from './store';
import { requestingRun } from './schemas/resource-start';

const deliveryIdentity = (delivery: AttentionDelivery): string =>
  delivery.kind === 'workflow'
    ? JSON.stringify(['workflow', delivery.event.workflow_run_id])
    : JSON.stringify([
        'admission',
        requestingRun(delivery.facts.sourceActor)?.runId ?? null,
        delivery.facts.codebaseId,
      ]);

export const attentionDeliveryFields = (delivery: AttentionDelivery) =>
  delivery.kind === 'workflow'
    ? {
        runId: delivery.event.workflow_run_id,
        eventId: delivery.event.id,
        cursor: delivery.cursor,
      }
    : { requestId: delivery.facts.requestId, cursor: delivery.cursor };

export async function hasReadableAttentionWitness(
  store: AttentionFeedStore,
  delivery: AttentionDelivery,
  project: (candidate: AttentionDelivery) => Promise<unknown>,
  isClosed: () => boolean
): Promise<boolean> {
  const probe = async (candidate: AttentionDelivery): Promise<boolean> => {
    try {
      // Probe current reads, not a cached success from before the failure.
      await project(candidate);
      return true;
    } catch (error) {
      if (error instanceof WorkflowEventCursorError) throw error;
      createLogger('workflow.attention_watch').debug(
        { err: error as Error, ...attentionDeliveryFields(candidate) },
        'workflow.attention_watch_probe_failed'
      );
      return false;
    }
  };
  let cursor = delivery.cursor;
  const probed = new Set([deliveryIdentity(delivery)]);
  while (!isClosed()) {
    const page = await readAttentionFeed(store, cursor, 100);
    if (isClosed() || page.deliveries.length === 0) return false;
    for (const candidate of page.deliveries) {
      if (isClosed()) return false;
      const identity = deliveryIdentity(candidate);
      if (probed.has(identity)) continue;
      probed.add(identity);
      if (await probe(candidate)) return !isClosed();
    }
    cursor = page.next;
  }
  return false;
}
