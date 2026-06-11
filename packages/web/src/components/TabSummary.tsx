/**
 * TabSummary — canonical top-of-tab summary block for the operational
 * command-center dashboard.
 *
 * Per PRD 2026-06-10-pmc-dashboard-command-center.md ("there needs to be
 * high-level summaries at the top of each of the tabs because otherwise
 * it's just like you don't know where to start" — Jason, 2026-06-10) and
 * Wave 2 of the implementation plan
 * (second-brain/plans/2026-06-10-pmc-dashboard-command-center-implementation-sequence.md).
 *
 * SHAPE
 *   title              — h1 line (route name / brand label)
 *   purpose            — 1-sentence description of what this tab is for
 *   statusText/tone    — single status pill (live / building / paused / custom)
 *   3-tile glance row  — current focus | open blockers count | last refresh
 *
 * NO live data fetches inside this component. The caller passes already-resolved
 * props (typically derived from src/lib/tab-summaries.ts entries). Keeps the
 * data layer uniform with the rest of the dashboard surfaces.
 *
 * Styling matches the ivory-canvas BusinessPage badge palette
 * (see components/business/BusinessPage.tsx BADGE_STYLE comment).
 */

import type { ReactElement } from 'react';

export type TabSummaryStatus = 'live' | 'building' | 'paused';

export interface TabSummaryProps {
  /** Display title (route or brand name) */
  title: string;
  /** 1-sentence description of what this tab is for */
  purpose: string;
  /** Status pill text — defaults from `status` when omitted */
  statusText?: string;
  /** Status pill tone — derived from `status` when omitted */
  status?: TabSummaryStatus;
  /** Current focus — one-line "what's happening right now" */
  focus: string;
  /** Open blockers count — 0 renders as a flat zero, not hidden */
  blockers: number;
  /** Last data refresh — ISO date or human-readable label */
  refreshed: string;
  /** Optional vault path footer (shown small under the strip) */
  vaultPath?: string;
}

const STATUS_TEXT_DEFAULT: Record<TabSummaryStatus, string> = {
  live: 'live',
  building: 'building',
  paused: 'paused',
};

const STATUS_PILL: Record<TabSummaryStatus, string> = {
  live: 'bg-emerald-100 text-emerald-800 border-emerald-700/40',
  building: 'bg-amber-100 text-amber-800 border-amber-700/40',
  paused: 'bg-zinc-100 text-zinc-700 border-zinc-500/40',
};

const TILE_BLOCKER_TONE = (n: number): string =>
  n === 0
    ? 'border-emerald-700/30 bg-emerald-50'
    : n <= 2
      ? 'border-amber-700/30 bg-amber-50'
      : 'border-rose-700/40 bg-rose-50';

export function TabSummary({
  title,
  purpose,
  statusText,
  status = 'live',
  focus,
  blockers,
  refreshed,
  vaultPath,
}: TabSummaryProps): ReactElement {
  const pillLabel = statusText ?? STATUS_TEXT_DEFAULT[status];

  return (
    <section className="space-y-3 border-b border-border pb-4">
      {/* Title row + status pill */}
      <header className="flex flex-wrap items-baseline justify-between gap-3">
        <div className="flex items-baseline gap-3">
          <h1 className="text-lg font-semibold text-text-primary">{title}</h1>
          <span
            className={`rounded-md border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${STATUS_PILL[status]}`}
          >
            {pillLabel}
          </span>
        </div>
      </header>

      {/* 1-sentence purpose */}
      <p className="text-sm text-text-secondary">{purpose}</p>

      {/* 3-tile glance row */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <div className="rounded-lg border border-border bg-surface p-3">
          <div className="text-[10px] uppercase tracking-wider text-text-tertiary">
            Current focus
          </div>
          <div className="mt-1 text-sm font-medium text-text-primary">{focus}</div>
        </div>

        <div className={`rounded-lg border p-3 ${TILE_BLOCKER_TONE(blockers)}`}>
          <div className="text-[10px] uppercase tracking-wider text-text-tertiary">
            Open blockers
          </div>
          <div className="mt-1 text-lg font-semibold text-text-primary">{blockers}</div>
        </div>

        <div className="rounded-lg border border-border bg-surface p-3">
          <div className="text-[10px] uppercase tracking-wider text-text-tertiary">
            Last refresh
          </div>
          <div className="mt-1 text-sm font-medium text-text-primary">{refreshed}</div>
        </div>
      </div>

      {vaultPath && (
        <p className="text-[11px] text-text-tertiary">
          Source: <code>{vaultPath}</code>
        </p>
      )}
    </section>
  );
}
