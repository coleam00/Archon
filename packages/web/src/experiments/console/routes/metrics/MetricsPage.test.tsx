import { afterEach, describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router';
import { MetricsPage } from './MetricsPage';
import {
  calibrationSentence,
  costPerCard,
  countCard,
  metricsRequests,
  parseWindow,
  ratioCard,
  type Calibrations,
} from './model';
import { invalidate, set } from '../../store/cache';
import { K } from '../../store/keys';
import type { MetricViews, MetricsReport } from '../../skills/metrics';

type Metric = MetricsReport['metrics'][number];
type Instrument = Metric['instruments'][number];
type Identity = Pick<Instrument, 'instrument' | 'measured_by'>;

afterEach(() => {
  invalidate('metrics');
  invalidate('metric-views');
});

const WINDOW = { since: '2026-10-03T00:00:00.000Z', until: '2026-11-02T00:00:00.000Z' };
const NONE: Identity = { instrument: null, measured_by: [] };
const JUDGE: Identity = { instrument: 'judge-v2', measured_by: ['claude/model-a@high'] };

function instrument(value: number, identity: Identity, n = 12): Instrument {
  return {
    ...identity,
    value,
    n,
    interval: null,
    cost: {
      usd: 1.5,
      input_tokens: 100,
      output_tokens: 20,
      runs: 3,
      runs_without_cost: 1,
      runs_without_tokens: 0,
      runs_partial_cost: 0,
      runs_missing: 0,
    },
    latest: { value, at: '2026-11-01T10:00:00.000Z', subject: null },
    series: [
      { day: '2026-10-20', value: 4, n: 4 },
      { day: '2026-11-01', value: 8, n: 8 },
    ],
  };
}

function metric(
  name: string,
  instruments: Instrument[],
  fields: Partial<Pick<Metric, 'kind' | 'unit' | 'calibrates'>> = {}
): Metric {
  const [headline] = instruments;
  return {
    name,
    kind: 'count',
    unit: 'items',
    calibrates: null,
    ...fields,
    headline_instrument: headline?.instrument ?? null,
    headline_measured_by: headline?.measured_by ?? [],
    instruments,
  };
}

const score = { kind: 'score', unit: 'ratio' } as const;
const shipped = metric('demo.items_shipped', [instrument(12, NONE)]);
const flagged = metric('demo.items_flagged', [instrument(3, JUDGE)]);
const checked = metric('demo.items_checked', [instrument(12, JUDGE)]);
const catchRate = (identities: Identity[], value = 0.9, n = 10): Metric =>
  metric(
    'demo.items_flagged_catch_rate',
    identities.map(identity => instrument(value, identity, n)),
    { ...score, calibrates: flagged.name }
  );

const report = (patch: Partial<MetricsReport> = {}): MetricsReport => ({
  window: WINDOW,
  metrics: [],
  refused: [],
  ...patch,
});
const loaded = (calibrations: MetricsReport): Calibrations => ({
  state: 'loaded',
  report: calibrations,
});

const VIEWS: MetricViews = {
  packs: [
    {
      pack: 'demo',
      source: 'project',
      names: {
        'demo.items_shipped': 'Items shipped',
        'demo.items_flagged': 'Flagged items',
        'demo.items_checked': 'Checked items',
      },
      cards: [
        {
          shape: 'count',
          title: 'Items shipped',
          metric: 'demo.items_shipped',
          breakdown: [{ metric: 'demo.items_checked', label: 'checked' }],
        },
        {
          shape: 'ratio',
          title: 'Flagged',
          numerator: 'demo.items_flagged',
          denominator: 'demo.items_checked',
          denominator_label: 'checked items',
          calibration: {
            metric: 'demo.items_flagged_catch_rate',
            label: 'judge catches',
            rough_below: 0.8,
          },
        },
        { shape: 'cost_per', title: 'Cost per item', metric: 'demo.items_shipped' },
      ],
    },
  ],
  errors: [],
};

const RATIO = VIEWS.packs[0]?.cards[1];
if (RATIO?.shape !== 'ratio') throw new Error('fixture');

function render(
  path: string,
  data: {
    report?: MetricsReport;
    calibrations?: MetricsReport | 'loading';
    views?: MetricViews;
  } = {}
): string {
  const days = path.match(/window=(\d+)d/)?.[1] ?? '7';
  set(K.metrics('all', `${days}d`), data.report ?? report());
  if (data.calibrations !== 'loading') set(K.metrics('all', '365d'), data.calibrations ?? report());
  set(K.metricViews('all'), data.views ?? VIEWS);
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/console/metrics" element={<MetricsPage />} />
        <Route path="/console/metrics/details" element={<MetricsPage view="details" />} />
      </Routes>
    </MemoryRouter>
  );
}

const details = (data: Parameters<typeof render>[1]): string =>
  render('/console/metrics/details?window=30d', data);

describe('overview', () => {
  test('renders the declared cards in order from one window', () => {
    const html = render('/console/metrics?window=30d', {
      report: report({ metrics: [shipped, flagged, checked] }),
      calibrations: report({ metrics: [catchRate([JUDGE])] }),
    });
    const titles = [...html.matchAll(/<h3[^>]*>([^<]*)<\/h3>/g)].map(match => match[1]);
    expect(titles).toEqual(['Items shipped', 'Flagged', 'Cost per item']);
    expect(html).toContain('25%');
    expect(html).toContain('3 of 12 checked items · judge catches 9 of 10');
    expect(html).toContain('≥ $0.13');
    expect(html).toContain('aria-current="true"');
    expect(html).toContain('href="/console/metrics/details?window=30d"');
  });

  test('the cards render before the calibration loads; Details waits for it', () => {
    const data = {
      report: report({ metrics: [shipped, flagged, checked] }),
      calibrations: 'loading',
    } as const;
    const html = render('/console/metrics', data);
    expect(html).toContain('3 of 12 checked items');
    expect(html).toContain('calibration loading');
    expect(html).not.toContain('Loading…');
    expect(render('/console/metrics/details', data)).toContain('Loading last 7 days…');
  });

  test('with no declared cards, says so; a declaration error is named', () => {
    const html = render('/console/metrics', {
      views: {
        packs: [],
        errors: [{ pack: 'demo', source: 'global', error: 'cards: Required' }],
      },
    });
    expect(html).toContain('No pack declares overview cards.');
    expect(html).toContain('The global pack demo declares cards that could not be read');
  });

  test('a card links to its metric on Details; an empty breakdown names what has no records', () => {
    const html = render('/console/metrics', { report: report({ metrics: [shipped] }) });
    expect(html).toContain('href="/console/metrics/details?window=7d#metric-demo.items_shipped"');
    expect(html).toContain('href="/console/metrics/details?window=7d#metric-demo.items_flagged"');
    expect(html).toContain('no records of Checked items');
    expect(html).not.toContain('not recorded');
  });
});

describe('cards', () => {
  test('a count whose breakdown metric has no records says so instead of 0', () => {
    const card = countCard(
      {
        shape: 'count',
        title: 'Shipped',
        metric: shipped.name,
        breakdown: [{ metric: 'demo.none', label: 'lost' }],
      },
      report({ metrics: [shipped] })
    );
    expect(card).toEqual({
      shape: 'count',
      title: 'Shipped',
      state: 'value',
      value: 12,
      breakdown: [{ metric: 'demo.none', label: 'lost', value: null }],
    });
    const missing = countCard({ shape: 'count', title: 'Shipped', metric: 'demo.none' }, report());
    expect(missing.state).toBe('not_recorded');
  });

  test('a ratio whose denominator was counted only by another instrument is not recorded', () => {
    const otherJudge = metric(checked.name, [instrument(12, { ...JUDGE, instrument: 'judge-v1' })]);
    expect(
      ratioCard(RATIO, report({ metrics: [flagged, otherJudge] }), loaded(report())).state
    ).toBe('not_recorded');
  });

  test('a calibration below the declared threshold makes the share rough, and says the threshold', () => {
    if (RATIO.calibration === undefined) throw new Error('fixture');
    const view = { ...RATIO, calibration: { ...RATIO.calibration, rough_below: 0.6 } };
    const card = ratioCard(
      view,
      report({ metrics: [flagged, checked] }),
      loaded(report({ metrics: [catchRate([JUDGE], 0.5)] }))
    );
    const calibration = card.state === 'value' ? card.calibration : null;
    expect(calibration).toEqual({
      state: 'calibrated',
      label: 'judge catches',
      caught: 5,
      of: 10,
      rough: true,
      roughBelow: 0.6,
    });
    if (calibration?.state !== 'calibrated') throw new Error('calibrated');
    expect(calibrationSentence(calibration)).toBe(
      'Judge catches 5 of 10 labelled cases (50%); below 60% the share is rough.'
    );
  });

  test('a calibration mean outside 0-1 breaks the 0/1 contract and is not calibrated', () => {
    for (const value of [1.2, -0.1]) {
      const card = ratioCard(
        RATIO,
        report({ metrics: [flagged, checked] }),
        loaded(report({ metrics: [catchRate([JUDGE], value)] }))
      );
      expect(card.state === 'value' && card.calibration?.state).toBe('not_calibrated');
    }
  });

  test('a calibration still loading or failed says so instead of not calibrated', () => {
    const counts = report({ metrics: [flagged, checked] });
    const failed = ratioCard(RATIO, counts, { state: 'failed', message: 'HTTP 500' });
    expect(failed.state === 'value' && failed.calibration).toEqual({
      state: 'unavailable',
      message: 'HTTP 500',
    });
    const loading = ratioCard(RATIO, counts, { state: 'loading' });
    expect(loading.state === 'value' && loading.calibration).toEqual({ state: 'loading' });
  });

  test('a score in a counted slot is not read as a count', () => {
    const mean = metric(shipped.name, [instrument(0.5, NONE)], score);
    const counts = report({ metrics: [mean] });
    expect(
      countCard({ shape: 'count', title: 'Shipped', metric: shipped.name }, counts).state
    ).toBe('not_recorded');
    const view = { shape: 'cost_per', title: 'Cost', metric: shipped.name } as const;
    expect(costPerCard(view, counts).state).toBe('not_recorded');
    const meanFlagged = metric(flagged.name, [instrument(0.5, JUDGE)], score);
    expect(
      ratioCard(RATIO, report({ metrics: [meanFlagged, checked] }), loaded(report())).state
    ).toBe('not_recorded');
  });

  // R2: the calibration must match the numerator's headline identity exactly.
  test.each<[string, Identity, Identity, boolean]>([
    ['the same judge', JUDGE, JUDGE, true],
    ['a newer headline judge', { ...JUDGE, instrument: 'judge-v3' }, JUDGE, false],
    ['the same judge on other models', JUDGE, { ...JUDGE, measured_by: ['codex/b'] }, false],
    [
      'the same ordered models',
      { instrument: 'j', measured_by: ['a', 'b'] },
      { instrument: 'j', measured_by: ['a', 'b'] },
      true,
    ],
    [
      'the models in another order',
      { instrument: 'j', measured_by: ['a', 'b'] },
      { instrument: 'j', measured_by: ['b', 'a'] },
      false,
    ],
    [
      'a different second model',
      { instrument: 'j', measured_by: ['a', 'b'] },
      { instrument: 'j', measured_by: ['a', 'c'] },
      false,
    ],
    [
      'a prefix of the models',
      { instrument: 'j', measured_by: ['a', 'b'] },
      { instrument: 'j', measured_by: ['a'] },
      false,
    ],
  ])('a calibration from %s', (_label, headline, calibratedBy, calibrated) => {
    const numerator = metric(flagged.name, [instrument(3, headline), instrument(1, NONE)]);
    const denominator = metric(checked.name, [instrument(12, headline)]);
    const card = ratioCard(
      RATIO,
      report({ metrics: [numerator, denominator] }),
      loaded(report({ metrics: [catchRate([calibratedBy])] }))
    );
    expect(card.state === 'value' && card.calibration?.state).toBe(
      calibrated ? 'calibrated' : 'not_calibrated'
    );
  });

  test('cost per item shows a figure only once most runs record cost', () => {
    const view = { shape: 'cost_per', title: 'Cost', metric: shipped.name } as const;
    const withCost = (runsWithoutCost: number): MetricsReport => {
      const [base] = shipped.instruments;
      if (base === undefined) throw new Error('fixture');
      return report({
        metrics: [
          metric(shipped.name, [
            {
              ...base,
              cost: { ...base.cost, usd: 6, runs: 3, runs_without_cost: runsWithoutCost },
            },
          ]),
        ],
      });
    };
    expect(costPerCard(view, withCost(2))).toEqual({
      shape: 'cost_per',
      title: 'Cost',
      state: 'cost_unrecorded',
      runs: 3,
      runsWithCost: 1,
    });
    expect(costPerCard(view, withCost(1))).toEqual({
      shape: 'cost_per',
      title: 'Cost',
      state: 'value',
      usd: 0.5,
      runs: 3,
      runsWithCost: 2,
    });
  });
  test('cost_of takes the cost from another count at the same identity', () => {
    const view = {
      shape: 'cost_per',
      title: 'Cost',
      metric: shipped.name,
      cost_of: 'demo.items_started',
    } as const;
    const started = (identity: Identity): Metric => {
      const base = instrument(20, identity);
      return metric('demo.items_started', [{ ...base, cost: { ...base.cost, usd: 24 } }]);
    };
    expect(costPerCard(view, report({ metrics: [shipped, started(NONE)] }))).toEqual({
      shape: 'cost_per',
      title: 'Cost',
      state: 'value',
      usd: 2,
      runs: 3,
      runsWithCost: 2,
    });
    expect(costPerCard(view, report({ metrics: [shipped, started(JUDGE)] })).state).toBe(
      'not_recorded'
    );
  });
});

describe('details', () => {
  test('a row names the metric plainly and gives its value, record count, cost and trend', () => {
    const html = details({ report: report({ metrics: [shipped] }) });
    const row = html.slice(html.indexOf('data-metric="demo.items_shipped"'));
    expect(row).toContain('Items shipped');
    expect(row).toContain('12 items');
    expect(row).toContain('12 records');
    expect(row).toContain('≥ $1.5');
    expect(row).toContain('1 without cost');
    expect(html).toContain('Last 30 days');
  });

  test('a metric a card reads with no records in the window is a row saying so', () => {
    const html = details({ report: report({ metrics: [shipped] }) });
    const rows = [...html.matchAll(/data-metric="([^"]*)"/g)].map(match => match[1]);
    expect(rows).toEqual(['demo.items_checked', 'demo.items_flagged', 'demo.items_shipped']);
    const empty = html.slice(html.indexOf('data-metric="demo.items_checked"'));
    expect(empty.slice(0, empty.indexOf('</tr>'))).toContain('no records in this window');
    // The calibration a ratio declares is explained in its box, never a row.
    expect(html).not.toContain('data-metric="demo.items_flagged_catch_rate"');
  });

  test('a ratio reads as a percentage', () => {
    const rate = metric('demo.ship_rate', [instrument(0.99, NONE)], score);
    const html = details({ report: report({ metrics: [rate] }) });
    const row = html.slice(html.indexOf('data-metric="demo.ship_rate"'));
    expect(row).toContain('99%');
    expect(row).not.toContain('ratio');
  });

  // R4: a sub-cent cost is a floor above zero, not "$0.00".
  test('a sub-cent cost keeps its significant digits', () => {
    const [base] = shipped.instruments;
    if (base === undefined) throw new Error('fixture');
    const cheap = metric(shipped.name, [{ ...base, cost: { ...base.cost, usd: 0.004 } }]);
    const html = details({ report: report({ metrics: [cheap] }) });
    expect(html).toContain('≥ $0.004');
    expect(html).not.toContain('$0.00<');
  });

  test('the sparkline breaks at days without records', () => {
    const polylines = (...days: string[]): string[] => {
      const [base] = shipped.instruments;
      if (base === undefined) throw new Error('fixture');
      const series = days.map(day => ({ day, value: 4, n: 4 }));
      const html = details({
        report: report({ metrics: [metric(shipped.name, [{ ...base, series }])] }),
      });
      return [...html.matchAll(/<polyline points="([^"]*)"/g)].map(match => match[1] ?? '');
    };
    // 30 days wide, 160 px: one day is 5.333 px; every value is the series max, at y = 2.
    expect(polylines('2026-10-20', '2026-10-21', '2026-10-25')).toEqual([
      '90.7,2.0 96.0,2.0',
      '117.3,2.0',
    ]);
    expect(polylines('2026-10-20', '2026-10-21', '2026-10-22')).toEqual([
      '90.7,2.0 96.0,2.0 101.3,2.0',
    ]);
  });

  test("the sparkline keeps a record from the window's first, partial day inside the chart", () => {
    const [base] = shipped.instruments;
    if (base === undefined) throw new Error('fixture');
    const html = details({
      report: report({
        window: { since: '2026-10-03T15:00:00.000Z', until: '2026-11-02T15:00:00.000Z' },
        metrics: [
          metric(shipped.name, [{ ...base, series: [{ day: '2026-10-03', value: 4, n: 4 }] }]),
        ],
      }),
    });
    expect(html).toContain('<circle cx="0"');
  });

  test('a calibration shows in its box at the exact identity, not as its own row', () => {
    const html = details({
      report: report({ metrics: [flagged, catchRate([JUDGE])] }),
      calibrations: report({
        metrics: [flagged, catchRate([{ instrument: 'judge-v1', measured_by: [] }, JUDGE])],
      }),
    });
    expect(html).not.toContain('data-metric="demo.items_flagged_catch_rate"');
    const box = html.slice(html.indexOf('data-measured="demo.items_flagged"'));
    expect(box).toContain('How Flagged items is measured');
    expect(box).toContain('Measured by judge-v2 on claude/model-a@high');
    expect(box).toContain('demo.items_flagged_catch_rate: 90% from 10 records');
    expect(box).toContain(
      'Judge catches 9 of 10 labelled cases (90%); below 80% the share is rough.'
    );
  });

  test('a calibration from another version is named as not calibrated', () => {
    const html = details({
      report: report({ metrics: [flagged] }),
      calibrations: report({ metrics: [catchRate([{ ...JUDGE, instrument: 'judge-v1' }])] }),
    });
    expect(html).toContain('demo.items_flagged_catch_rate: not calibrated for this version');
    expect(html).not.toContain('90% from');
  });

  test('a calibration whose metric has no records anywhere still shows its score', () => {
    const html = details({ report: report({ metrics: [catchRate([JUDGE])] }) });
    expect(html).toContain('which has no records in this window: 90% from 10 records.');
  });

  test('older instruments are named as hidden', () => {
    const older = instrument(0.5, { instrument: 'judge-v1', measured_by: ['codex/b'] });
    const [headline] = flagged.instruments;
    if (headline === undefined) throw new Error('fixture');
    const html = details({
      report: report({ metrics: [metric(flagged.name, [headline, older])] }),
    });
    expect(html).toContain('Hidden: judge-v1 on codex/b (older)');
  });

  test('a refusal banner names both definitions and links the run', () => {
    const html = details({
      report: report({
        refused: [
          {
            reason: 'definition_conflict',
            run_id: 'run-abcdef123456',
            workflow_name: 'count-items',
            node_id: 'count',
            completed_at: '2026-11-01T10:00:00.000Z',
            name: 'demo.items_shipped',
            definition: { kind: 'count', unit: 'items', calibrates: null },
            offered: { kind: 'score', unit: 'ratio', calibrates: null },
          },
        ],
      }),
    });
    expect(html).toContain('role="alert"');
    expect(html).toContain('count-items/count');
    expect(html).toContain(
      'offered demo.items_shipped as score in ratio, but it is defined as count in items.'
    );
    expect(html).toContain('href="/console/r/run-abcdef123456"');
  });
});

// R3: the page's scope and window reach the requests it makes.
describe('requests', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('a project and window become the keys and URLs the page loads', async () => {
    const urls: string[] = [];
    globalThis.fetch = Object.assign(
      (input: RequestInfo | URL) => {
        urls.push(String(input));
        return Promise.resolve(Response.json({}));
      },
      { preconnect: originalFetch.preconnect }
    );
    const scoped = metricsRequests('cb-1', 7);
    const all = metricsRequests('all', 90);
    expect([scoped.report.key, scoped.calibration.key, scoped.views.key]).toEqual([
      'metrics:project:cb-1:7d',
      'metrics:project:cb-1:365d',
      'metric-views:project:cb-1',
    ]);
    for (const request of [scoped.report, scoped.calibration, scoped.views, all.report, all.views])
      await request.load();
    expect(urls).toEqual([
      '/api/metrics?since=7d&codebaseId=cb-1',
      '/api/metrics?since=365d&codebaseId=cb-1',
      '/api/metric-views?codebaseId=cb-1',
      '/api/metrics?since=90d',
      '/api/metric-views',
    ]);
  });

  test('the window parameter picks 7, 30 or 90 days and defaults to a week', () => {
    expect(parseWindow('30d')).toBe(30);
    expect(parseWindow('90d')).toBe(90);
    expect(parseWindow('bogus')).toBe(7);
    expect(parseWindow(null)).toBe(7);
  });
});
