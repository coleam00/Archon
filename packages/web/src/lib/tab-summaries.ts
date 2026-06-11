/**
 * Tab summaries — JSON contract for the canonical top-of-tab summary block
 * rendered by components/TabSummary.tsx. Single export so the data lives in
 * one file and route components stay thin.
 *
 * Per Wave 2 of the PMC dashboard command-center implementation plan
 * (second-brain/plans/2026-06-10-pmc-dashboard-command-center-implementation-sequence.md).
 *
 * SHAPE
 *   route      — leading-slash route path matching react-router (e.g. '/pmc')
 *   purpose    — 1-sentence "what is this tab for" — visible to Jason and any
 *                partner he walks through the dashboard
 *   status     — 'live' | 'building' | 'paused'
 *   focus      — current focus / what's the next move (1 line)
 *   blockers   — count of open blockers visible from this surface
 *   refreshed  — ISO date of last data refresh (YYYY-MM-DD)
 *
 * EDIT POLICY
 *   Edit this file directly to update per-tab summaries. Don't fan out to per-
 *   route fields — the whole point of the contract is one file, one shape,
 *   one diff. When the route order changes (per Jason's walk-through sequence),
 *   reorder the array, not the keys.
 *
 * ROUTE ORDER (Wave 2 rollout sequence — Jason's partner walk-through):
 *   /start -> /pmc -> /brt -> /ttts -> /ewc -> /iht -> /qep -> /fountain ->
 *   /accufit -> /sadn -> /arc -> /solutions -> /contacts -> /drive ->
 *   /social -> /playground -> /dashboard
 */

import type { TabSummaryStatus } from '@/components/TabSummary';

export interface TabSummaryEntry {
  /** Leading-slash react-router path */
  route: string;
  /** 1-sentence "what is this tab for" */
  purpose: string;
  /** Pill state */
  status: TabSummaryStatus;
  /** Current focus — 1 line */
  focus: string;
  /** Open blockers count */
  blockers: number;
  /** Last data refresh — ISO date (YYYY-MM-DD) */
  refreshed: string;
}

export const TAB_SUMMARIES: TabSummaryEntry[] = [
  // Seeded with placeholder copy on 2026-06-11 (Wave 2 scaffolding).
  // Per-route summary text is filled in during Wave 2 item 3 (route-by-route
  // rollout). Keep the array in walk-through order so the data is easy to scan.
  {
    route: '/start',
    purpose: 'Entry point: where Jason walks partners and prospects in first.',
    status: 'building',
    focus: 'Awaiting tab-summary rollout (Wave 2 item 3).',
    blockers: 0,
    refreshed: '2026-06-11',
  },
];

/**
 * Lookup helper — returns the entry for a route, or undefined.
 * Route argument should be the leading-slash path (e.g. '/pmc').
 */
export function getTabSummary(route: string): TabSummaryEntry | undefined {
  return TAB_SUMMARIES.find(e => e.route === route);
}
