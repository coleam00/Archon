import { describe, test, expect, mock, beforeEach, spyOn } from 'bun:test';
import { TERMINAL_RUN_EVENT_TYPE } from '@archon/workflows/schemas/workflow-run';
import type { WorkflowEventRow } from '@archon/workflows/schemas/workflow-event';
import {
  WORKFLOW_EVENT_TYPES,
  type WorkflowEventCursor,
  type WorkflowEventPage,
} from '@archon/workflows/store';

const mockLog = {
  error: mock((_obj: object, _msg: string) => undefined),
  warn: mock((_obj: object, _msg: string) => undefined),
  info: mock((_obj: object, _msg: string) => undefined),
};
const realPaths = await import('@archon/paths');
mock.module('@archon/paths', () => ({ ...realPaths, createLogger: () => mockLog }));

const { DashboardEventPoller } = await import('./dashboard-event-poller');
const { DASHBOARD_SOURCE_EVENT_TYPES, mapWorkflowEventRow } = await import('./workflow-bridge');
import type { DashboardEventFeed, DashboardTransport } from './dashboard-event-poller';

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
  open: boolean;
}
function makeTransport(open = true): FakeTransport {
  const transport: FakeTransport = {
    emitted: [],
    open,
    hasActiveStream: () => transport.open,
    emitWorkflowEvent: (conv, event) => transport.emitted.push({ conv, event }),
  };
  return transport;
}

const cursorAt = (order: number): WorkflowEventCursor =>
  `test:${String(order)}` as WorkflowEventCursor;
const orderOf = (cursor: WorkflowEventCursor): number => Number(cursor.slice('test:'.length));

/**
 * An in-memory commit-ordered feed with the SQL store's paging contract: a page
 * scans `limit` rows, filters by type afterwards, and `next` covers every scanned row.
 */
function makeFeed(): DashboardEventFeed & {
  rows: WorkflowEventRow[];
  write(...rows: WorkflowEventRow[]): void;
  reads: number;
  requestedTypes: unknown[];
} {
  const feed = {
    rows: [] as WorkflowEventRow[],
    reads: 0,
    requestedTypes: [] as unknown[],
    write(...rows: WorkflowEventRow[]): void {
      feed.rows.push(...rows);
    },
    getWorkflowEventHead: async (): Promise<WorkflowEventCursor> => cursorAt(feed.rows.length),
    readWorkflowEventsAfter: async (
      after: WorkflowEventCursor,
      { limit, eventTypes }: Parameters<DashboardEventFeed['readWorkflowEventsAfter']>[1]
    ): Promise<WorkflowEventPage> => {
      feed.reads += 1;
      feed.requestedTypes.push(eventTypes);
      const from = orderOf(after);
      const scanned = feed.rows.slice(from, from + limit).map((event, i) => ({
        cursor: cursorAt(from + i + 1),
        event,
      }));
      return {
        events: scanned.filter(
          ({ event }) => eventTypes === undefined || eventTypes.some(t => t === event.event_type)
        ),
        next: scanned.at(-1)?.cursor ?? after,
      };
    },
  };
  return feed;
}

const emittedIds = (t: FakeTransport): string[] =>
  t.emitted.map(({ event }) => (JSON.parse(event) as { runId: string }).runId);

describe('mapWorkflowEventRow', () => {
  test('retains replay frame bytes for workflow, approval, and node events', () => {
    const clock = spyOn(Date, 'now').mockReturnValue(1000);
    const cases: [Partial<WorkflowEventRow>, string][] = [
      [
        { event_type: 'workflow_failed', data: { workflowName: 'build', error: 'oops' } },
        '{"type":"workflow_status","runId":"r1","workflowName":"build","status":"failed","error":"oops","timestamp":1000}',
      ],
      [
        {
          event_type: 'approval_requested',
          step_name: null,
          data: { node_id: 'gate', message: 'Choose' },
        },
        '{"type":"workflow_status","runId":"r1","workflowName":"","status":"paused","timestamp":1000,"approval":{"nodeId":"gate","message":"Choose"}}',
      ],
      [
        { event_type: 'approval_received' },
        '{"type":"workflow_status","runId":"r1","workflowName":"","status":"running","timestamp":1000}',
      ],
      [
        {
          event_type: 'node_skipped',
          data: { reason: 'trigger_rule', cause: { kind: 'upstream_failed', origin: 'check' } },
        },
        '{"type":"dag_node","runId":"r1","nodeId":"build","name":"build","status":"skipped","reason":"trigger_rule","cause":{"kind":"upstream_failed","origin":"check"},"timestamp":1000}',
      ],
    ];
    try {
      for (const [input, expected] of cases) expect(mapWorkflowEventRow(row(input))).toBe(expected);
    } finally {
      clock.mockRestore();
    }
  });

  test.each(Object.entries(TERMINAL_RUN_EVENT_TYPE))(
    'polls and projects the terminal status %s',
    (status, eventType) => {
      expect(WORKFLOW_EVENT_TYPES).toContain(eventType);
      expect(DASHBOARD_SOURCE_EVENT_TYPES).toContain(eventType);
      const mapped = mapWorkflowEventRow(row({ event_type: eventType }));
      expect(JSON.parse(mapped ?? '{}')).toMatchObject({ type: 'workflow_status', status });
    }
  );

  test.each([...WORKFLOW_EVENT_TYPES])(
    'source membership matches row mapping for %s',
    eventType => {
      expect(DASHBOARD_SOURCE_EVENT_TYPES.includes(eventType)).toBe(
        mapWorkflowEventRow(row({ event_type: eventType })) !== null
      );
    }
  );

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

  test('node_skipped carries its persisted reason and validated cause', () => {
    const e = JSON.parse(
      mapWorkflowEventRow(
        row({
          event_type: 'node_skipped',
          step_name: 'publish',
          data: {
            reason: 'trigger_rule',
            cause: { kind: 'upstream_failed', origin: 'validate' },
          },
        })
      ) as string
    );
    expect(e).toMatchObject({
      type: 'dag_node',
      status: 'skipped',
      reason: 'trigger_rule',
      cause: { kind: 'upstream_failed', origin: 'validate' },
    });
  });

  test('node_skipped carries a timeout reason and cause', () => {
    const e = JSON.parse(
      mapWorkflowEventRow(
        row({
          event_type: 'node_skipped',
          step_name: 'ci-note',
          data: { reason: 'timeout', cause: { kind: 'timeout' } },
        })
      ) as string
    );
    expect(e).toMatchObject({
      type: 'dag_node',
      status: 'skipped',
      reason: 'timeout',
      cause: { kind: 'timeout' },
    });
  });

  test('omits a cause for legacy, malformed, and prior-success skip rows', () => {
    const rows = [
      row({ event_type: 'node_skipped', data: { reason: 'trigger_rule' } }),
      row({
        event_type: 'node_skipped',
        data: { reason: 'trigger_rule', cause: { kind: 'upstream_failed' } },
      }),
      row({ event_type: 'node_skipped_prior_success' }),
    ];

    for (const persisted of rows) {
      expect(JSON.parse(mapWorkflowEventRow(persisted) as string)).not.toHaveProperty('cause');
    }
  });

  test('obsolete step transitions are not interpreted or polled', () => {
    for (const eventType of ['step_started', 'step_completed', 'step_failed']) {
      expect(mapWorkflowEventRow(row({ event_type: eventType, step_name: 'plan' }))).toBeNull();
      expect(DASHBOARD_SOURCE_EVENT_TYPES).not.toContain(eventType);
    }
  });

  test('loop_iteration_started → dag_node running', () => {
    const e = JSON.parse(
      mapWorkflowEventRow(
        row({ event_type: 'loop_iteration_started', step_name: 'impl' })
      ) as string
    );
    expect(e).toMatchObject({ type: 'dag_node', status: 'running' });
  });

  test('node_skipped_prior_success → dag_node completed (hit on every resume)', () => {
    const e = JSON.parse(
      mapWorkflowEventRow(
        row({ event_type: 'node_skipped_prior_success', step_name: 'plan' })
      ) as string
    );
    expect(e).toMatchObject({ type: 'dag_node', status: 'completed', nodeId: 'plan' });
    expect(e).not.toHaveProperty('reason');
    expect(e).not.toHaveProperty('cause');
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
    expect(mapWorkflowEventRow(row({ event_type: 'provider_event' }))).toBeNull();
    expect(mapWorkflowEventRow(row({ event_type: 'tool_completed' }))).toBeNull();
    expect(mapWorkflowEventRow(row({ event_type: 'node_session_resumed' }))).toBeNull();
    expect(mapWorkflowEventRow(row({ event_type: 'workflow_artifact' }))).toBeNull();
  });
});

describe('DashboardEventPoller', () => {
  beforeEach(() => {
    mockLog.error.mockClear();
    mockLog.warn.mockClear();
  });

  test.each(['node_started', 'node_suspended', 'node_completed', 'node_failed', 'node_skipped'])(
    'a malformed %s row does not block later runs or replay on the next drain',
    async eventType => {
      const feed = makeFeed();
      const t = makeTransport();
      const poller = new DashboardEventPoller(feed);
      await poller.start(t, 1e9);
      const malformed = row({
        id: 'bad-event',
        workflow_run_id: 'bad-run',
        event_type: eventType,
        data: { node: { id: 'build', kind: 'exec', runtime: 'sh' } },
      });
      try {
        expect(() => mapWorkflowEventRow(malformed)).toThrow('metadata is incomplete');
        feed.write(
          malformed,
          row({ workflow_run_id: 'healthy-run', event_type: 'workflow_completed' })
        );
        await poller.drainNow();
        expect(emittedIds(t)).toEqual(['healthy-run']);

        feed.write(row({ workflow_run_id: 'next-run', event_type: 'workflow_started' }));
        await poller.drainNow();
        expect(emittedIds(t)).toEqual(['healthy-run', 'next-run']);
        expect(mockLog.warn).toHaveBeenCalledTimes(1);
        expect(mockLog.warn.mock.calls[0]).toEqual([
          {
            err: expect.any(Error),
            eventId: 'bad-event',
            runId: 'bad-run',
            eventType,
          },
          'dashboard_poller.row_mapping_failed',
        ]);
        expect(mockLog.error).not.toHaveBeenCalled();
      } finally {
        poller.stop();
      }
    }
  );

  test('emits events written after start once, in commit order, and never replays history', async () => {
    const feed = makeFeed();
    feed.write(row({ workflow_run_id: 'before-start', event_type: 'workflow_started' }));
    const t = makeTransport();
    const poller = new DashboardEventPoller(feed);
    await poller.start(t, 1e9);

    feed.write(
      row({ workflow_run_id: 'r1', event_type: 'workflow_started' }),
      row({ workflow_run_id: 'r1', event_type: 'provider_event' }),
      row({ workflow_run_id: 'r2', event_type: 'node_started' })
    );
    await poller.drainNow();
    feed.write(row({ workflow_run_id: 'r3', event_type: 'workflow_completed' }));
    await poller.drainNow();
    await poller.drainNow();
    poller.stop();

    expect(t.emitted.every(({ conv }) => conv === '__dashboard__')).toBe(true);
    expect(emittedIds(t)).toEqual(['r1', 'r2', 'r3']);
    expect(feed.requestedTypes.length).toBeGreaterThan(0);
    expect(feed.requestedTypes.every(types => types === DASHBOARD_SOURCE_EVENT_TYPES)).toBe(true);
  });

  test('a page of only filtered-out rows does not end the drain', async () => {
    const feed = makeFeed();
    const t = makeTransport();
    const poller = new DashboardEventPoller(feed);
    await poller.start(t, 1e9);

    feed.write(
      ...Array.from({ length: 500 }, () => row({ event_type: 'provider_event' })),
      row({ workflow_run_id: 'after-filtered-page', event_type: 'workflow_completed' })
    );
    await poller.drainNow();
    poller.stop();

    expect(emittedIds(t)).toEqual(['after-filtered-page']);
  });

  test('with no dashboard stream open, the cursor follows the head', async () => {
    const feed = makeFeed();
    const t = makeTransport(false);
    const poller = new DashboardEventPoller(feed);
    await poller.start(t, 1e9);

    feed.write(row({ workflow_run_id: 'idle-gap', event_type: 'workflow_started' }));
    await poller.drainNow();
    expect(feed.reads).toBe(0);

    t.open = true;
    feed.write(row({ workflow_run_id: 'live', event_type: 'workflow_started' }));
    await poller.drainNow();
    poller.stop();

    expect(emittedIds(t)).toEqual(['live']);
  });

  test('a client connecting during the idle head read still receives what commits after it', async () => {
    const feed = makeFeed();
    const t = makeTransport(false);
    const poller = new DashboardEventPoller(feed);
    await poller.start(t, 1e9);

    const head = feed.getWorkflowEventHead;
    feed.getWorkflowEventHead = async () => {
      t.open = true;
      feed.write(row({ workflow_run_id: 'during-connect', event_type: 'workflow_started' }));
      return head();
    };
    await poller.drainNow();
    poller.stop();

    expect(emittedIds(t)).toEqual(['during-connect']);
  });

  test('a failed head read at start does not fail startup or replay history', async () => {
    const feed = makeFeed();
    feed.write(row({ workflow_run_id: 'before-start', event_type: 'workflow_started' }));
    const head = feed.getWorkflowEventHead;
    feed.getWorkflowEventHead = () => Promise.reject(new Error('store down'));
    const t = makeTransport();
    const poller = new DashboardEventPoller(feed);
    await poller.start(t, 1e9);
    expect(mockLog.warn).toHaveBeenCalledTimes(1);

    feed.getWorkflowEventHead = head;
    await poller.drainNow();
    feed.write(row({ workflow_run_id: 'live', event_type: 'workflow_started' }));
    await poller.drainNow();
    poller.stop();

    expect(emittedIds(t)).toEqual(['live']);
  });

  test('coalesces a burst of drainNow calls into one trailing drain', async () => {
    const feed = makeFeed();
    const t = makeTransport();
    const poller = new DashboardEventPoller(feed);
    await poller.start(t, 1e9);

    const read = feed.readWorkflowEventsAfter;
    let release!: () => void;
    const released = new Promise<void>(resolve => (release = resolve));
    let blocked = false;
    feed.readWorkflowEventsAfter = async (...args) => {
      if (!blocked) {
        blocked = true;
        await released;
      }
      return read(...args);
    };

    const burst = [poller.drainNow(), poller.drainNow(), poller.drainNow()];
    release();
    await Promise.all(burst);
    poller.stop();

    // An empty feed takes one read per pass: the initial pass + ONE trailing pass.
    expect(feed.reads).toBe(2);
  });

  test('escalates store failures from warn to error after the threshold', async () => {
    const feed = makeFeed();
    const t = makeTransport();
    const poller = new DashboardEventPoller(feed);
    await poller.start(t, 1e9);
    feed.readWorkflowEventsAfter = () => Promise.reject(new Error('store down'));

    for (let i = 0; i < 4; i++) await poller.drainNow();
    expect(mockLog.warn).toHaveBeenCalledTimes(4);
    expect(mockLog.error).not.toHaveBeenCalled();

    await poller.drainNow();
    poller.stop();
    expect(mockLog.error).toHaveBeenCalledTimes(1);
    expect(mockLog.error.mock.calls[0][1]).toBe('dashboard_poller.drain_failing_persistently');
  });
});
