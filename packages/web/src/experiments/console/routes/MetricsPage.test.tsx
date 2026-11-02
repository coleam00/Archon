import { afterEach, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { MetricsPage } from './MetricsPage';
import { invalidate, set } from '../store/cache';
import { K } from '../store/keys';
import type { MetricsReport } from '../skills/metrics';

type Metric = MetricsReport['metrics'][number];
type Instrument = Metric['instruments'][number];

afterEach(() => {
  invalidate('metrics');
});

const WINDOW = { since: '2026-10-03T00:00:00.000Z', until: '2026-11-02T00:00:00.000Z' };

function instrument(
  value: number,
  identity: Pick<Instrument, 'instrument' | 'measured_by'>
): Instrument {
  return {
    ...identity,
    value,
    n: 12,
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

const JUDGE = { instrument: 'judge-v2', measured_by: ['claude/model-a@high'] };

const counted: Metric = {
  name: 'demo.items_shipped',
  kind: 'count',
  unit: 'items',
  calibrates: null,
  headline_instrument: null,
  headline_measured_by: [],
  instruments: [instrument(12, { instrument: null, measured_by: [] })],
};

const judged: Metric = {
  name: 'demo.items_flagged',
  kind: 'score',
  unit: 'ratio',
  calibrates: null,
  headline_instrument: JUDGE.instrument,
  headline_measured_by: JUDGE.measured_by,
  instruments: [{ ...instrument(0.25, JUDGE), interval: { low: 0.1, high: 0.4 } }],
};

function agreement(identities: Pick<Instrument, 'instrument' | 'measured_by'>[]): Metric {
  return {
    name: 'demo.items_flagged_agreement',
    kind: 'score',
    unit: 'ratio',
    calibrates: judged.name,
    headline_instrument: identities[0]?.instrument ?? null,
    headline_measured_by: identities[0]?.measured_by ?? [],
    instruments: identities.map((identity, i) => instrument(i === 0 ? 0.83 : 0.41, identity)),
  };
}

function render(report: Partial<MetricsReport>): string {
  set(K.metrics('all', '30d'), { window: WINDOW, metrics: [], refused: [], ...report });
  return renderToStaticMarkup(
    <MemoryRouter>
      <MetricsPage />
    </MemoryRouter>
  );
}

test('a count row renders its value, n and sparkline', () => {
  const html = render({ metrics: [counted] });
  const row = html.slice(html.indexOf('data-metric="demo.items_shipped"'));
  expect(row).toContain('count · items');
  expect(row).toContain('>12<');
  expect(row).toContain('≥ $1.50');
  expect(row).toContain('1 without cost');
  expect(row).toContain('<polyline');
  expect(row).toContain('2 days with records');
});

test("the sparkline keeps a record from the window's first, partial day inside the chart", () => {
  const firstDay = {
    ...instrument(12, { instrument: null, measured_by: [] }),
    series: [{ day: '2026-10-03', value: 4, n: 4 }],
  };
  const html = render({
    window: { since: '2026-10-03T15:00:00.000Z', until: '2026-11-02T15:00:00.000Z' },
    metrics: [{ ...counted, instruments: [firstDay] }],
  });
  expect(html).toContain('<circle cx="0"');
});

test('an agreement shows as a badge on the calibrated row, not as its own row', () => {
  const html = render({ metrics: [counted, judged, agreement([JUDGE])] });
  expect(html).not.toContain('data-metric="demo.items_flagged_agreement"');
  const row = html.slice(html.indexOf('data-metric="demo.items_flagged"'));
  expect(row).toContain('data-calibration');
  expect(row).toContain('demo.items_flagged_agreement 0.83 (n=12)');
  expect(row).toContain('0.1 – 0.4');
  expect(row).not.toContain('not calibrated');
});

test.each([
  ['another judge version', { instrument: 'judge-v1', measured_by: JUDGE.measured_by }],
  ['the same judge on other models', { instrument: JUDGE.instrument, measured_by: ['codex/b'] }],
])('an agreement from %s shows "not calibrated"', (_label, other) => {
  const html = render({ metrics: [judged, agreement([other])] });
  expect(html).toContain('not calibrated');
  expect(html).not.toContain('data-calibration');
  expect(html).not.toContain('0.83');
});

test('a calibration beside other identities picks only the headline identity', () => {
  const html = render({
    metrics: [judged, agreement([{ instrument: 'judge-v1', measured_by: [] }, JUDGE])],
  });
  expect(html).toContain('demo.items_flagged_agreement 0.41 (n=12)');
  expect(html).not.toContain('0.83');
});

test('a metric with several instruments names the others', () => {
  const older = instrument(0.5, { instrument: 'judge-v1', measured_by: ['codex/b'] });
  const html = render({ metrics: [{ ...judged, instruments: [older, ...judged.instruments] }] });
  expect(html).toContain('Also measured by judge-v1 on codex/b');
  expect(html).toContain('judge-v2 on claude/model-a@high');
});

test('a refusal banner names both definitions and links the run', () => {
  const html = render({
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
  });
  expect(html).toContain('role="alert"');
  expect(html).toContain('count-items/count');
  expect(html).toContain(
    'offered demo.items_shipped as score in ratio, but it is defined as count in items.'
  );
  expect(html).toContain('href="/console/r/run-abcdef123456"');
});
