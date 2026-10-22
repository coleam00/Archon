import type { WorkflowEventRow } from '../schemas/workflow-event';
import type { WorkflowEventType } from '../store';
import { inMemoryEventRows, type InMemoryStoreEvent } from '../test-utils';

export function readEventsForRuns(
  events: readonly InMemoryStoreEvent[],
  runIds: readonly string[],
  eventTypes: readonly WorkflowEventType[]
): Map<string, WorkflowEventRow[]> {
  const types = new Set<string>(eventTypes);
  const rows = inMemoryEventRows(events);
  return new Map(
    runIds.map(runId => [
      runId,
      rows.filter(event => event.workflow_run_id === runId && types.has(event.event_type)),
    ])
  );
}
