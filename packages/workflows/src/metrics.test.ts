import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import { makeRun } from './engine-contract-fixtures';
import { queryMetrics, type MetricsQuery, type MetricsStore } from './metrics';
import type { WorkflowEventRow } from './schemas/workflow-event';
import type { WorkflowRun } from './schemas/workflow-run';
import type { MetricRecordRow } from './store';

const window: MetricsQuery = {
  since: new Date('2026-10-01T00:00:00Z'),
  until: new Date('2026-10-08T00:00:00Z'),
};

let sequence = 0;

/** One stored completion; `run` and `node` default to a fresh run and a bash node `count`. */
function completion(
  metrics: unknown,
  options: { run?: string; node?: string; type?: string; codebase?: string; at?: string } = {}
): MetricRecordRow {
  sequence += 1;
  return {
    eventId: `event-${String(sequence)}`,
    runId: options.run ?? `run-${String(sequence)}`,
    workflowName: 'metrics',
    codebaseId: options.codebase ?? null,
    nodeId: options.node ?? 'count',
    nodeType: options.type ?? 'bash',
    completedAt: options.at ?? '2026-10-02T12:00:00.000Z',
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
  {
    events = rows.map(row => event(row, 'node_completed')),
    runs = [],
  }: { events?: WorkflowEventRow[]; runs?: WorkflowRun[] } = {}
): MetricsStore {
  return {
    listMetricRecords: async () => rows,
    listEventsForRuns: async ids =>
      new Map(ids.map(id => [id, events.filter(row => row.workflow_run_id === id)])),
    getWorkflowRunsByIds: async ids => runs.filter(run => ids.includes(run.id)),
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

  test('refuses a record whose kind conflicts with the name definition', async () => {
    const report = await queryMetrics(
      store([
        completion([count(3)]),
        completion([count(1, { kind: 'score' })], { node: 'recount' }),
      ]),
      window
    );
    expect(report.metrics.map(m => [m.name, m.kind, m.instruments[0]?.value])).toEqual([
      ['factory.prs_merged', 'count', 3],
    ]);
    expect(report.refused).toEqual([
      expect.objectContaining({
        reason: 'definition_conflict',
        node_id: 'recount',
        definition: { kind: 'count', unit: 'prs', calibrates: null },
        offered: { kind: 'score', unit: 'prs', calibrates: null },
      }),
    ]);
  });

  test('a codebase filter keeps the install-wide definition of a name', async () => {
    const rows = [
      completion([count(3)], { codebase: 'a' }),
      completion([count(1, { kind: 'score' })], { codebase: 'b' }),
      completion([count(2)], { codebase: 'b' }),
    ];
    const report = await queryMetrics(store(rows), { ...window, codebaseId: 'b' });
    expect(report.metrics.map(m => [m.kind, m.instruments[0]?.value, m.instruments[0]?.n])).toEqual(
      [['count', 2, 1]]
    );
    expect(report.refused).toEqual([
      expect.objectContaining({ reason: 'definition_conflict', run_id: rows[1]?.runId }),
    ]);
    const other = await queryMetrics(store(rows), { ...window, codebaseId: 'a' });
    expect(other.refused).toEqual([]);
  });

  test('a node that relays another node output does not count its records again', async () => {
    const report = await queryMetrics(
      store([
        completion([count(1)], { run: 'child', node: 'count' }),
        completion([count(1)], { run: 'parent', node: 'child', type: 'workflow' }),
        completion([count(1)], { run: 'group', node: 'grp.count' }),
        completion([count(1)], { run: 'group', node: 'grp', type: 'loop_group' }),
        completion([count(1)], { run: 'fan', node: 'inc__count' }),
        completion([count(1)], { run: 'fan', node: 'inc', type: 'compose_fan_out_instance' }),
      ]),
      window
    );
    expect(report.metrics[0]?.instruments[0]).toMatchObject({ value: 3, n: 3 });
  });

  test('a definition fixed before the window still refuses a conflicting record inside it', async () => {
    const report = await queryMetrics(
      store([
        completion([count(3)], { at: '2026-09-15T00:00:00.000Z' }),
        completion([count(5, { unit: 'pull_requests' })], { at: '2026-10-02T00:00:00.000Z' }),
      ]),
      window
    );
    expect(report.metrics).toEqual([]);
    expect(report.refused).toEqual([
      expect.objectContaining({
        reason: 'definition_conflict',
        name: 'factory.prs_merged',
        definition: { kind: 'count', unit: 'prs', calibrates: null },
        offered: { kind: 'count', unit: 'pull_requests', calibrates: null },
      }),
    ]);
  });

  test('subject narrows a name to that subject', async () => {
    const report = await queryMetrics(
      store([
        completion([count(2, { subject: 'pr-1' })]),
        completion([count(7, { subject: 'pr-2' })]),
      ]),
      { ...window, subject: 'pr-1' }
    );
    expect(report.metrics[0]?.instruments.map(i => [i.value, i.n, i.latest.subject])).toEqual([
      [2, 1, 'pr-1'],
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
      store([amended, first, second], {
        events: [
          event(amended, 'node_completed'),
          event(amended, 'node_failed'),
          event(first, 'node_completed'),
          event(second, 'node_completed'),
        ],
      }),
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

const cut = new Date('2026-10-04T00:00:00Z');

function runStarted(at: string, metadata: Record<string, unknown> = {}): WorkflowRun {
  return makeRun({ id: randomUUID(), started_at: new Date(at), metadata });
}

const before = (metadata?: Record<string, unknown>): WorkflowRun =>
  runStarted('2026-10-02T00:00:00Z', metadata);
const after = (metadata?: Record<string, unknown>): WorkflowRun =>
  runStarted('2026-10-05T00:00:00Z', metadata);

/** A merge-rate record for `subject`, produced by `runs`. */
const merged = (value: number, subject: string, runs: WorkflowRun[]): Record<string, unknown> => ({
  name: 'sdlc.pr_merge_rate',
  kind: 'score',
  unit: 'ratio',
  value,
  subject,
  runs: runs.map(run => run.id),
});

/** `successes` of `n` merge-rate records, each produced by its own run from `start`. */
function cohort(prefix: string, successes: number, n: number, start: () => WorkflowRun) {
  const runs = Array.from({ length: n }, start);
  const records = runs.map((run, i) =>
    merged(i < successes ? 1 : 0, `${prefix}-${String(i)}`, [run])
  );
  return { runs, records };
}

async function compareRates(
  [beforeSuccesses, beforeN]: [number, number],
  [afterSuccesses, afterN]: [number, number]
) {
  const old = cohort('old', beforeSuccesses, beforeN, () => before());
  const fresh = cohort('new', afterSuccesses, afterN, () => after());
  const report = await queryMetrics(
    store([completion([...old.records, ...fresh.records])], { runs: [...old.runs, ...fresh.runs] }),
    { ...window, compareAt: cut }
  );
  return report.metrics[0]?.instruments[0];
}

describe('queryMetrics attribution, cost and compare', () => {
  test('a record falls in the cohort of its producing runs, not of its `at`', async () => {
    const run = before();
    const report = await queryMetrics(
      store(
        [
          completion([
            merged(1, 'pr-1', [run]),
            { ...merged(0, 'pr-2', [run]), at: '2026-10-06T00:00:00Z' },
          ]),
        ],
        {
          runs: [run],
        }
      ),
      { ...window, compareAt: cut }
    );
    expect(report.metrics[0]?.instruments[0]?.compare).toMatchObject({
      at: cut.toISOString(),
      before: { n: 2, value: 0.5 },
      after: { n: 0, value: null, interval: null },
      delta: null,
      straddling: 0,
      unattributed: 0,
    });
  });

  test('a record with no runs is produced by the run that returned it', async () => {
    const emitter = after();
    const row = completion([merged(1, 'pr-1', [emitter])], { run: emitter.id });
    const { runs: _runs, ...unnamed } = merged(1, 'pr-1', [emitter]);
    const report = await queryMetrics(
      store([{ ...row, metrics: [unnamed] }], { runs: [emitter] }),
      { ...window, compareAt: cut }
    );
    expect(report.metrics[0]?.instruments[0]?.compare).toMatchObject({
      before: { n: 0 },
      after: { n: 1, value: 1 },
    });
  });

  test('a record with runs on both sides of the cut is straddling, in neither cohort', async () => {
    const runs = [before(), after()];
    const report = await queryMetrics(
      store([completion([merged(1, 'pr-1', runs), merged(0, 'pr-2', [runs[1] ?? after()])])], {
        runs,
      }),
      { ...window, compareAt: cut }
    );
    const [instrument] = report.metrics[0]?.instruments ?? [];
    expect(instrument?.n).toBe(2);
    expect(instrument?.compare).toMatchObject({
      before: { n: 0 },
      after: { n: 1, value: 0 },
      straddling: 1,
      unattributed: 0,
    });
  });

  test('a record with a named run gone is unattributed, not credited to its surviving or emitting run', async () => {
    const emitter = after();
    const gone = before();
    const report = await queryMetrics(
      store(
        [
          completion(
            [
              merged(1, 'pr-1', [gone]),
              merged(0, 'pr-2', [emitter]),
              merged(1, 'pr-3', [before(), emitter]),
            ],
            { run: emitter.id }
          ),
        ],
        {
          runs: [emitter],
        }
      ),
      { ...window, compareAt: cut }
    );
    const [instrument] = report.metrics[0]?.instruments ?? [];
    expect(instrument?.n).toBe(3);
    expect(instrument?.value).toBeCloseTo(2 / 3, 10);
    expect(instrument?.compare).toMatchObject({
      before: { n: 0 },
      after: { n: 1, value: 0 },
      straddling: 0,
      unattributed: 2,
    });
    expect(instrument?.cost).toMatchObject({ runs: 1, runs_missing: 2 });
  });

  test('30 of 50 against 40 of 50 is separated although the cohort intervals overlap', async () => {
    const compare = (await compareRates([30, 50], [40, 50]))?.compare;
    expect(compare?.delta).toBeCloseTo(0.2, 10);
    expect(compare?.delta_interval?.low).toBeCloseTo(0.0201, 4);
    expect(compare?.delta_interval?.high).toBeCloseTo(0.3636, 4);
    expect(compare?.separated).toBe(true);
    expect(compare?.before.interval?.high ?? 0).toBeGreaterThan(compare?.after.interval?.low ?? 1);
    const worse = (await compareRates([40, 50], [30, 50]))?.compare;
    expect(worse?.delta_interval?.high).toBeCloseTo(-0.0201, 4);
    expect(worse?.separated).toBe(true);
  });

  test('18 of 30 against 24 of 30 is not separated', async () => {
    const compare = (await compareRates([18, 30], [24, 30]))?.compare;
    expect(compare?.delta_interval?.low).toBeCloseTo(-0.0317, 4);
    expect(compare?.delta_interval?.high).toBeCloseTo(0.4056, 4);
    expect(compare?.separated).toBe(false);
  });

  test('identical rates are not separated', async () => {
    const compare = (await compareRates([20, 40], [20, 40]))?.compare;
    expect(compare?.delta).toBe(0);
    expect(compare?.separated).toBe(false);
  });

  test("scores that are not rates compare with Welch's interval", async () => {
    const values = { old: [27.5, 21.0, 19.0, 23.6], new: [27.1, 22.0, 20.8, 23.4] };
    const runs: WorkflowRun[] = [];
    const record = (value: number, subject: string, run: WorkflowRun): Record<string, unknown> => {
      runs.push(run);
      return { ...merged(value, subject, [run]), name: 'sdlc.review_minutes', unit: 'minutes' };
    };
    const records = [
      ...values.old.map((value, i) => record(value, `old-${String(i)}`, before())),
      ...values.new.map((value, i) => record(value, `new-${String(i)}`, after())),
    ];
    const report = await queryMetrics(store([completion(records)], { runs }), {
      ...window,
      compareAt: cut,
    });
    const compare = report.metrics[0]?.instruments[0]?.compare;
    // Welch for [27.1, 22.0, 20.8, 23.4] − [27.5, 21.0, 19.0, 23.6]: ν = 5.54.
    expect(compare?.delta_interval?.low).toBeCloseTo(-5.1611, 4);
    expect(compare?.delta_interval?.high).toBeCloseTo(6.2611, 4);
    expect(compare?.separated).toBe(false);
  });

  test('cost counts each producing run once and counts runs without cost, tokens or a row', async () => {
    const priced = before({ total_cost_usd: 1.5, total_tokens_in: 100, total_tokens_out: 20 });
    const unpriced = after({ total_tokens_in: 50, total_tokens_out: 5 });
    const bare = after();
    const gone = after();
    const report = await queryMetrics(
      store(
        [
          completion([
            merged(1, 'pr-1', [priced, unpriced]),
            merged(1, 'pr-2', [priced]),
            merged(0, 'pr-3', [bare, gone]),
          ]),
        ],
        { runs: [priced, unpriced, bare] }
      ),
      window
    );
    expect(report.metrics[0]?.instruments[0]?.cost).toEqual({
      usd: 1.5,
      input_tokens: 150,
      output_tokens: 25,
      runs: 3,
      runs_without_cost: 2,
      runs_without_tokens: 1,
      runs_missing: 1,
    });
    expect(report.metrics[0]?.instruments[0]?.compare).toBeUndefined();
  });

  test('cost is null, not zero, when no producing run recorded one', async () => {
    const run = after();
    const report = await queryMetrics(
      store([completion([merged(1, 'pr-1', [run])])], { runs: [run] }),
      window
    );
    expect(report.metrics[0]?.instruments[0]?.cost).toMatchObject({
      usd: null,
      input_tokens: null,
      runs_without_cost: 1,
      runs_without_tokens: 1,
    });
  });

  test('a count has no interval, and a score needs two records for one', async () => {
    const run = after();
    const report = await queryMetrics(
      store([completion([count(3), count(4), merged(1, 'pr-1', [run])])], { runs: [run] }),
      window
    );
    expect(report.metrics.map(m => [m.name, m.instruments[0]?.interval])).toEqual([
      ['factory.prs_merged', null],
      ['sdlc.pr_merge_rate', null],
    ]);
  });

  test('a rate reports its Wilson interval and other scores their t interval', async () => {
    const run = after();
    const rates = Array.from({ length: 10 }, (_, i) =>
      merged(i < 5 ? 1 : 0, `pr-${String(i)}`, [run])
    );
    const minutes = [3, 5, 7].map((value, i) => ({
      ...merged(value, `pr-${String(i)}`, [run]),
      name: 'sdlc.review_minutes',
      unit: 'minutes',
    }));
    const report = await queryMetrics(
      store([completion([...rates, ...minutes])], { runs: [run] }),
      window
    );
    const intervals = Object.fromEntries(
      report.metrics.map(m => [m.name, m.instruments[0]?.interval])
    );
    expect(intervals['sdlc.pr_merge_rate']?.low).toBeCloseTo(0.2366, 4);
    expect(intervals['sdlc.pr_merge_rate']?.high).toBeCloseTo(0.7634, 4);
    // 5 ± t(0.975, 2) · 2 / √3
    expect(intervals['sdlc.review_minutes']?.low).toBeCloseTo(0.0317, 4);
    expect(intervals['sdlc.review_minutes']?.high).toBeCloseTo(9.9683, 4);
  });
});
