import type { ReactElement, ReactNode } from 'react';
import { Link } from 'react-router';
import { EmptyState } from '../../components/EmptyState';
import type { MetricViews, MetricsReport } from '../../skills/metrics';
import {
  buildCard,
  formatNumber,
  formatShare,
  formatUsd,
  type CardModel,
  type CostPerCard,
  type CountCard,
  type RatioCard,
} from './model';

interface MetricsOverviewProps {
  report: MetricsReport;
  calibrations: MetricsReport;
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
  return (
    <div className="flex flex-col gap-4">
      {report.refused.length > 0 ? (
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
                <Card key={i} card={buildCard(view, report, calibrations)} />
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

function Card({ card }: { card: CardModel }): ReactElement {
  return (
    <article
      className="flex flex-col gap-2 rounded-[12px] border border-border px-5 py-4"
      data-card={card.shape}
    >
      <h3 className="text-[12px] font-medium text-text-secondary">{card.title}</h3>
      {card.shape === 'count' ? <CountBody card={card} /> : null}
      {card.shape === 'ratio' ? <RatioBody card={card} /> : null}
      {card.shape === 'cost_per' ? <CostPerBody card={card} /> : null}
    </article>
  );
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

const NOT_RECORDED = (
  <>
    <Figure>—</Figure>
    <Line>not recorded</Line>
  </>
);

function CountBody({ card }: { card: CountCard }): ReactElement {
  if (card.state === 'not_recorded') return NOT_RECORDED;
  return (
    <>
      <Figure>{formatNumber(card.value)}</Figure>
      {card.breakdown.length > 0 ? (
        <Line>
          {card.breakdown
            .map(({ label, value }) =>
              value === null ? `${label} not recorded` : `${formatNumber(value)} ${label}`
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
        {calibration?.state === 'calibrated' && calibration.rough ? (
          <Pill>rough</Pill>
        ) : calibration?.state === 'not_calibrated' ? (
          <Pill>not calibrated</Pill>
        ) : null}
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

function Pill({ children }: { children: ReactNode }): ReactElement {
  return (
    <span className="rounded border border-warning/40 bg-warning/10 px-1.5 py-0.5 text-[11px] text-warning">
      {children}
    </span>
  );
}

const COST_LINES: Record<Exclude<CostPerCard['state'], 'value'>, string> = {
  not_recorded: 'not recorded',
  nothing_counted: 'nothing counted',
  cost_unrecorded: 'most runs record no cost',
};

function CostPerBody({ card }: { card: CostPerCard }): ReactElement {
  if (card.state === 'value') return <Figure>{formatUsd(card.usd)}</Figure>;
  return (
    <>
      <Figure>—</Figure>
      <Line>{COST_LINES[card.state]}</Line>
    </>
  );
}
