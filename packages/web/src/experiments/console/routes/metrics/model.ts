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

/** A card's counted slots read only counts: a score's mean is not a number of items. */
function findCount(report: MetricsReport, name: string): MetricReport | undefined {
  const metric = find(report, name);
  return metric?.kind === 'count' ? metric : undefined;
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
  | {
      state: 'value';
      value: number;
      /** `value` is `null` when `metric` has no records at the main figure's identity. */
      breakdown: { metric: string; label: string; value: number | null }[];
    }
);

/** The year of calibration records loads apart from the window, so cards that need none never wait. */
export type Calibrations =
  | { state: 'loading' }
  | { state: 'failed'; message: string }
  | { state: 'loaded'; report: MetricsReport };

export type Calibration =
  | {
      state: 'calibrated';
      label: string;
      caught: number;
      of: number;
      rough: boolean;
      roughBelow: number;
    }
  | { state: 'not_calibrated' }
  | { state: 'loading' }
  | { state: 'unavailable'; message: string };

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
  | ({ state: 'cost_unrecorded' } & CostCoverage)
  | ({ state: 'value'; usd: number } & CostCoverage)
);

/** How many of the producing runs recorded a cost, so the reader sees how far off the floor is. */
interface CostCoverage {
  runs: number;
  runsWithCost: number;
}

export type CardModel = CountCard | RatioCard | CostPerCard;

export function buildCard(
  view: MetricView,
  report: MetricsReport,
  calibrations: Calibrations
): CardModel {
  if (view.shape === 'count') return countCard(view, report);
  if (view.shape === 'ratio') return ratioCard(view, report, calibrations);
  return costPerCard(view, report);
}

export function countCard(view: ViewOf<'count'>, report: MetricsReport): CountCard {
  const metric = findCount(report, view.metric);
  const main = metric === undefined ? undefined : headlineOf(metric);
  if (main === undefined) return { shape: 'count', title: view.title, state: 'not_recorded' };
  const breakdown = (view.breakdown ?? []).map(({ metric: name, label }) => ({
    metric: name,
    label,
    value: instrumentAt(findCount(report, name), main)?.value ?? null,
  }));
  return { shape: 'count', title: view.title, state: 'value', value: main.value, breakdown };
}

export function ratioCard(
  view: ViewOf<'ratio'>,
  report: MetricsReport,
  calibrations: Calibrations
): RatioCard {
  const base = {
    shape: 'ratio',
    title: view.title,
    denominatorLabel: view.denominator_label,
  } as const;
  const numeratorMetric = findCount(report, view.numerator);
  const numerator = numeratorMetric === undefined ? undefined : headlineOf(numeratorMetric);
  const denominator = numerator && instrumentAt(findCount(report, view.denominator), numerator);
  if (numerator === undefined || denominator === undefined) {
    return { ...base, state: 'not_recorded' };
  }
  return {
    ...base,
    state: 'value',
    numerator: numerator.value,
    denominator: denominator.value,
    share: denominator.value === 0 ? null : numerator.value / denominator.value,
    calibration:
      view.calibration === undefined
        ? null
        : calibrationOf(view.numerator, view.calibration, numerator, calibrations),
  };
}

function calibrationOf(
  numerator: string,
  declared: NonNullable<ViewOf<'ratio'>['calibration']>,
  identity: Identity,
  calibrations: Calibrations
): Calibration {
  if (calibrations.state === 'loading') return { state: 'loading' };
  if (calibrations.state === 'failed') {
    return { state: 'unavailable', message: calibrations.message };
  }
  const calibrator = find(calibrations.report, declared.metric);
  const score =
    calibrator?.calibrates === numerator ? instrumentAt(calibrator, identity) : undefined;
  // A calibration scores each labelled case 1 or 0; a mean outside 0-1 breaks that contract
  // and would count more catches than cases.
  if (score === undefined || score.value < 0 || score.value > 1) {
    return { state: 'not_calibrated' };
  }
  return {
    state: 'calibrated',
    label: declared.label,
    caught: Math.round(score.value * score.n),
    of: score.n,
    rough: score.value < declared.rough_below,
    roughBelow: declared.rough_below,
  };
}

/**
 * The calibration a pack declares for `metric`'s share, at `identity`, for the Details box
 * that explains it. `undefined` when no declared ratio calibrates `metric`.
 */
export function declaredCalibration(
  views: MetricViews,
  metric: string,
  identity: Identity,
  calibrations: MetricsReport
): Calibration | undefined {
  for (const pack of views.packs) {
    for (const view of pack.cards) {
      if (view.shape === 'ratio' && view.numerator === metric && view.calibration !== undefined) {
        return calibrationOf(metric, view.calibration, identity, {
          state: 'loaded',
          report: calibrations,
        });
      }
    }
  }
  return undefined;
}

/** What "rough" means, from the declared threshold: the pill's title and the Details box say it. */
export function calibrationSentence(
  calibration: Extract<Calibration, { state: 'calibrated' }>
): string {
  const { label, caught, of, roughBelow } = calibration;
  const sentence = `${label} ${caught.toString()} of ${of.toString()} labelled cases (${formatShare(caught / of)}); below ${formatShare(roughBelow)} the share is rough.`;
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

export function costPerCard(view: ViewOf<'cost_per'>, report: MetricsReport): CostPerCard {
  const base = { shape: 'cost_per', title: view.title } as const;
  const metric = findCount(report, view.metric);
  const counted = metric === undefined ? undefined : headlineOf(metric);
  if (counted === undefined) return { ...base, state: 'not_recorded' };
  const costed =
    view.cost_of === undefined ? counted : instrumentAt(findCount(report, view.cost_of), counted);
  if (costed === undefined) return { ...base, state: 'not_recorded' };
  if (counted.value === 0) return { ...base, state: 'nothing_counted' };
  const { usd, runs, runs_without_cost } = costed.cost;
  const coverage = { runs, runsWithCost: runs - runs_without_cost };
  if (usd === null || coverage.runsWithCost * 2 <= runs) {
    return { ...base, state: 'cost_unrecorded', ...coverage };
  }
  return { ...base, state: 'value', usd: usd / counted.value, ...coverage };
}

/** The metric a card's Details link lands on. */
export function cardMetric(view: MetricView): string {
  return view.shape === 'ratio' ? view.numerator : view.metric;
}

/** The Details row id for a metric; a card links to `#` this. */
export const metricAnchor = (metric: string): string => `metric-${metric}`;

/**
 * Every metric a card reads, in declaration order. Details lists each one, so a card's
 * "no records" leads to a row that says the same. Calibrations show in their own boxes.
 */
export function declaredMetrics(views: MetricViews): string[] {
  const names = views.packs.flatMap(pack =>
    pack.cards.flatMap(view => {
      if (view.shape === 'count') {
        return [view.metric, ...(view.breakdown ?? []).map(({ metric }) => metric)];
      }
      if (view.shape === 'ratio') return [view.numerator, view.denominator];
      return view.cost_of === undefined ? [view.metric] : [view.metric, view.cost_of];
    })
  );
  return [...new Set(names)];
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

/** A value in its unit's terms: a `ratio` is a percentage, anything else a plain number. */
export const formatFigure = (value: number, unit: string): string =>
  unit === 'ratio' ? formatShare(value) : formatNumber(value);

/** `prs` is the guide's own example unit; other units read with their underscores as spaces. */
const UNIT_WORDS: Readonly<Record<string, string>> = { prs: 'PRs' };

/** A value with its unit in words: "99%", "2 PRs", "14 pull requests". */
export function formatValue(value: number, unit: string): string {
  if (unit === 'ratio') return formatShare(value);
  return `${formatNumber(value)} ${UNIT_WORDS[unit] ?? unit.replaceAll('_', ' ')}`;
}

const DAY_FORMAT: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };

/** "Oct 30 – Nov 6": the dates the report actually covers. */
export function windowDates(window: MetricsReport['window']): string {
  const since = new Date(window.since).toLocaleDateString('en-US', DAY_FORMAT);
  const until = new Date(window.until).toLocaleDateString('en-US', DAY_FORMAT);
  return `${since} – ${until}`;
}
