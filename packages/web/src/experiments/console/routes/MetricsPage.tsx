import { useState, type ReactElement } from 'react';
import { Link, useParams } from 'react-router';
import { EmptyState } from '../components/EmptyState';
import { ProjectViewTabs } from '../components/ProjectViewTabs';
import { useEntity } from '../store/cache';
import { K, type Scope } from '../store/keys';
import * as skill from '../skills';
import { runDetailPath } from '../primitives/run';
import type { MetricsReport } from '../skills/metrics';
import type { Project } from '../primitives/project';

type MetricReport = MetricsReport['metrics'][number];
type InstrumentReport = MetricReport['instruments'][number];
type Identity = Pick<InstrumentReport, 'instrument' | 'measured_by'>;
type Refusal = MetricsReport['refused'][number];
type Definition = Extract<Refusal, { reason: 'definition_conflict' }>['definition'];

const WINDOW_DAYS = [7, 30, 90] as const;
type WindowDays = (typeof WINDOW_DAYS)[number];

/** An instrument's identity is its declared instrument and the models that measured it; both must match. */
function sameIdentity(a: Identity, b: Identity): boolean {
  return (
    a.instrument === b.instrument &&
    a.measured_by.length === b.measured_by.length &&
    a.measured_by.every((model, i) => model === b.measured_by[i])
  );
}

function headlineIdentity(metric: MetricReport): Identity {
  return { instrument: metric.headline_instrument, measured_by: metric.headline_measured_by };
}

function identityLabel(identity: Identity): string {
  const instrument = identity.instrument ?? 'no instrument';
  return identity.measured_by.length === 0
    ? instrument
    : `${instrument} on ${identity.measured_by.join(', ')}`;
}

/** Two decimals, except a nonzero value below 0.01 keeps two significant digits rather than showing 0. */
const formatNumber = (value: number): string =>
  value !== 0 && Math.abs(value) < 0.01
    ? value.toLocaleString('en-US', { maximumSignificantDigits: 2 })
    : value.toLocaleString('en-US', { maximumFractionDigits: 2 });

function definitionLabel(definition: Definition): string {
  const calibrates = definition.calibrates === null ? '' : `, calibrates ${definition.calibrates}`;
  return `${definition.kind} in ${definition.unit}${calibrates}`;
}

interface Row {
  metric: MetricReport;
  headline: InstrumentReport;
  /** Score metrics that name this one in `calibrates`. */
  calibrators: MetricReport[];
}

/**
 * One row per metric, except a calibration that nothing calibrates in turn: that one shows
 * only on its calibrated metric's row. The engine always reports the headline identity among
 * a metric's instruments.
 */
function buildRows(report: MetricsReport): Row[] {
  return report.metrics.flatMap(metric => {
    const calibrators = report.metrics.filter(other => other.calibrates === metric.name);
    if (metric.calibrates !== null && calibrators.length === 0) return [];
    const identity = headlineIdentity(metric);
    const headline = metric.instruments.find(instrument => sameIdentity(instrument, identity));
    if (headline === undefined) return [];
    return [{ metric, headline, calibrators }];
  });
}

export function MetricsPage(): ReactElement {
  const { projectId } = useParams<{ projectId?: string }>();
  const scope: Scope = projectId ?? 'all';
  const [days, setDays] = useState<WindowDays>(30);
  const since = `${days.toString()}d`;
  const { data, loading, error } = useEntity<MetricsReport>(K.metrics(scope, since), () =>
    skill.getMetrics(scope === 'all' ? { since } : { since, codebaseId: scope })
  );
  const { data: project } = useEntity<Project | null>(
    scope === 'all' ? 'noop:scope-all' : K.project(scope),
    () => (scope === 'all' ? Promise.resolve(null) : skill.getProject(scope))
  );

  return (
    <section className="flex h-full flex-col">
      <MetricsHeader scope={scope} project={project} days={days} onDaysChange={setDays} />
      <div className="flex-1 overflow-y-auto px-[30px] pb-[30px] pt-[22px]">
        <MetricsBody report={data} loading={loading} error={error} days={days} scope={scope} />
      </div>
    </section>
  );
}

interface MetricsHeaderProps {
  scope: Scope;
  project: Project | null | undefined;
  days: WindowDays;
  onDaysChange: (days: WindowDays) => void;
}

function MetricsHeader({ scope, project, days, onDaysChange }: MetricsHeaderProps): ReactElement {
  const heading = scope === 'all' ? 'Metrics' : (project?.name ?? 'Project');
  return (
    <header className="flex flex-col gap-3 border-b border-border px-6 py-4">
      <div className="flex items-baseline justify-between gap-4">
        <div className="min-w-0">
          <h1 className="truncate text-base font-medium text-text-primary">{heading}</h1>
          <p className="text-xs text-text-tertiary">
            {scope === 'all'
              ? 'Metric records from every project.'
              : `Metric records from ${project?.path ?? 'this project'}.`}
          </p>
        </div>
        <div role="group" aria-label="Window" className="flex shrink-0 items-center gap-1">
          {WINDOW_DAYS.map(option => (
            <button
              key={option}
              type="button"
              aria-pressed={option === days}
              onClick={() => {
                onDaysChange(option);
              }}
              className={`rounded px-2 py-1 font-mono text-[11px] transition-colors ${
                option === days
                  ? 'bg-surface-elevated text-text-primary'
                  : 'text-text-tertiary hover:text-text-primary'
              }`}
            >
              {option}d
            </button>
          ))}
        </div>
      </div>
      {scope === 'all' ? null : <ProjectViewTabs projectId={scope} active="metrics" />}
    </header>
  );
}

interface MetricsBodyProps {
  report: MetricsReport | undefined;
  loading: boolean;
  error: Error | undefined;
  days: WindowDays;
  scope: Scope;
}

function MetricsBody({ report, loading, error, days, scope }: MetricsBodyProps): ReactElement {
  if (error !== undefined) {
    return <EmptyState title="Could not load metrics." hint={error.message} />;
  }
  if (loading || report === undefined) return <EmptyState title="Loading…" />;
  const rows = buildRows(report);
  return (
    <div className="flex flex-col gap-4">
      <RefusalBanner refused={report.refused} scope={scope} />
      {rows.length === 0 ? (
        <EmptyState title={`No headline metrics in the last ${days.toString()} days.`} />
      ) : (
        <MetricsTable rows={rows} window={report.window} />
      )}
      <UnmatchedCalibrations report={report} />
    </div>
  );
}

function RefusalBanner({
  refused,
  scope,
}: {
  refused: MetricsReport['refused'];
  scope: Scope;
}): ReactElement | null {
  if (refused.length === 0) return null;
  return (
    <div
      role="alert"
      className="rounded border border-error/40 bg-error/10 px-4 py-3 text-[12.5px]"
    >
      <p className="font-medium text-error">
        {refused.length.toString()} metric output{refused.length === 1 ? ' was' : 's were'} refused
      </p>
      <ul className="mt-2 flex flex-col gap-1 text-text-secondary">
        {refused.map((refusal, i) => (
          // One node output can refuse several records with the same run, node and time.
          <li key={i}>
            <span className="font-mono">
              {refusal.workflow_name}/{refusal.node_id}
            </span>{' '}
            {refusalText(refusal)}{' '}
            <Link
              to={runDetailPath({ id: refusal.run_id, projectId: scope === 'all' ? null : scope })}
              className="text-accent-bright underline"
            >
              run {refusal.run_id.slice(0, 8)}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

function refusalText(refusal: Refusal): string {
  if (refusal.reason === 'invalid') return `emitted invalid records: ${refusal.errors.join('; ')}.`;
  return `offered ${refusal.name} as ${definitionLabel(refusal.offered)}, but it is defined as ${definitionLabel(refusal.definition)}.`;
}

const HEADER_CELL =
  'px-3 py-2 text-left font-mono text-[10.5px] font-bold uppercase tracking-[0.1em]';

function MetricsTable({
  rows,
  window,
}: {
  rows: Row[];
  window: MetricsReport['window'];
}): ReactElement {
  return (
    <div className="overflow-x-auto rounded-[12px] border border-border">
      <table className="w-full border-collapse text-[12.5px]">
        <thead className="bg-surface-inset/60 text-text-tertiary">
          <tr>
            <th className={HEADER_CELL}>Metric</th>
            <th className={HEADER_CELL}>Value</th>
            <th className={HEADER_CELL}>n</th>
            <th className={HEADER_CELL}>95% interval</th>
            <th className={HEADER_CELL}>Cost</th>
            <th className={HEADER_CELL}>Latest</th>
            <th className={HEADER_CELL}>Daily</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(row => (
            <MetricRow key={row.metric.name} row={row} window={window} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MetricRow({ row, window }: { row: Row; window: MetricsReport['window'] }): ReactElement {
  const { metric, headline } = row;
  const others = metric.instruments.filter(instrument => !sameIdentity(instrument, headline));
  return (
    <tr className="border-t border-border align-top text-text-secondary" data-metric={metric.name}>
      <td className="px-3 py-2">
        <div className="font-mono text-text-primary">{metric.name}</div>
        <div className="text-[11px] text-text-tertiary">
          {metric.kind} · {metric.unit}
          {headline.instrument === null ? null : ` · ${identityLabel(headline)}`}
        </div>
        <CalibrationBadge row={row} />
        {others.length > 0 ? (
          <div className="mt-1 text-[11px] text-text-tertiary">
            Also measured by {others.map(identityLabel).join('; ')}; shown: the newest.
          </div>
        ) : null}
      </td>
      <td className="px-3 py-2 font-mono tabular-nums text-text-primary">
        {formatNumber(headline.value)}
      </td>
      <td className="px-3 py-2 font-mono tabular-nums">{headline.n}</td>
      <td className="whitespace-nowrap px-3 py-2 font-mono tabular-nums">
        {headline.interval === null
          ? '—'
          : `${formatNumber(headline.interval.low)} – ${formatNumber(headline.interval.high)}`}
      </td>
      <td className="px-3 py-2">
        <CostCell cost={headline.cost} />
      </td>
      <td className="px-3 py-2 font-mono tabular-nums">
        {formatNumber(headline.latest.value)}
        <div className="text-[11px] text-text-tertiary">
          {headline.latest.at.slice(0, 10)}
          {headline.latest.subject === null ? null : ` · ${headline.latest.subject}`}
        </div>
      </td>
      <td className="px-3 py-2">
        <Sparkline series={headline.series} window={window} />
      </td>
    </tr>
  );
}

/**
 * The calibrating scores measured by exactly the headline's identity. Agreement from another
 * judge version, or from the same judge on other models, says nothing about these values.
 */
function CalibrationBadge({ row }: { row: Row }): ReactElement | null {
  if (row.calibrators.length === 0) return null;
  const matches = row.calibrators.flatMap(calibrator => {
    const instrument = calibrator.instruments.find(i => sameIdentity(i, row.headline));
    return instrument === undefined ? [] : [{ name: calibrator.name, instrument }];
  });
  if (matches.length === 0) {
    return (
      <div
        className="mt-1 inline-block rounded border border-warning/40 bg-warning/10 px-1.5 py-0.5 text-[11px] text-warning"
        title={identityLabel(row.headline)}
      >
        not calibrated
      </div>
    );
  }
  return (
    <div
      className="mt-1 inline-flex flex-wrap gap-x-2 rounded border border-success/40 bg-success/10 px-1.5 py-0.5 text-[11px] text-success"
      title={identityLabel(row.headline)}
      data-calibration
    >
      {matches.map(({ name, instrument }) => (
        <span key={name}>
          {name} {formatNumber(instrument.value)} (n={instrument.n})
        </span>
      ))}
    </div>
  );
}

function CostCell({ cost }: { cost: InstrumentReport['cost'] }): ReactElement {
  const gaps = [
    [cost.runs_without_cost, 'without cost'],
    [cost.runs_without_tokens, 'without tokens'],
    [cost.runs_partial_cost, 'partial'],
    [cost.runs_missing, 'missing'],
  ] as const;
  const tokens =
    cost.input_tokens === null
      ? 'no tokens recorded'
      : `${formatNumber(cost.input_tokens)} in / ${formatNumber(cost.output_tokens ?? 0)} out tokens`;
  return (
    <div title={`${tokens} over ${cost.runs.toString()} runs`}>
      <span className="font-mono tabular-nums">
        {cost.usd === null ? 'none' : `≥ $${cost.usd.toFixed(2)}`}
      </span>
      <div className="text-[11px] text-text-tertiary">
        {gaps
          .filter(([count]) => count > 0)
          .map(([count, label]) => `${count.toString()} ${label}`)
          .join(' · ')}
      </div>
    </div>
  );
}

const SPARK_WIDTH = 96;
const SPARK_HEIGHT = 24;
const DAY_MS = 86_400_000;

/** Daily values placed by date across the window; the line breaks at days without records. */
function Sparkline({
  series,
  window,
}: {
  series: InstrumentReport['series'];
  window: MetricsReport['window'];
}): ReactElement {
  // Series days are UTC-midnight buckets; the window starts at any time of day.
  const start = Date.parse(window.since.slice(0, 10));
  const span = Math.max(Date.parse(window.until) - start, 1);
  const values = series.map(point => point.value);
  const low = Math.min(0, ...values);
  const range = Math.max(...values, low + 1) - low;
  const points = series.map(point => ({
    time: Date.parse(point.day),
    x: ((Date.parse(point.day) - start) / span) * SPARK_WIDTH,
    y: SPARK_HEIGHT - 2 - ((point.value - low) / range) * (SPARK_HEIGHT - 4),
  }));
  const runs: (typeof points)[] = [];
  for (const point of points) {
    const run = runs.at(-1);
    const previous = run?.at(-1);
    if (run !== undefined && previous !== undefined && point.time - previous.time === DAY_MS) {
      run.push(point);
    } else {
      runs.push([point]);
    }
  }
  return (
    <svg
      role="img"
      aria-label={`${series.length.toString()} days with records`}
      width={SPARK_WIDTH}
      height={SPARK_HEIGHT}
      viewBox={`0 0 ${SPARK_WIDTH.toString()} ${SPARK_HEIGHT.toString()}`}
      className="text-accent-bright"
    >
      {runs.map(run => (
        <polyline
          key={run[0]?.time}
          points={run.map(({ x, y }) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
        />
      ))}
      {points.map(({ x, y }, i) => (
        <circle key={series[i]?.day} cx={x} cy={y} r={1.5} fill="currentColor" />
      ))}
    </svg>
  );
}

/** Calibrations whose calibrated metric has no records in this window still get shown, not dropped. */
function UnmatchedCalibrations({ report }: { report: MetricsReport }): ReactElement | null {
  const names = new Set(report.metrics.map(metric => metric.name));
  const orphans = report.metrics.filter(
    metric => metric.calibrates !== null && !names.has(metric.calibrates)
  );
  if (orphans.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1 text-[12px] text-text-tertiary">
      {orphans.map(metric => (
        <li key={metric.name}>
          <span className="font-mono">{metric.name}</span> calibrates{' '}
          <span className="font-mono">{metric.calibrates}</span>, which has no records in this
          window.
        </li>
      ))}
    </ul>
  );
}
