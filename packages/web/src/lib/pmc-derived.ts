/**
 * Derived KPI helpers for the PMC dashboard.
 *
 * Reads playground.generated.json + dial-tracker outcome funnel and exposes:
 *   - North Star pace (current vs. expected linear progress to D30 target)
 *   - D90 trajectory + this week's contribution
 *   - Pipeline funnel stage-to-stage conversion + biggest drop
 *   - Audits closed (sourced from outcome_funnel `meeting-booked` count;
 *     PMC's wedge offer = Grand Slam Audit, so meetings-booked is the best
 *     available proxy until we wire a dedicated audits-closed vault file)
 *   - KPI deltas vs. prior 7-day window
 */

import playgroundData from '@/lib/playground.generated.json';

export interface MeetingsWeekRow {
  week: string;
  total: number;
  by_line?: Record<string, number>;
}

interface SequenceRow {
  sent?: number;
  opened?: number;
  replied?: number;
}

interface OutcomeFunnelRow {
  stage: string;
  count: number;
}

interface PlaygroundKpis {
  meetings_this_week: number;
  dials_last_7d: number;
  active_sequences: number;
  reply_rate_14d: number;
  open_rate_14d: number;
  total_delivered: number;
  total_replied: number;
  target_30d_meetings: number;
  target_90d_meetings: number;
  discovery_booked?: number;
}

// --- Type-cast escape hatches (one place, not scattered through the page) ---

const KPIS: PlaygroundKpis = playgroundData.kpis as PlaygroundKpis;
const SEQUENCES: SequenceRow[] = (playgroundData.sequences ?? []) as SequenceRow[];
const OUTCOME_FUNNEL: OutcomeFunnelRow[] =
  (playgroundData as { outcome_funnel?: OutcomeFunnelRow[] }).outcome_funnel ?? [];
const MEETINGS_BY_WEEK: MeetingsWeekRow[] =
  (playgroundData as { meetings_by_week?: MeetingsWeekRow[] }).meetings_by_week ?? [];

export { KPIS, SEQUENCES, OUTCOME_FUNNEL, MEETINGS_BY_WEEK };

// --- North Star pace ---

export interface PaceState {
  status: 'on-pace' | 'behind' | 'ahead' | 'no-data';
  label: string;
  expected: number; // expected meetings booked so far this week (linear)
}

/**
 * Compute pace as: "where should we be by day-of-week, given the weekly target?"
 * If today is Monday (day 1 of 7), expected = 8 / 7 ≈ 1.14.
 * Status: 'ahead' if current > expected + 0.5, 'behind' if current < expected - 0.5.
 */
export function computeWeeklyPace(now: Date = new Date()): PaceState {
  const target = KPIS.target_30d_meetings;
  const current = KPIS.meetings_this_week;
  if (!target || target <= 0) return { status: 'no-data', label: '—', expected: 0 };

  // Day of week, Mon=1..Sun=7. Cap at 7.
  const day = now.getDay() === 0 ? 7 : now.getDay();
  const expected = (target * day) / 7;
  const diff = current - expected;

  if (Math.abs(diff) <= 0.5) {
    return {
      status: 'on-pace',
      label: `On pace · expected ${expected.toFixed(1)}`,
      expected,
    };
  }
  if (diff > 0.5) {
    return {
      status: 'ahead',
      label: `Ahead · expected ${expected.toFixed(1)}`,
      expected,
    };
  }
  return {
    status: 'behind',
    label: `Behind · expected ${expected.toFixed(1)}`,
    expected,
  };
}

// --- D90 trajectory ---

export interface D90State {
  totalLast4Weeks: number;
  avgPerWeek: number;
  target: number;
  weeklyGap: number; // negative = below target
  trendSeries: { week: string; total: number }[];
}

/**
 * Trailing 4-week meeting totals as a sparkline source + a single-line label
 * comparing the average pace to the D90 target.
 */
export function computeD90Trajectory(): D90State {
  const target = KPIS.target_90d_meetings;
  const trail = MEETINGS_BY_WEEK.slice(-4);
  const totalLast4Weeks = trail.reduce((a, w) => a + (w.total ?? 0), 0);
  const avgPerWeek = trail.length > 0 ? totalLast4Weeks / trail.length : 0;
  return {
    totalLast4Weeks,
    avgPerWeek,
    target,
    weeklyGap: avgPerWeek - target,
    trendSeries: trail.map(w => ({ week: w.week, total: w.total ?? 0 })),
  };
}

// --- Audits closed (proxy: meeting-booked from outcome funnel) ---

export function getAuditsClosedProxy(): number {
  const row = OUTCOME_FUNNEL.find(r => r.stage === 'meeting-booked');
  return row?.count ?? 0;
}

// --- Pipeline funnel biggest-drop ---

export interface FunnelDrop {
  fromStage: string;
  toStage: string;
  fromCount: number;
  toCount: number;
  conversion: number; // 0..1
  drop: number; // 0..1
  label: string;
}

export function biggestDropInFunnel(funnel: { stage: string; count: number }[]): FunnelDrop | null {
  if (funnel.length < 2) return null;
  let worst: FunnelDrop | null = null;
  for (let i = 0; i < funnel.length - 1; i++) {
    const fromCount = funnel[i].count;
    const toCount = funnel[i + 1].count;
    if (fromCount <= 0) continue;
    const conversion = toCount / fromCount;
    const drop = 1 - conversion;
    if (!worst || drop > worst.drop) {
      worst = {
        fromStage: funnel[i].stage,
        toStage: funnel[i + 1].stage,
        fromCount,
        toCount,
        conversion,
        drop,
        label: `${funnel[i].stage} → ${funnel[i + 1].stage}: ${Math.round(conversion * 100)}% conv`,
      };
    }
  }
  return worst;
}

// --- Weekly KPI deltas (this week vs. prior week) ---

export interface WeeklyDelta {
  current: number;
  prior: number;
  delta: number;
  pct: number | null; // null when prior was 0
  direction: 'up' | 'down' | 'flat';
}

function buildDelta(current: number, prior: number): WeeklyDelta {
  const delta = current - prior;
  const pct = prior > 0 ? (delta / prior) * 100 : null;
  let direction: 'up' | 'down' | 'flat' = 'flat';
  if (delta > 0) direction = 'up';
  else if (delta < 0) direction = 'down';
  return { current, prior, delta, pct, direction };
}

/**
 * Meetings delta this week vs. prior week (from meetings_by_week).
 */
export function meetingsWeekDelta(): WeeklyDelta {
  const current = MEETINGS_BY_WEEK.at(-1)?.total ?? KPIS.meetings_this_week;
  const prior = MEETINGS_BY_WEEK.at(-2)?.total ?? 0;
  return buildDelta(current, prior);
}

// --- Pipeline-funnel builder (lifted out of PMCPage so derived helpers can
// consume the same canonical shape) ---

export function buildPipelineFunnelData(): { stage: string; count: number }[] {
  const sent = SEQUENCES.reduce((a, s) => a + (s.sent ?? 0), 0);
  const opened = SEQUENCES.reduce((a, s) => a + (s.opened ?? 0), 0);
  const replied = SEQUENCES.reduce((a, s) => a + (s.replied ?? 0), 0);
  const discoveryBooked = KPIS.discovery_booked ?? KPIS.meetings_this_week ?? 0;
  const auditsClosed = getAuditsClosedProxy();
  return [
    { stage: 'Sequence sent', count: sent },
    { stage: 'Opened', count: opened },
    { stage: 'Replied', count: replied },
    { stage: 'Discovery booked', count: discoveryBooked },
    { stage: 'Audit closed (proxy)', count: auditsClosed },
  ];
}
