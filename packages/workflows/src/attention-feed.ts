import { z } from 'zod';
import {
  admissionNoticeCursor,
  type AdmissionNoticeCursor,
  type AdmissionNoticeFacts,
} from './admission-notice';
import {
  workflowEventCursor,
  WorkflowEventCursorError,
  type IWorkflowStore,
  type WorkflowEventCursor,
} from './store';
import type { WorkflowRunDelivery } from './engine-port';
import type { FeedPage } from './run-subscription';

declare const attentionCursorBrand: unique symbol;
export interface AttentionCursorBrand {
  readonly [attentionCursorBrand]: true;
}
export type AttentionCursor = WorkflowEventCursor | (string & AttentionCursorBrand);

/** Hosts pass opaque text; the feed validates both coordinates before starting. */
export function attentionCursor(text: string): AttentionCursor {
  return text as AttentionCursor;
}

const PREFIX = 'attention:v1:';
const coordinatesSchema = z.tuple([z.string().min(1), z.string().min(1)]);

export function attentionCoordinates(cursor: AttentionCursor): {
  workflow: WorkflowEventCursor;
  admission: AdmissionNoticeCursor;
} {
  try {
    const [workflow, admission] = coordinatesSchema.parse(JSON.parse(cursor.slice(PREFIX.length)));
    if (!cursor.startsWith(PREFIX)) throw new WorkflowEventCursorError();
    return { workflow: workflowEventCursor(workflow), admission: admissionNoticeCursor(admission) };
  } catch {
    throw new WorkflowEventCursorError();
  }
}

function encode(workflow: WorkflowEventCursor, admission: AdmissionNoticeCursor): AttentionCursor {
  return attentionCursor(PREFIX + JSON.stringify([workflow, admission]));
}

export type AttentionFeedStore = Pick<
  IWorkflowStore,
  | 'getWorkflowEventHead'
  | 'readWorkflowEventsAfter'
  | 'getAdmissionNoticeHead'
  | 'readAdmissionNoticesAfter'
>;

export type AttentionWorkflowDelivery = Omit<WorkflowRunDelivery, 'cursor'> & {
  kind: 'workflow';
  cursor: AttentionCursor;
  workflowCursor: WorkflowEventCursor;
};
export type AttentionDelivery =
  | AttentionWorkflowDelivery
  | {
      kind: 'admission';
      cursor: AttentionCursor;
      facts: AdmissionNoticeFacts;
    };
export type AttentionFeedPage = FeedPage<AttentionCursor, AttentionDelivery>;

export async function attentionFeedStart(
  store: AttentionFeedStore,
  after?: AttentionCursor
): Promise<AttentionCursor> {
  if (after?.startsWith('attention:')) {
    const { workflow, admission } = attentionCoordinates(after);
    await store.readWorkflowEventsAfter(workflow, { limit: 1 });
    await store.readAdmissionNoticesAfter(admission, { limit: 1 });
    return after;
  }
  const workflow =
    after === undefined ? await store.getWorkflowEventHead() : workflowEventCursor(after);
  if (after !== undefined) await store.readWorkflowEventsAfter(workflow, { limit: 1 });
  return encode(workflow, await store.getAdmissionNoticeHead());
}

/** Bounded pages from both sources preserve source order without claiming a cross-source order. */
export async function readAttentionFeed(
  store: AttentionFeedStore,
  after: AttentionCursor,
  limit: number
): Promise<AttentionFeedPage> {
  let { workflow, admission } = attentionCoordinates(after);
  const events = await store.readWorkflowEventsAfter(workflow, { limit });
  const notices = await store.readAdmissionNoticesAfter(admission, { limit });
  const deliveries: AttentionDelivery[] = [];
  for (const row of events.events) {
    workflow = row.cursor;
    deliveries.push({
      kind: 'workflow',
      event: row.event,
      workflowCursor: workflow,
      cursor: encode(workflow, admission),
    });
  }
  workflow = events.next;
  for (const row of notices.notices) {
    admission = row.cursor;
    deliveries.push({ kind: 'admission', facts: row.facts, cursor: encode(workflow, admission) });
  }
  return {
    deliveries,
    next: encode(events.next, notices.next),
    caughtUp: events.events.length < limit && notices.caughtUp,
  };
}
