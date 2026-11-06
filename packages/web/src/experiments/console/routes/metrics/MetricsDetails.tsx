import { useEffect, type ReactElement } from 'react';
import { Link, useLocation } from 'react-router';
import { EmptyState } from '../../components/EmptyState';
import { runDetailPath } from '../../primitives/run';
import type { MetricViews, MetricsReport } from '../../skills/metrics';
import type { Scope } from '../../store/keys';
import {
  calibrationSentence,
  declaredCalibration,
  declaredMetrics,
  formatFigure,
  formatNumber,
  formatUsd,
  formatValue,
  headlineIdentity,
  headlineOf,
  identityLabel,
  metricAnchor,
  plainNames,
  sameIdentity,
  type InstrumentReport,
  type MetricReport,
  type WindowDays,
} from './model';

type Refusal = MetricsReport['refused'][number];
type Definition = Extract<Refusal, { reason: 'definition_conflict' }>['definition'];

interface MetricsDetailsProps {
  report: MetricsReport;
  calibrations: MetricsReport;
  views: MetricViews;
  days: WindowDays;
  scope: Scope;
}

/** `empty` is a metric a card reads that has no records in the window. */
type Row =
  | { state: 'measured'; name: string; metric: MetricReport; headline: InstrumentReport }
  | { state: 'empty'; name: string };

/**
 * One row per measurement, and one per metric a card reads that has none, so a card saying
 * "no records" leads to a row saying the same. Calibrations show in the boxes under the
 * table, not as rows.
 */
function buildRows(report: MetricsReport, views: MetricViews): Row[] {
  const measured = report.metrics.flatMap((metric): Row[] => {
    if (metric.calibrates !== null) return [];
    const headline = headlineOf(metric);
    return headline === undefined
      ? []
      : [{ state: 'measured', name: metric.name, metric, headline }];
  });
  const recorded = new Set(report.metrics.map(metric => metric.name));
  const empty = declaredMetrics(views)
    .filter(name => !recorded.has(name))
    .map((name): Row => ({ state: 'empty', name }));
  return [...measured, ...empty].sort((a, b) => a.name.localeCompare(b.name));
}

export function MetricsDetails({
  report,
  calibrations,
  views,
  days,
  scope,
}: MetricsDetailsProps): ReactElement {
  const names = plainNames(views);
  const nameOf = (metric: string): string => names.get(metric) ?? metric;
  const rows = buildRows(report, views);
  const { hash } = useLocation();
  // A card links here at its metric's row; the router does not scroll to a hash itself.
  useEffect(() => {
    if (hash !== '') document.getElementById(decodeURIComponent(hash.slice(1)))?.scrollIntoView();
  }, [hash]);
  // A calibrated metric absent from this window still gets its box, from the year's records.
  const calibrated = [...report.metrics, ...calibrations.metrics].filter(
    (metric, i, all) =>
      all.findIndex(other => other.name === metric.name) === i &&
      calibrations.metrics.some(other => other.calibrates === metric.name)
  );
  return (
    <div className="flex flex-col gap-4">
      <RefusalBanner refused={report.refused} scope={scope} />
      {rows.length === 0 ? (
        <EmptyState title={`No measurements in the last ${days.toString()} days.`} />
      ) : (
        <MetricsTable
          rows={rows}
          report={report}
          days={days}
          nameOf={nameOf}
          target={decodeURIComponent(hash.slice(1))}
        />
      )}
      {calibrated.map(metric => (
        <MeasuredBox
          key={metric.name}
          metric={metric}
          calibrations={calibrations}
          views={views}
          nameOf={nameOf}
        />
      ))}
      <UnmatchedCalibrations report={report} />
    </div>
  );
}

function definitionLabel(definition: Definition): string {
  const calibrates = definition.calibrates === null ? '' : `, calibrates ${definition.calibrates}`;
  return `${definition.kind} in ${definition.unit}${calibrates}`;
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
  report,
  days,
  nameOf,
  target,
}: {
  rows: Row[];
  report: MetricsReport;
  days: WindowDays;
  nameOf: (metric: string) => string;
  /** The row id the URL's hash names, highlighted when a card linked here. */
  target: string;
}): ReactElement {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="overflow-x-auto rounded-[12px] border border-border">
        <table className="w-full border-collapse text-[12.5px]">
          <thead className="bg-surface-inset/60 text-text-tertiary">
            <tr>
              <th className={HEADER_CELL}>What</th>
              <th className={HEADER_CELL}>Last {days.toString()} days</th>
              <th className={HEADER_CELL}>Based on</th>
              <th className={HEADER_CELL}>Known cost</th>
              <th className={HEADER_CELL}>Latest</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(row => (
              <MetricRow
                key={row.name}
                row={row}
                window={report.window}
                name={nameOf(row.name)}
                targeted={target === metricAnchor(row.name)}
              />
            ))}
          </tbody>
        </table>
      </div>
      <p className={SMALL}>
        Known cost is the cost of the runs that produced a metric's records. Metrics recorded by the
        same runs show the same cost, so the column does not add up.
      </p>
    </div>
  );
}

const SMALL = 'text-[11px] text-text-tertiary';

function MetricRow({
  row,
  window,
  name,
  targeted,
}: {
  row: Row;
  window: MetricsReport['window'];
  name: string;
  targeted: boolean;
}): ReactElement {
  const rowProps = {
    id: metricAnchor(row.name),
    'data-metric': row.name,
    className: `scroll-mt-4 border-t border-border align-top text-text-secondary ${
      targeted ? 'bg-accent-bright/10' : ''
    }`,
  };
  const what = (
    <>
      <div className="text-text-primary">{name}</div>
      <div className={`font-mono ${SMALL}`}>{row.name}</div>
    </>
  );
  if (row.state === 'empty') {
    return (
      <tr {...rowProps}>
        <td className="px-3 py-2">{what}</td>
        <td colSpan={4} className={`px-3 py-2 ${SMALL}`}>
          no records in this window
        </td>
      </tr>
    );
  }
  const { metric, headline } = row;
  const hidden = metric.instruments.filter(instrument => !sameIdentity(instrument, headline));
  return (
    <tr {...rowProps}>
      <td className="px-3 py-2">
        {what}
        {headline.instrument === null ? null : (
          <div className={SMALL}>{identityLabel(headline)}</div>
        )}
        {hidden.length > 0 ? (
          <div className={SMALL}>
            Hidden: {hidden.map(instrument => `${identityLabel(instrument)} (older)`).join('; ')}
          </div>
        ) : null}
      </td>
      <td className="px-3 py-2">
        <div className="font-mono tabular-nums text-text-primary">
          {formatValue(headline.value, metric.unit)}
        </div>
        {headline.interval === null ? null : (
          <div className={`font-mono tabular-nums ${SMALL}`}>
            95%: {formatFigure(headline.interval.low, metric.unit)} –{' '}
            {formatFigure(headline.interval.high, metric.unit)}
          </div>
        )}
        <Sparkline series={headline.series} window={window} />
      </td>
      <td className="whitespace-nowrap px-3 py-2 tabular-nums">
        {headline.n.toString()} record{headline.n === 1 ? '' : 's'}
      </td>
      <td className="px-3 py-2">
        <CostCell cost={headline.cost} />
      </td>
      <td className="px-3 py-2 font-mono tabular-nums" title={headline.latest.subject ?? undefined}>
        {formatFigure(headline.latest.value, metric.unit)}
        <div className={SMALL}>{headline.latest.at.slice(0, 10)}</div>
      </td>
    </tr>
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
        {cost.usd === null ? 'none recorded' : formatUsd(cost.usd)}
      </span>
      <div className={SMALL}>
        {gaps
          .filter(([count]) => count > 0)
          .map(([count, label]) => `${count.toString()} ${label}`)
          .join(' · ')}
      </div>
    </div>
  );
}

/**
 * How a calibrated metric is measured: its headline instrument, each calibration recorded
 * at exactly that identity, and the older identities the table hides. Agreement from
 * another judge version, or from the same judge on other models, says nothing about it.
 */
function MeasuredBox({
  metric,
  calibrations,
  views,
  nameOf,
}: {
  metric: MetricReport;
  calibrations: MetricsReport;
  views: MetricViews;
  nameOf: (metric: string) => string;
}): ReactElement {
  const identity = headlineIdentity(metric);
  const declared = declaredCalibration(views, metric.name, identity, calibrations);
  const calibrators = calibrations.metrics.filter(other => other.calibrates === metric.name);
  const hidden = metric.instruments.filter(instrument => !sameIdentity(instrument, identity));
  return (
    <section
      className="flex flex-col gap-1 rounded-[12px] border border-border px-4 py-3 text-[12.5px] text-text-secondary"
      data-measured={metric.name}
    >
      <h2 className="text-[12px] font-medium text-text-primary">
        How {nameOf(metric.name)} is measured
      </h2>
      <p>Measured by {identityLabel(identity)}.</p>
      <ul className="flex flex-col gap-0.5">
        {calibrators.map(calibrator => {
          const score = calibrator.instruments.find(i => sameIdentity(i, identity));
          return (
            <li key={calibrator.name}>
              {nameOf(calibrator.name)}:{' '}
              {score === undefined
                ? 'not calibrated for this version'
                : `${formatFigure(score.value, calibrator.unit)} from ${score.n.toString()} records`}
            </li>
          );
        })}
      </ul>
      {declared?.state === 'calibrated' ? <p>{calibrationSentence(declared)}</p> : null}
      {hidden.length > 0 ? (
        <p className={SMALL}>Hidden older versions: {hidden.map(identityLabel).join('; ')}</p>
      ) : null}
    </section>
  );
}

const SPARK_WIDTH = 160;
const SPARK_HEIGHT = 32;
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
      className="mt-1 text-accent-bright"
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
      {orphans.map(metric => {
        const score = headlineOf(metric);
        return (
          <li key={metric.name}>
            <span className="font-mono">{metric.name}</span> calibrates{' '}
            <span className="font-mono">{metric.calibrates}</span>, which has no records in this
            window
            {score === undefined
              ? '.'
              : `: ${formatFigure(score.value, metric.unit)} from ${score.n.toString()} records.`}
          </li>
        );
      })}
    </ul>
  );
}
