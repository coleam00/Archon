import { describe, test, expect, mock, beforeEach } from 'bun:test';
import type { WorkflowEventRow } from '@archon/core/db/workflow-events';

// Mock the global events query the poller tails. Must be registered before the
// poller module is imported so its `listWorkflowEventsSince` binding is the mock.
const mockListSince = mock(
  (_after: Date, _limit: number): Promise<WorkflowEventRow[]> => Promise.resolve([])
);
mock.module('@archon/core/db/workflow-events', () => ({
  listWorkflowEventsSince: mockListSince,
}));

import { DashboardEventPoller } from './dashboard-event-poller';
import { mapWorkflowEventRow } from './workflow-bridge';

function row(over: Partial<WorkflowEventRow>): WorkflowEventRow {
  return {
    id: 'e1',
    workflow_run_id: 'r1',
    event_type: 'node_completed',
    step_index: null,
    step_name: 'build',
    data: {},
    created_at: new Date().toISOString(),
    ...over,
  };
}

interface FakeTransport {
  emitted: Array<{ conv: string; event: string }>;
  hasActiveStream: (id: string) => boolean;
  emitWorkflowEvent: (conv: string, event: string) => void;
}
function makeTransport(hasStream = true): FakeTransport {
  const emitted: Array<{ conv: string; event: string }> = [];
  return {
    emitted,
    hasActiveStream: () => hasStream,
    emitWorkflowEvent: (conv, event) => emitted.push({ conv, event }),
  };
}

describe('mapWorkflowEventRow', () => {
  test('workflow_started → workflow_status running', () => {
    const out = mapWorkflowEventRow(
      row({ event_type: 'workflow_started', data: { workflow_name: 'wf' } })
    );
    expect(out).not.toBeNull();
    expect(JSON.parse(out as string)).toMatchObject({
      type: 'workflow_status',
      runId: 'r1',
      status: 'running',
      workflowName: 'wf',
    });
  });

  test('node_completed → dag_node completed (keyed by step_name)', () => {
    const e = JSON.parse(
      mapWorkflowEventRow(row({ event_type: 'node_completed', step_name: 'build' })) as string
    );
    expect(e).toMatchObject({
      type: 'dag_node',
      runId: 'r1',
      nodeId: 'build',
      status: 'completed',
    });
  });

  test('step_started → dag_node running (drives the dock current step)', () => {
    const e = JSON.parse(
      mapWorkflowEventRow(row({ event_type: 'step_started', step_name: 'plan' })) as string
    );
    expect(e).toMatchObject({ type: 'dag_node', status: 'running', nodeId: 'plan' });
  });

  test('approval_requested → workflow_status paused with approval', () => {
    const e = JSON.parse(
      mapWorkflowEventRow(
        row({ event_type: 'approval_requested', step_name: 'gate', data: { message: 'ok?' } })
      ) as string
    );
    expect(e).toMatchObject({ type: 'workflow_status', runId: 'r1', status: 'paused' });
    expect(e.approval).toMatchObject({ nodeId: 'gate', message: 'ok?' });
  });

  test('high-frequency / internal events are skipped (null)', () => {
    expect(mapWorkflowEventRow(row({ event_type: 'tool_called' }))).toBeNull();
    expect(mapWorkflowEventRow(row({ event_type: 'tool_completed' }))).toBeNull();
    expect(mapWorkflowEventRow(row({ event_type: 'node_session_resumed' }))).toBeNull();
    expect(mapWorkflowEventRow(row({ event_type: 'workflow_artifact' }))).toBeNull();
  });
});

describe('DashboardEventPoller', () => {
  beforeEach(() => {
    mockListSince.mockReset();
    mockListSince.mockResolvedValue([]);
  });

  test('emits a mapped dashboard event for a new row', async () => {
    const t = makeTransport(true);
    mockListSince.mockResolvedValueOnce([
      row({ id: 'e1', workflow_run_id: 'r1', event_type: 'workflow_started' }),
    ]);
    const poller = new DashboardEventPoller();
    poller.start(t as never, 1e9);
    await poller.drainNow();
    poller.stop();

    expect(t.emitted).toHaveLength(1);
    expect(t.emitted[0].conv).toBe('__dashboard__');
    expect(JSON.parse(t.emitted[0].event).runId).toBe('r1');
  });

  test('does not re-emit a row already sent at the boundary second', async () => {
    const t = makeTransport(true);
    const r = row({ id: 'e1', workflow_run_id: 'r1', event_type: 'workflow_started' });
    const poller = new DashboardEventPoller();
    poller.start(t as never, 1e9);

    mockListSince.mockResolvedValueOnce([r]);
    await poller.drainNow(); // emits e1, boundary = {e1}
    mockListSince.mockResolvedValueOnce([r]); // same row returned (>= cursor)
    await poller.drainNow(); // e1 in boundary → skipped
    poller.stop();

    expect(t.emitted).toHaveLength(1);
  });

  test('skips the query and emits nothing when no dashboard client is connected', async () => {
    const t = makeTransport(false);
    mockListSince.mockResolvedValueOnce([row({ id: 'e1' })]);
    const poller = new DashboardEventPoller();
    poller.start(t as never, 1e9);

    await poller.drainNow();
    poller.stop();

    expect(t.emitted).toHaveLength(0);
    expect(mockListSince).not.toHaveBeenCalled();
  });
});
