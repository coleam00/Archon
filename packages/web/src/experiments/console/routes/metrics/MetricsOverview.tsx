import type { ReactElement, ReactNode } from 'react';
import { Link } from 'react-router';
import { EmptyState } from '../../components/EmptyState';
import type { MetricViews, MetricsReport } from '../../skills/metrics';
import {
  buildCard,
  calibrationSentence,
  cardMetric,
  formatNumber,
  formatShare,
  formatUsd,
  metricAnchor,
  plainNames,
  type Calibrations,
  type Calibration,
  type CardModel,
  type CostPerCard,
  type CountCard,
  type RatioCard,
} from './model';

interface MetricsOverviewProps {
  /** `undefined` before any window has loaded: the cards show their titles over skeletons. */
  report: MetricsReport | undefined;
  calibrations: Calibrations;
  views: MetricViews;
  detailsPath: string;
}

/** The cards packs declare, and nothing else: explanations live on the Details screen. */
export function MetricsOverview({
  report,
  calibrations,
  views,
  detailsPath,
}: MetricsOverviewProps): ReactElement {
  const packs = views.packs.filter(pack => pack.cards.length > 0);
  const names = plainNames(views);
  return (
    <div className="flex flex-col gap-4">
      {report !== undefined && report.refused.length > 0 ? (
        <Alert>
          {report.refused.length.toString()} metric output
          {report.refused.length === 1 ? '' : 's'} refused ·{' '}
          <Link to={detailsPath} className="underline">
            Details
          </Link>
        </Alert>
      ) : null}
      {views.errors.map(error => (
        <Alert key={`${error.source}:${error.pack}`}>
          The {error.source} pack {error.pack} declares cards that could not be read: {error.error}
        </Alert>
      ))}
      {packs.length === 0 ? (
        <EmptyState
          title="No pack declares overview cards."
          action={
            <Link to={detailsPath} className="text-[12px] text-accent-bright underline">
              Details
            </Link>
          }
        />
      ) : (
        packs.map(pack => (
          <div key={`${pack.source}:${pack.pack}`} className="flex flex-col gap-2">
            {packs.length > 1 ? (
              <h2 className="font-mono text-[11px] uppercase tracking-[0.1em] text-text-tertiary">
                {pack.pack}
              </h2>
            ) : null}
            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              {pack.cards.map((view, i) => (
                <Link
                  key={i}
                  to={`${detailsPath}#${metricAnchor(cardMetric(view))}`}
                  className="flex flex-col gap-2 rounded-[12px] border border-border px-5 py-4 transition-colors hover:border-border-bright"
                  data-card={view.shape}
                >
                  <h3 className="text-[12px] font-medium text-text-secondary">{view.title}</h3>
                  {report === undefined ? (
                    SKELETON
                  ) : (
                    <CardBody card={buildCard(view, report, calibrations)} names={names} />
                  )}
                </Link>
              ))}
            </div>
          </div>
        ))
      )}
    </div>
  );
}

function Alert({ children }: { children: ReactNode }): ReactElement {
  return (
    <p
      role="alert"
      className="rounded border border-error/40 bg-error/10 px-4 py-2 text-[12.5px] text-error"
    >
      {children}
    </p>
  );
}

const SKELETON = (
  <div aria-hidden className="flex animate-pulse flex-col gap-2">
    <div className="h-[34px] w-20 rounded bg-surface-inset" />
    <div className="h-3 w-40 rounded bg-surface-inset" />
  </div>
);

function CardBody({
  card,
  names,
}: {
  card: CardModel;
  names: ReadonlyMap<string, string>;
}): ReactElement {
  if (card.shape === 'count') return <CountBody card={card} names={names} />;
  if (card.shape === 'ratio') return <RatioBody card={card} />;
  return <CostPerBody card={card} />;
}

function Figure({ children }: { children: ReactNode }): ReactElement {
  return (
    <div className="font-mono text-[34px] leading-none tabular-nums text-text-primary">
      {children}
    </div>
  );
}

function Line({ children }: { children: ReactNode }): ReactElement {
  return <div className="text-[12px] text-text-tertiary">{children}</div>;
}

// "not recorded" read as a broken instrument; an empty window is what the records show.
const NO_RECORDS = 'no records in this window';

const NOT_RECORDED = (
  <>
    <Figure>—</Figure>
    <Line>{NO_RECORDS}</Line>
  </>
);

function CountBody({
  card,
  names,
}: {
  card: CountCard;
  names: ReadonlyMap<string, string>;
}): ReactElement {
  if (card.state === 'not_recorded') return NOT_RECORDED;
  return (
    <>
      <Figure>{formatNumber(card.value)}</Figure>
      {card.breakdown.length > 0 ? (
        <Line>
          {card.breakdown
            .map(({ metric, label, value }) =>
              value === null
                ? `no records of ${names.get(metric) ?? label}`
                : `${formatNumber(value)} ${label}`
            )
            .join(' · ')}
        </Line>
      ) : null}
    </>
  );
}

function RatioBody({ card }: { card: RatioCard }): ReactElement {
  if (card.state === 'not_recorded') return NOT_RECORDED;
  const { calibration } = card;
  return (
    <>
      <div className="flex items-center gap-2">
        <Figure>{card.share === null ? '—' : formatShare(card.share)}</Figure>
        {calibration === null ? null : <CalibrationPill calibration={calibration} />}
      </div>
      {card.share === null ? null : (
        <div className="h-1.5 overflow-hidden rounded-full bg-surface-inset">
          <div
            className="h-full bg-accent-bright"
            style={{ width: `${Math.min(card.share, 1) * 100}%` }}
          />
        </div>
      )}
      <Line>
        {card.share === null
          ? `${formatNumber(card.denominator)} ${card.denominatorLabel}`
          : `${formatNumber(card.numerator)} of ${formatNumber(card.denominator)} ${card.denominatorLabel}`}
        {calibration?.state === 'calibrated'
          ? ` · ${calibration.label} ${calibration.caught.toString()} of ${calibration.of.toString()}`
          : null}
      </Line>
    </>
  );
}

function CalibrationPill({ calibration }: { calibration: Calibration }): ReactElement | null {
  if (calibration.state === 'calibrated') {
    return calibration.rough ? <Pill title={calibrationSentence(calibration)}>rough</Pill> : null;
  }
  if (calibration.state === 'not_calibrated') return <Pill>not calibrated</Pill>;
  if (calibration.state === 'loading') return <Pill>calibration loading</Pill>;
  return <Pill title={calibration.message}>calibration unavailable</Pill>;
}

function Pill({ children, title }: { children: ReactNode; title?: string }): ReactElement {
  return (
    <span
      title={title}
      className="rounded border border-warning/40 bg-warning/10 px-1.5 py-0.5 text-[11px] text-warning"
    >
      {children}
    </span>
  );
}

function CostPerBody({ card }: { card: CostPerCard }): ReactElement {
  if (card.state === 'not_recorded') return NOT_RECORDED;
  if (card.state === 'nothing_counted') {
    return (
      <>
        <Figure>—</Figure>
        <Line>nothing counted</Line>
      </>
    );
  }
  const coverage = `${card.runsWithCost.toString()} of ${card.runs.toString()} runs record cost`;
  return (
    <>
      <Figure>{card.state === 'value' ? formatUsd(card.usd) : '—'}</Figure>
      <Line>{coverage}</Line>
    </>
  );
}
