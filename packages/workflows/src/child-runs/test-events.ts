import type { WorkflowEventRow } from '../schemas/workflow-event';
import type { WorkflowEventType } from '../store';
import type { InMemoryStoreEvent } from '../test-utils';

export function readEventsForRuns(
  events: readonly InMemoryStoreEvent[],
  runIds: readonly string[],
  eventTypes: readonly WorkflowEventType[]
): Map<string, WorkflowEventRow[]> {
  const types = new Set<string>(eventTypes);
  return new Map(
    runIds.map(runId => [
      runId,
      events.flatMap((event, index) =>
        event.workflow_run_id === runId && types.has(event.event_type)
          ? [
              {
                ...event,
                id: String(index),
                step_index: null,
                step_name: event.step_name ?? null,
                data: event.data ?? {},
                created_at: new Date(0).toISOString(),
                event_order: index,
              },
            ]
          : []
      ),
    ])
  );
}
