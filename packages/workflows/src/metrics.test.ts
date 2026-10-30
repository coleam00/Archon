import { describe, expect, test } from 'bun:test';
import { queryMetrics, type MetricsQuery, type MetricsStore } from './metrics';
import type { WorkflowEventRow } from './schemas/workflow-event';
import type { MetricRecordRow } from './store';

const window: MetricsQuery = {
  since: new Date('2026-10-01T00:00:00Z'),
  until: new Date('2026-10-08T00:00:00Z'),
};

let sequence = 0;

/** One stored completion; `run` and `node` default to a fresh run and `count`. */
function completion(
  metrics: unknown,
  options: { run?: string; node?: string; at?: string } = {}
): MetricRecordRow {
  sequence += 1;
  return {
    eventId: `event-${String(sequence)}`,
    runId: options.run ?? `run-${String(sequence)}`,
    runStartedAt: new Date('2026-10-01T00:00:00Z'),
    workflowName: 'metrics',
    codebaseId: null,
    nodeId: options.node ?? 'count',
    completedAt: options.at ?? '2026-10-02T12:00:00.000Z',
    eventOrder: sequence,
    metrics,
  };
}

function event(row: MetricRecordRow, type: 'node_completed' | 'node_failed'): WorkflowEventRow {
  sequence += 1;
  return {
    id: type === 'node_completed' ? row.eventId : `event-${String(sequence)}`,
    workflow_run_id: row.runId,
    event_type: type,
    step_index: null,
    step_name: row.nodeId,
    data: {},
    created_at: row.completedAt,
    event_order: sequence,
  };
}

/** Every row is its node's terminal event unless `events` says otherwise. */
function store(
  rows: MetricRecordRow[],
  events: WorkflowEventRow[] = rows.map(row => event(row, 'node_completed'))
): MetricsStore {
  return {
    listMetricRecords: async () => rows,
    listEventsForRuns: async ids =>
      new Map(ids.map(id => [id, events.filter(row => row.workflow_run_id === id)])),
  };
}

const count = (value: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: 'factory.prs_merged',
  kind: 'count',
  unit: 'prs',
  value,
  subject: null,
  ...extra,
});

describe('queryMetrics', () => {
  test('refuses a record whose unit conflicts with the name definition, naming both', async () => {
    const report = await queryMetrics(
      store([
        completion([count(3)]),
        completion([count(5, { unit: 'pull_requests' })], { node: 'recount' }),
      ]),
      window
    );
    expect(report.metrics.map(m => [m.name, m.unit, m.instruments[0]?.value])).toEqual([
      ['factory.prs_merged', 'prs', 3],
    ]);
    expect(report.refused).toEqual([
      expect.objectContaining({
        reason: 'definition_conflict',
        name: 'factory.prs_merged',
        node_id: 'recount',
        definition: { kind: 'count', unit: 'prs', calibrates: null },
        offered: { kind: 'count', unit: 'pull_requests', calibrates: null },
      }),
    ]);
  });

  test('a re-measured subject replaces its value; a second instrument keeps its own group', async () => {
    const subject = 'https://example.test/pr/1';
    const score = (value: number, instrument: string): Record<string, unknown> => ({
      name: 'sdlc.tests_unprotective',
      kind: 'score',
      unit: 'ratio',
      value,
      subject,
      instrument,
    });
    const report = await queryMetrics(
      store([
        completion([score(0.2, 'judge-v1')], { at: '2026-10-02T00:00:00.000Z' }),
        completion([score(0.4, 'judge-v1')], { at: '2026-10-03T00:00:00.000Z' }),
        completion([score(0.9, 'judge-v2')], { at: '2026-10-04T00:00:00.000Z' }),
      ]),
      window
    );
    const [metric] = report.metrics;
    expect(metric?.headline_instrument).toBe('judge-v2');
    expect(metric?.instruments.map(i => [i.instrument, i.value, i.n])).toEqual([
      ['judge-v1', 0.4, 1],
      ['judge-v2', 0.9, 1],
    ]);
  });

  test('`at` places a record in the window when its completion time would not', async () => {
    const report = await queryMetrics(
      store([
        completion([count(1, { at: '2026-10-05T00:00:00+02:00' })], {
          at: '2026-10-20T00:00:00.000Z',
        }),
        completion([count(10)], { at: '2026-09-01T00:00:00.000Z' }),
      ]),
      window
    );
    expect(report.metrics[0]?.instruments[0]).toMatchObject({
      value: 1,
      n: 1,
      latest: { value: 1, at: '2026-10-04T22:00:00.000Z', subject: null },
      series: [{ day: '2026-10-04', value: 1, n: 1 }],
    });
  });

  test('a count sums and a score takes the mean, per day and over the window', async () => {
    const rate = (value: number, subject: string): Record<string, unknown> => ({
      name: 'sdlc.pr_merge_rate',
      kind: 'score',
      unit: 'ratio',
      value,
      subject,
    });
    const report = await queryMetrics(
      store([
        completion([count(2), rate(1, 'a'), rate(0, 'b')]),
        completion([count(3), rate(1, 'c')], { at: '2026-10-03T12:00:00.000Z' }),
      ]),
      window
    );
    expect(
      report.metrics.map(m => [m.name, m.instruments[0]?.value, m.instruments[0]?.series])
    ).toEqual([
      [
        'factory.prs_merged',
        5,
        [
          { day: '2026-10-02', value: 2, n: 1 },
          { day: '2026-10-03', value: 3, n: 1 },
        ],
      ],
      [
        'sdlc.pr_merge_rate',
        2 / 3,
        [
          { day: '2026-10-02', value: 0.5, n: 2 },
          { day: '2026-10-03', value: 1, n: 1 },
        ],
      ],
    ]);
  });

  test('an invalid stored record is refused, not thrown, and only on an unfiltered query', async () => {
    const rows = [completion([count(-1)]), completion([count(4)])];
    const report = await queryMetrics(store(rows), window);
    expect(report.metrics[0]?.instruments[0]?.value).toBe(4);
    expect(report.refused).toEqual([
      expect.objectContaining({ reason: 'invalid', run_id: rows[0]?.runId }),
    ]);
    const named = await queryMetrics(store(rows), { ...window, name: 'factory.prs_merged' });
    expect(named.refused).toEqual([]);
  });

  test('only the node latest terminal event in a run counts', async () => {
    const amended = completion([count(7)]);
    const first = completion([count(1)], { run: 'rerun' });
    const second = completion([count(1)], { run: 'rerun' });
    const report = await queryMetrics(
      store(
        [amended, first, second],
        [
          event(amended, 'node_completed'),
          event(amended, 'node_failed'),
          event(first, 'node_completed'),
          event(second, 'node_completed'),
        ]
      ),
      window
    );
    expect(report.metrics[0]?.instruments[0]).toMatchObject({ value: 1, n: 1 });
  });

  test('the window is half-open', async () => {
    const report = await queryMetrics(
      store([
        completion([count(1)], { at: window.since.toISOString() }),
        completion([count(10)], { at: window.until.toISOString() }),
      ]),
      window
    );
    expect(report.metrics[0]?.instruments[0]?.value).toBe(1);
  });
});
