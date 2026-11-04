/**
 * The metrics screens' data: which reports a scope and window fetch, and the display
 * model of each declared card. Every card figure comes from records of one instrument
 * identity; a figure the records do not support is a state, never a zero.
 */
import {
  getMetricViews,
  getMetrics,
  type MetricViews,
  type MetricsReport,
} from '../../skills/metrics';
import { ALL_SCOPE, K, type Scope } from '../../store/keys';

export type MetricReport = MetricsReport['metrics'][number];
export type InstrumentReport = MetricReport['instruments'][number];
export type Identity = Pick<InstrumentReport, 'instrument' | 'measured_by'>;
export type MetricView = MetricViews['packs'][number]['cards'][number];
type ViewOf<S extends MetricView['shape']> = Extract<MetricView, { shape: S }>;

export const WINDOW_DAYS = [7, 30, 90] as const;
export type WindowDays = (typeof WINDOW_DAYS)[number];

/** `?window=30d` names a window; anything else is the default week. */
export function parseWindow(value: string | null): WindowDays {
  return WINDOW_DAYS.find(days => `${days.toString()}d` === value) ?? 7;
}

/**
 * Calibrations are recorded when a pack calibrates its judge, not every week, so they are
 * read from a year of records. The exact identity match keeps an old calibration from
 * vouching for a different judge.
 */
const CALIBRATION_SINCE = '365d';

interface Request<T> {
  key: string;
  load: () => Promise<T>;
}

export function metricsRequests(
  scope: Scope,
  days: WindowDays
): {
  report: Request<MetricsReport>;
  calibration: Request<MetricsReport>;
  views: Request<MetricViews>;
} {
  const codebase = scope === ALL_SCOPE ? {} : { codebaseId: scope };
  const since = `${days.toString()}d`;
  return {
    report: { key: K.metrics(scope, since), load: () => getMetrics({ since, ...codebase }) },
    calibration: {
      key: K.metrics(scope, CALIBRATION_SINCE),
      load: () => getMetrics({ since: CALIBRATION_SINCE, ...codebase }),
    },
    views: { key: K.metricViews(scope), load: () => getMetricViews(codebase) },
  };
}

/** An instrument's identity is its declared instrument and the models that measured it; both must match. */
export function sameIdentity(a: Identity, b: Identity): boolean {
  return (
    a.instrument === b.instrument &&
    a.measured_by.length === b.measured_by.length &&
    a.measured_by.every((model, i) => model === b.measured_by[i])
  );
}

export function headlineIdentity(metric: MetricReport): Identity {
  return { instrument: metric.headline_instrument, measured_by: metric.headline_measured_by };
}

export function identityLabel(identity: Identity): string {
  const instrument = identity.instrument ?? 'no instrument';
  return identity.measured_by.length === 0
    ? instrument
    : `${instrument} on ${identity.measured_by.join(', ')}`;
}

/** The engine always reports the headline identity among a metric's instruments. */
export function headlineOf(metric: MetricReport): InstrumentReport | undefined {
  return instrumentAt(metric, headlineIdentity(metric));
}

function instrumentAt(
  metric: MetricReport | undefined,
  identity: Identity
): InstrumentReport | undefined {
  return metric?.instruments.find(instrument => sameIdentity(instrument, identity));
}

function find(report: MetricsReport, name: string): MetricReport | undefined {
  return report.metrics.find(metric => metric.name === name);
}

/** Two decimals, except a nonzero value below 0.01 keeps two significant digits rather than showing 0. */
export const formatNumber = (value: number): string =>
  value !== 0 && Math.abs(value) < 0.01
    ? value.toLocaleString('en-US', { maximumSignificantDigits: 2 })
    : value.toLocaleString('en-US', { maximumFractionDigits: 2 });

/** Every cost figure is a floor: runs that recorded no cost add nothing to it. */
export const formatUsd = (usd: number): string => `≥ $${formatNumber(usd)}`;

export type CountCard = { shape: 'count'; title: string } & (
  | { state: 'not_recorded' }
  | { state: 'value'; value: number; breakdown: { label: string; value: number | null }[] }
);

export type Calibration =
  | { state: 'calibrated'; label: string; caught: number; of: number; rough: boolean }
  | { state: 'not_calibrated' };

export type RatioCard = { shape: 'ratio'; title: string; denominatorLabel: string } & (
  | { state: 'not_recorded' }
  | {
      state: 'value';
      numerator: number;
      denominator: number;
      /** `null` when the denominator is 0. */
      share: number | null;
      /** `null` when the view declares no calibration. */
      calibration: Calibration | null;
    }
);

export type CostPerCard = { shape: 'cost_per'; title: string } & (
  | { state: 'not_recorded' }
  | { state: 'nothing_counted' }
  /** Most of the producing runs recorded no cost, so a per-item figure would mislead. */
  | { state: 'cost_unrecorded' }
  | { state: 'value'; usd: number }
);

export type CardModel = CountCard | RatioCard | CostPerCard;

export function buildCard(
  view: MetricView,
  report: MetricsReport,
  calibrations: MetricsReport
): CardModel {
  if (view.shape === 'count') return countCard(view, report);
  if (view.shape === 'ratio') return ratioCard(view, report, calibrations);
  return costPerCard(view, report);
}

export function countCard(view: ViewOf<'count'>, report: MetricsReport): CountCard {
  const metric = find(report, view.metric);
  const main = metric === undefined ? undefined : headlineOf(metric);
  if (main === undefined) return { shape: 'count', title: view.title, state: 'not_recorded' };
  const breakdown = (view.breakdown ?? []).map(({ metric: name, label }) => ({
    label,
    value: instrumentAt(find(report, name), main)?.value ?? null,
  }));
  return { shape: 'count', title: view.title, state: 'value', value: main.value, breakdown };
}

export function ratioCard(
  view: ViewOf<'ratio'>,
  report: MetricsReport,
  calibrations: MetricsReport
): RatioCard {
  const base = {
    shape: 'ratio',
    title: view.title,
    denominatorLabel: view.denominator_label,
  } as const;
  const numeratorMetric = find(report, view.numerator);
  const numerator = numeratorMetric === undefined ? undefined : headlineOf(numeratorMetric);
  const denominator = numerator && instrumentAt(find(report, view.denominator), numerator);
  if (numerator === undefined || denominator === undefined) {
    return { ...base, state: 'not_recorded' };
  }
  let calibration: Calibration | null = null;
  if (view.calibration !== undefined) {
    const calibrator = find(calibrations, view.calibration.metric);
    const score =
      calibrator?.calibrates === view.numerator ? instrumentAt(calibrator, numerator) : undefined;
    calibration =
      score === undefined
        ? { state: 'not_calibrated' }
        : {
            state: 'calibrated',
            label: view.calibration.label,
            // A calibration scores each labelled case 1 or 0, so its mean times n counts the catches.
            caught: Math.round(score.value * score.n),
            of: score.n,
            rough: score.value < view.calibration.rough_below,
          };
  }
  return {
    ...base,
    state: 'value',
    numerator: numerator.value,
    denominator: denominator.value,
    share: denominator.value === 0 ? null : numerator.value / denominator.value,
    calibration,
  };
}

export function costPerCard(view: ViewOf<'cost_per'>, report: MetricsReport): CostPerCard {
  const base = { shape: 'cost_per', title: view.title } as const;
  const metric = find(report, view.metric);
  const counted = metric === undefined ? undefined : headlineOf(metric);
  if (counted === undefined) return { ...base, state: 'not_recorded' };
  if (counted.value === 0) return { ...base, state: 'nothing_counted' };
  const { usd, runs, runs_without_cost } = counted.cost;
  if (usd === null || (runs - runs_without_cost) * 2 <= runs) {
    return { ...base, state: 'cost_unrecorded' };
  }
  return { ...base, state: 'value', usd: usd / counted.value };
}

/** Plain names for metrics; the first pack in listing order that names a metric wins. */
export function plainNames(views: MetricViews): ReadonlyMap<string, string> {
  const names = new Map<string, string>();
  for (const pack of views.packs) {
    for (const [metric, name] of Object.entries(pack.names)) {
      if (!names.has(metric)) names.set(metric, name);
    }
  }
  return names;
}

/** Two significant digits, so a small nonzero share never shows as 0%. */
export const formatShare = (share: number): string =>
  share.toLocaleString('en-US', { style: 'percent', maximumSignificantDigits: 2 });
