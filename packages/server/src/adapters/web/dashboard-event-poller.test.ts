import { describe, test, expect, mock, beforeEach } from 'bun:test';
import type { WorkflowEventRow } from '@archon/core/db/workflow-events';

// Mock the global events query the poller tails. Must be registered before the
// poller module is imported so its `listWorkflowEventsSince` binding is the mock.
const mockListSince = mock(
  (_after: Date, _limit: number, _types?: readonly string[]): Promise<WorkflowEventRow[]> =>
    Promise.resolve([])
);
mock.module('@archon/core/db/workflow-events', () => ({
  listWorkflowEventsSince: mockListSince,
}));

import { DashboardEventPoller } from './dashboard-event-poller';
import type { DashboardTransport } from './dashboard-event-poller';
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

interface FakeTransport extends DashboardTransport {
  emitted: Array<{ conv: string; event: string }>;
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

  test('workflow_failed carries the error field', () => {
    const e = JSON.parse(
      mapWorkflowEventRow(
        row({ event_type: 'workflow_failed', data: { error: 'kaboom' } })
      ) as string
    );
    expect(e).toMatchObject({ type: 'workflow_status', status: 'failed', error: 'kaboom' });
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

  test('node_failed carries the error field', () => {
    const e = JSON.parse(
      mapWorkflowEventRow(
        row({ event_type: 'node_failed', step_name: 'build', data: { error: 'boom' } })
      ) as string
    );
    expect(e).toMatchObject({ type: 'dag_node', status: 'failed', error: 'boom' });
  });

  test('step_started → dag_node running (drives the dock current step)', () => {
    const e = JSON.parse(
      mapWorkflowEventRow(row({ event_type: 'step_started', step_name: 'plan' })) as string
    );
    expect(e).toMatchObject({ type: 'dag_node', status: 'running', nodeId: 'plan' });
  });

  test('loop_iteration_started → dag_node running', () => {
    const e = JSON.parse(
      mapWorkflowEventRow(
        row({ event_type: 'loop_iteration_started', step_name: 'impl' })
      ) as string
    );
    expect(e).toMatchObject({ type: 'dag_node', status: 'running' });
  });

  test('node_skipped_prior_success → dag_node skipped (hit on every resume)', () => {
    const e = JSON.parse(
      mapWorkflowEventRow(
        row({ event_type: 'node_skipped_prior_success', step_name: 'plan' })
      ) as string
    );
    expect(e).toMatchObject({ type: 'dag_node', status: 'skipped', nodeId: 'plan' });
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

  test('approval_received → workflow_status running (clears the paused banner)', () => {
    const e = JSON.parse(mapWorkflowEventRow(row({ event_type: 'approval_received' })) as string);
    expect(e).toMatchObject({ type: 'workflow_status', status: 'running' });
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
    poller.start(t, 1e9);
    await poller.drainNow();
    poller.stop();

    expect(t.emitted).toHaveLength(1);
    expect(t.emitted[0].conv).toBe('__dashboard__');
    expect(JSON.parse(t.emitted[0].event).runId).toBe('r1');
  });

  test('advances the cursor across seconds and only re-dedupes the newest second', async () => {
    const t = makeTransport(true);
    const poller = new DashboardEventPoller();
    poller.start(t, 1e9); // boot cursor = now

    // Use timestamps AFTER boot (real events are created after the server starts),
    // so maxTs advances. t2/t3 share the boundary second; t4 is a later second.
    const base = Date.now() + 10_000;
    const at = (sec: number): string => new Date(base + sec * 1000).toISOString();

    // Drain 1: events at two distinct seconds → cursor advances to the later one.
    mockListSince.mockResolvedValueOnce([
      row({ id: 'e1', event_type: 'workflow_started', created_at: at(1) }),
      row({ id: 'e2', event_type: 'node_completed', created_at: at(2) }),
    ]);
    await poller.drainNow(); // emits e1, e2; boundary = {e2}

    // Drain 2: e2 re-returned (boundary → skipped), a late same-second e3 (emitted),
    // and e4 at a new second (emitted).
    mockListSince.mockResolvedValueOnce([
      row({ id: 'e2', event_type: 'node_completed', created_at: at(2) }),
      row({ id: 'e3', event_type: 'node_started', created_at: at(2) }),
      row({ id: 'e4', event_type: 'workflow_completed', created_at: at(3) }),
    ]);
    await poller.drainNow();
    poller.stop();

    // e1, e2, e3, e4 each emitted exactly once — e2 not re-emitted.
    expect(t.emitted).toHaveLength(4);
  });

  test('coalesces a burst of drainNow calls into one trailing drain', async () => {
    const t = makeTransport(true);
    const poller = new DashboardEventPoller();
    poller.start(t, 1e9);

    let resolveFirst!: (rows: WorkflowEventRow[]) => void;
    mockListSince.mockImplementationOnce(
      () => new Promise<WorkflowEventRow[]>(res => (resolveFirst = res))
    );
    mockListSince.mockResolvedValue([]); // subsequent drains: nothing new

    const p1 = poller.drainNow(); // starts draining (listSince pending)
    const p2 = poller.drainNow(); // draining → redrainRequested
    const p3 = poller.drainNow(); // still draining → redrainRequested (no extra pass)
    resolveFirst([]); // first drainOnce completes → one coalesced follow-up runs
    await Promise.all([p1, p2, p3]);
    poller.stop();

    // drainOnce queried twice: the initial pass + ONE trailing pass (not three).
    expect(mockListSince).toHaveBeenCalledTimes(2);
  });

  test('skips the query and emits nothing when no dashboard client is connected', async () => {
    const t = makeTransport(false);
    mockListSince.mockResolvedValueOnce([row({ id: 'e1' })]);
    const poller = new DashboardEventPoller();
    poller.start(t, 1e9);

    await poller.drainNow();
    poller.stop();

    expect(t.emitted).toHaveLength(0);
    expect(mockListSince).not.toHaveBeenCalled();
  });
});
