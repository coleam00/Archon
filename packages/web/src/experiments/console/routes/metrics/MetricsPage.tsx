import type { ReactElement } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { EmptyState } from '../../components/EmptyState';
import { ProjectViewTabs } from '../../components/ProjectViewTabs';
import { useEntity } from '../../store/cache';
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

  const heading = scope === ALL_SCOPE ? 'Metrics' : (project?.name ?? 'Project');
  return (
    <section className="flex h-full flex-col">
      <header className="flex flex-col gap-3 border-b border-border px-6 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="truncate text-base font-medium text-text-primary">
            {view === 'overview' ? heading : `${heading} · Details`}
          </h1>
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
        <MetricsBody view={view} scope={scope} days={days} />
      </div>
    </section>
  );
}

/** Only Details shows calibration on its own, so only Details waits for it. */
function MetricsBody({
  view,
  scope,
  days,
}: {
  view: MetricsView;
  scope: Scope;
  days: WindowDays;
}): ReactElement {
  const requests = metricsRequests(scope, days);
  // A relative window moves with the clock, so a revisit reloads instead of showing the first fetch.
  const fresh = { revalidateOnSubscribe: true };
  const report = useEntity<MetricsReport>(requests.report.key, requests.report.load, fresh);
  const calibration = useEntity<MetricsReport>(
    requests.calibration.key,
    requests.calibration.load,
    fresh
  );
  const views = useEntity<MetricViews>(requests.views.key, requests.views.load, fresh);

  const error = report.error ?? views.error ?? (view === 'details' ? calibration.error : undefined);
  if (error !== undefined) {
    return <EmptyState title="Could not load metrics." hint={error.message} />;
  }
  if (report.data === undefined || views.data === undefined) return LOADING;
  if (view === 'overview') {
    return (
      <MetricsOverview
        report={report.data}
        calibrations={calibrationsOf(calibration)}
        views={views.data}
        detailsPath={screenPath(scope, 'details', days)}
      />
    );
  }
  if (calibration.data === undefined) return LOADING;
  return (
    <MetricsDetails
      report={report.data}
      calibrations={calibration.data}
      views={views.data}
      days={days}
      scope={scope}
    />
  );
}

const LOADING = <EmptyState title="Loading…" />;

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
