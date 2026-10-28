import type { WorkflowEventRow } from '../schemas/workflow-event';
import type { WorkflowEventType } from './event-types';

declare const workflowEventCursorBrand: unique symbol;
/** A durable commit position. Only the issuing store interprets its contents. */
export type WorkflowEventCursor = string & { readonly [workflowEventCursorBrand]: true };

/**
 * A cursor a host received as text, such as `--after`. Branding decides nothing: only the
 * issuing store judges it, on read, with `WorkflowEventCursorError`.
 */
export function workflowEventCursor(text: string): WorkflowEventCursor {
  return text as WorkflowEventCursor;
}

export class WorkflowEventCursorError extends Error {
  constructor() {
    super('Invalid or foreign workflow event cursor');
    this.name = 'WorkflowEventCursorError';
  }
}

export interface WorkflowEventPage {
  events: readonly { cursor: WorkflowEventCursor; event: WorkflowEventRow }[];
  /** Advances past scanned rows, including rows excluded by eventTypes. */
  next: WorkflowEventCursor;
}

/** Live log across all runs. Retractions do not undo deliveries; run reads own current state. */
export interface IWorkflowEventFeed {
  getWorkflowEventHead(): Promise<WorkflowEventCursor>;
  /** Every committed event after this cursor appears in this page or a later one. */
  readWorkflowEventsAfter(
    after: WorkflowEventCursor,
    options: { limit: number; eventTypes?: readonly WorkflowEventType[] }
  ): Promise<WorkflowEventPage>;
}
