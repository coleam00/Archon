import { useState, type ReactElement, type ReactNode } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { EmptyState } from '../../components/EmptyState';
import { ProjectViewTabs } from '../../components/ProjectViewTabs';
import { useEntity, type EntityView } from '../../store/cache';
import { ALL_SCOPE, K, type Scope } from '../../store/keys';
import * as skill from '../../skills';
import type { MetricViews, MetricsReport } from '../../skills/metrics';
import type { Project } from '../../primitives/project';
import { MetricsDetails } from './MetricsDetails';
import { MetricsOverview } from './MetricsOverview';
import {
  metricsRequests,
  parseWindow,
  WINDOW_DAYS,
  type Calibrations,
  windowDates,
  type WindowDays,
} from './model';

export type MetricsView = 'overview' | 'details';

/** `/console[/p/:projectId]/metrics` and its `/details` screen, sharing `?window=`. */
export function MetricsPage({ view = 'overview' }: { view?: MetricsView }): ReactElement {
  const { projectId } = useParams<{ projectId?: string }>();
  const scope: Scope = projectId ?? ALL_SCOPE;
  const [searchParams] = useSearchParams();
  const days = parseWindow(searchParams.get('window'));
  const { data: project } = useEntity<Project | null>(
    scope === ALL_SCOPE ? 'noop:scope-all' : K.project(scope),
    () => (scope === ALL_SCOPE ? Promise.resolve(null) : skill.getProject(scope))
  );
  const requests = metricsRequests(scope, days);
  // A relative window moves with the clock, so a revisit reloads instead of showing the first fetch.
  const fresh = { revalidateOnSubscribe: true };
  const views = useEntity<MetricViews>(requests.views.key, requests.views.load, fresh);
  // A metrics query holds the server until it answers, and the views listing reads files, so
  // a listing sent beside the queries waits for them. The queries start once the cards are
  // known, so their titles show while the window loads.
  const waiting = views.data === undefined && views.error === undefined;
  const report = useEntity<MetricsReport | undefined>(
    waiting ? WAITING : requests.report.key,
    waiting ? wait : requests.report.load,
    fresh
  );
  const calibration = useEntity<MetricsReport | undefined>(
    waiting ? WAITING : requests.calibration.key,
    waiting ? wait : requests.calibration.load,
    fresh
  );
  const shown = useShownReport(scope, days, report.data);
  // The cache keeps an error until its reload settles, so an error being retried reads as
  // loading until then; a failed retry is a new error and shows again.
  const [retrying, setRetrying] = useState<ReadonlySet<Error>>(new Set());
  const failing = (entity: { error: Error | undefined }): boolean =>
    entity.error !== undefined && !retrying.has(entity.error);
  const needed = view === 'details' ? [views, report, calibration] : [views, report];
  const failed = needed.filter(failing);
  const retry = (): void => {
    setRetrying(new Set(failed.flatMap(entity => entity.error ?? [])));
    for (const entity of failed) entity.refetch();
  };

  const heading = scope === ALL_SCOPE ? 'Metrics' : (project?.name ?? 'Project');
  return (
    <section className="flex h-full flex-col">
      <header className="flex flex-col gap-3 border-b border-border px-6 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h1 className="truncate text-base font-medium text-text-primary">
              {view === 'overview' ? heading : `${heading} · Details`}
            </h1>
            <p role="status" className="text-xs text-text-tertiary">
              {windowStatus(days, report.data, failing(report), shown)}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <WindowButtons scope={scope} view={view} days={days} />
            <Link
              to={screenPath(scope, view === 'overview' ? 'details' : 'overview', days)}
              className="text-[12px] text-accent-bright underline"
            >
              {view === 'overview' ? 'Details' : 'Overview'}
            </Link>
          </div>
        </div>
        {scope === ALL_SCOPE ? null : <ProjectViewTabs projectId={scope} active="metrics" />}
      </header>
      <div className="flex-1 overflow-y-auto px-4 pb-[30px] pt-[22px] md:px-[30px]">
        <MetricsBody
          view={view}
          scope={scope}
          days={days}
          shown={shown}
          errors={failed.flatMap(entity => entity.error ?? [])}
          retry={retry}
          calibration={calibration}
          views={views}
        />
      </div>
    </section>
  );
}

function windowStatus(
  days: WindowDays,
  report: MetricsReport | undefined,
  failed: boolean,
  shown: Shown | undefined
): string {
  const last = `Last ${days.toString()} days`;
  if (report !== undefined) return `${last} · ${windowDates(report.window)}`;
  if (failed) return last;
  const loading = `Loading last ${days.toString()} days…`;
  if (shown === undefined) return loading;
  return `${loading} Showing last ${shown.days.toString()} days, ${windowDates(shown.report.window)}.`;
}

const WAITING = 'noop:metrics-wait-for-views';
const wait = (): Promise<undefined> => Promise.resolve(undefined);

interface Shown {
  days: WindowDays;
  report: MetricsReport;
  /** The window's own report is still loading; this is the last window the scope showed. */
  stale: boolean;
}

/**
 * The report on screen: the window's own, or while it loads, the last one this scope
 * showed. A window change takes as long as the query, so blanking the page reads as broken.
 */
function useShownReport(
  scope: Scope,
  days: WindowDays,
  data: MetricsReport | undefined
): Shown | undefined {
  const [last, setLast] = useState<{ scope: Scope; days: WindowDays; report: MetricsReport }>();
  // Adjusting state during render, so the remembered report never lags a render behind.
  if (data !== undefined && last?.report !== data) setLast({ scope, days, report: data });
  if (data !== undefined) return { days, report: data, stale: false };
  return last?.scope === scope ? { days: last.days, report: last.report, stale: true } : undefined;
}

/** Only Details shows calibration on its own, so only Details waits for it. */
function MetricsBody({
  view,
  scope,
  days,
  shown,
  errors,
  retry,
  calibration,
  views,
}: {
  view: MetricsView;
  scope: Scope;
  days: WindowDays;
  shown: Shown | undefined;
  errors: Error[];
  retry: () => void;
  calibration: EntityView<MetricsReport | undefined>;
  views: EntityView<MetricViews>;
}): ReactElement {
  const [first] = errors;
  if (first !== undefined) {
    return (
      <EmptyState
        title="Could not load metrics."
        hint={`Check that the Archon server is running, then retry. (${first.message})`}
        action={
          <button
            type="button"
            onClick={retry}
            className="rounded border border-border px-2.5 py-1 text-[11px] text-text-secondary transition-colors hover:border-border-bright hover:text-text-primary"
          >
            Retry
          </button>
        }
      />
    );
  }
  if (views.data === undefined) return <Loading days={days} />;
  if (view === 'overview') {
    return (
      <Dimmed stale={shown?.stale === true}>
        <MetricsOverview
          report={shown?.report}
          calibrations={calibrationsOf(calibration)}
          views={views.data}
          detailsPath={screenPath(scope, 'details', days)}
        />
      </Dimmed>
    );
  }
  if (shown === undefined || calibration.data === undefined) return <Loading days={days} />;
  return (
    <Dimmed stale={shown.stale}>
      <MetricsDetails
        report={shown.report}
        calibrations={calibration.data}
        views={views.data}
        days={shown.days}
        scope={scope}
      />
    </Dimmed>
  );
}

function Loading({ days }: { days: WindowDays }): ReactElement {
  return <EmptyState title={`Loading last ${days.toString()} days…`} />;
}

function Dimmed({ stale, children }: { stale: boolean; children: ReactNode }): ReactElement {
  return (
    <div aria-busy={stale} className={`transition-opacity ${stale ? 'opacity-50' : ''}`}>
      {children}
    </div>
  );
}

function calibrationsOf({ data, error }: { data?: MetricsReport; error?: Error }): Calibrations {
  if (data !== undefined) return { state: 'loaded', report: data };
  if (error !== undefined) return { state: 'failed', message: error.message };
  return { state: 'loading' };
}

function screenPath(scope: Scope, view: MetricsView, days: WindowDays): string {
  const base = scope === ALL_SCOPE ? '/console/metrics' : `/console/p/${scope}/metrics`;
  return `${base}${view === 'details' ? '/details' : ''}?window=${days.toString()}d`;
}

function WindowButtons({
  scope,
  view,
  days,
}: {
  scope: Scope;
  view: MetricsView;
  days: WindowDays;
}): ReactElement {
  return (
    <div role="group" aria-label="Window" className="flex items-center gap-1">
      {WINDOW_DAYS.map(option => (
        <Link
          key={option}
          to={screenPath(scope, view, option)}
          aria-current={option === days ? 'true' : undefined}
          className={`rounded px-2 py-1 font-mono text-[11px] transition-colors ${
            option === days
              ? 'bg-surface-elevated text-text-primary'
              : 'text-text-tertiary hover:text-text-primary'
          }`}
        >
          {option}d
        </Link>
      ))}
    </div>
  );
}
