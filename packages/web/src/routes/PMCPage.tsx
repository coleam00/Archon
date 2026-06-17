import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import {
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  RadialBarChart,
  RadialBar,
  ResponsiveContainer,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  PolarAngleAxis,
} from 'recharts';
import { ArrowUpRight, TrendingUp, Users, DollarSign, Target } from 'lucide-react';
import { listDashboardRuns } from '@/lib/api';
import { pmcOverview } from '@/lib/pmc-content';
import {
  PMC_PILLARS,
  PMC_PILLARS_LAST_REVIEWED,
  PMC_REVENUE_LINES,
  PMC_REVENUE_LINES_LAST_REVIEWED,
  PMC_VALUE_PROPS,
  type PmcValuePropIconName,
} from '@/lib/pmc-strategy';
import {
  KPIS,
  buildPipelineFunnelData,
  computeWeeklyPace,
  computeD90Trajectory,
  meetingsWeekDelta,
  biggestDropInFunnel,
} from '@/lib/pmc-derived';
import prospectsData from '@/lib/business-prospects.generated.json';
import playgroundData from '@/lib/playground.generated.json';
import agentTraceData from '@/lib/agent-trace.generated.json';
import type { BusinessProspect } from '@/components/business/BusinessPage';

const REMARK_PLUGINS = [remarkGfm, remarkBreaks];
const REHYPE_PLUGINS = [rehypeHighlight];

function isPmcScoped(workflowName: string): boolean {
  return workflowName.startsWith('jid5274-') || workflowName.startsWith('pmc-');
}

// Brand-aligned palette (matches CSS chart-1..5 tokens)
// (REVENUE_LINE_COLOR map retired — composite-score bars now use --primary)

const REVENUE_LINES = PMC_REVENUE_LINES;

// Pipeline-stage funnel — see `@/lib/pmc-derived.buildPipelineFunnelData`.
// `Audit closed (proxy)` now uses the outcome_funnel `meeting-booked` count
// instead of a hard-coded 0 (vault-driven audits-closed file is the eventual
// upgrade path).
const buildPipelineFunnel = buildPipelineFunnelData;

// Dial-tracker funnel — produced by build-playground-json.py from dial_tracker_history.
// Renders the call-funnel as a peer surface to the email funnel.
const DIAL_FUNNEL_STAGE_LABELS: Record<string, string> = {
  'total-dials': 'Dials placed',
  connected: 'Connected (human)',
  conversation: 'Real conversation',
  'follow-up': 'Follow-up scheduled',
  'meeting-booked': 'Meeting booked',
};

function buildDialFunnel(): { stage: string; count: number }[] {
  const raw = (playgroundData as { outcome_funnel?: { stage: string; count: number }[] })
    .outcome_funnel;
  if (!raw || raw.length === 0) return [];
  return raw.map(r => ({
    stage: DIAL_FUNNEL_STAGE_LABELS[r.stage] ?? r.stage,
    count: r.count,
  }));
}

// Pillar mix — PMC service offering (vault-sourced from
// `second-brain/businesses/pmc/strategy/service-mix.md`)
// PMC_PILLARS is imported from `@/lib/pmc-strategy`.

// Icon-name → lucide-react component map for vault-sourced VALUE_PROPS.
const VALUE_PROP_ICONS: Record<PmcValuePropIconName, typeof TrendingUp> = {
  DollarSign,
  Target,
  TrendingUp,
  Users,
  ArrowUpRight,
};

interface KpiTile {
  label: string;
  value: string;
  sub: string;
  delta?: string; // e.g. "▲ 3 vs last wk"
  deltaDirection?: 'up' | 'down' | 'flat';
  icon: typeof TrendingUp;
}

interface AgentTraceSession {
  session_id: string;
  started_at?: string;
  source?: string;
  model?: string;
  last_user_message_preview?: string;
  tool_call_count?: number;
}

interface AgentTracePayload {
  total_sessions?: number;
  recent?: AgentTraceSession[];
}

const MARKET_BENCHMARKS = [
  {
    stat: '70%',
    label: 'Staff time lost to manual work',
    implication: 'Workflow redesign is not a nice-to-have; it is a margin leak.',
  },
  {
    stat: '45%',
    label: 'Average revenue lost to denials and delays',
    implication: 'RCM cleanup can be framed as immediate revenue protection.',
  },
  {
    stat: '30%',
    label: 'Inbound practice calls go unanswered',
    implication: 'Access leakage becomes a patient-growth and retention hook.',
  },
  {
    stat: '15%',
    label: 'Healthcare staffing turnover rate',
    implication: 'Training, role clarity, and automation protect operating capacity.',
  },
];

function buildKpiTiles(meetingsDelta: ReturnType<typeof meetingsWeekDelta>): KpiTile[] {
  const meetingsDeltaLabel =
    meetingsDelta.delta !== 0
      ? `${meetingsDelta.direction === 'up' ? '▲' : '▼'} ${Math.abs(meetingsDelta.delta)} vs last wk`
      : 'flat vs last wk';

  return [
    {
      label: 'First mtgs / wk (target)',
      value: `${KPIS.meetings_this_week} / ${KPIS.target_30d_meetings}`,
      sub: 'Day-30 target — North Star KPI',
      delta: meetingsDeltaLabel,
      deltaDirection: meetingsDelta.direction,
      icon: Target,
    },
    {
      label: 'Active sequences',
      value: String(KPIS.active_sequences),
      sub: `${KPIS.total_delivered} delivered · ${KPIS.total_replied} replied`,
      icon: TrendingUp,
    },
    {
      label: 'Reply rate (14d)',
      value: `${KPIS.reply_rate_14d}%`,
      sub: `Open rate: ${KPIS.open_rate_14d}%`,
      icon: ArrowUpRight,
    },
    {
      label: 'Engaged contacts',
      value: String(
        Object.values((prospectsData.totals as Record<string, number> | undefined) ?? {}).reduce(
          (a, b) => a + b,
          0
        )
      ),
      sub: ((): string => {
        const keys = Object.keys(
          (prospectsData.totals as Record<string, number> | undefined) ?? {}
        );
        return keys.length > 0 ? `Across ${keys.join(' + ')}` : 'Awaiting prospects generator';
      })(),
      icon: Users,
    },
  ];
}

// Value props — vault-sourced from
// `second-brain/businesses/pmc/strategy/value-props.md`.
// PMC_VALUE_PROPS is imported from `@/lib/pmc-strategy`.

export function PMCPage(): React.ReactElement {
  const { data: runsData } = useQuery({
    queryKey: ['pmcRuns'],
    queryFn: () => listDashboardRuns({ limit: 25 }),
    refetchInterval: 15_000,
  });

  const pmcRuns = (runsData?.runs ?? []).filter(r => isPmcScoped(r.workflow_name)).slice(0, 5);
  const businessName = pmcOverview.frontmatter.name ?? 'Practice Management Consultants';
  const tagline = pmcOverview.frontmatter.description ?? 'Break Through Your Revenue Ceiling.';

  const pmcProspects: BusinessProspect[] = (
    (prospectsData.by_business as Record<string, BusinessProspect[]> | undefined)?.PMC ?? []
  ).slice(0, 9);
  const pmcProspectTotal = (prospectsData.totals as Record<string, number> | undefined)?.PMC ?? 0;
  const agentTrace = agentTraceData as AgentTracePayload;
  const recentAgentSessions = agentTrace.recent ?? [];

  // Live pipeline funnel built from playground data + dial-tracker.
  const pipelineFunnel = buildPipelineFunnel();
  const dialFunnel = buildDialFunnel();

  // P1 derived metrics (pace, D90 trajectory, weekly delta, biggest funnel drop)
  const pace = computeWeeklyPace();
  const d90 = computeD90Trajectory();
  const meetingsDelta = meetingsWeekDelta();
  const biggestDrop = biggestDropInFunnel(pipelineFunnel);

  // Stale-data warning: if playground.generated_at older than 6h, surface it.
  // Defensive: tolerate a missing/invalid generated_at without rendering "Invalid Date"
  // or silently swallowing the warning (NaN > 6 is false).
  const rawGeneratedAt = (playgroundData as { generated_at?: string }).generated_at;
  const generatedAt =
    typeof rawGeneratedAt === 'string' && rawGeneratedAt.length > 0
      ? new Date(rawGeneratedAt)
      : null;
  const generatedAtValid = generatedAt !== null && !Number.isNaN(generatedAt.getTime());
  const hoursStale = generatedAtValid
    ? (Date.now() - generatedAt.getTime()) / (1000 * 60 * 60)
    : null;
  const isStale = hoursStale !== null && hoursStale > 6;

  // Build a gauge value for the first-meetings target
  const meetingsGaugeData = [
    {
      name: 'First mtgs',
      value: KPIS.meetings_this_week,
      fill: 'var(--primary)',
    },
  ];
  const meetingsTarget = KPIS.target_30d_meetings;

  return (
    <div className="flex flex-1 flex-col overflow-auto">
      {/* HERO — large editorial header on ivory canvas */}
      <header className="border-b border-border bg-gradient-to-b from-[oklch(0.985_0.012_88)] to-[var(--background)] px-8 pt-10 pb-12">
        <div className="mx-auto flex max-w-7xl flex-col gap-4">
          <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[var(--primary)]">
            The Advisory Standard · Medical Practice Advisory
          </p>
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <h1
                className="text-4xl font-bold tracking-tight text-text-primary"
                style={{ fontFamily: "'Playfair Display', serif" }}
              >
                {businessName}
              </h1>
              <p className="mt-2 max-w-2xl text-base text-text-secondary">{tagline}</p>
            </div>
            {pmcOverview.frontmatter.website && (
              <a
                href={`https://${pmcOverview.frontmatter.website}`}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-md border border-border bg-card px-3 py-1.5 text-xs text-text-secondary transition-colors hover:border-primary hover:text-primary"
              >
                {pmcOverview.frontmatter.website} ↗
              </a>
            )}
          </div>
        </div>
      </header>

      <div className="mx-auto w-full max-w-7xl space-y-8 px-8 py-8">
        {/* KPI strip */}
        <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {buildKpiTiles(meetingsDelta).map(k => {
            // eslint-disable-next-line @typescript-eslint/naming-convention
            const Icon = k.icon;
            return (
              <div
                key={k.label}
                className="group rounded-xl border border-border bg-card p-4 transition-all hover:border-primary/50 hover:shadow-md"
              >
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-text-secondary">
                    {k.label}
                  </span>
                  <Icon className="h-3.5 w-3.5 text-text-tertiary group-hover:text-primary" />
                </div>
                <div
                  className="mt-2 text-2xl font-semibold text-text-primary"
                  style={{ fontFamily: "'Playfair Display', serif" }}
                >
                  {k.value}
                </div>
                <p className="mt-1 text-[11px] text-text-secondary">{k.sub}</p>
                {k.delta && (
                  <p
                    className={`mt-1 text-[10px] font-medium ${
                      k.deltaDirection === 'up'
                        ? 'text-emerald-700'
                        : k.deltaDirection === 'down'
                          ? 'text-amber-700'
                          : 'text-text-tertiary'
                    }`}
                  >
                    {k.delta}
                  </p>
                )}
              </div>
            );
          })}
        </section>

        {/* Market benchmarks */}
        <section className="rounded-2xl border border-border bg-[oklch(0.985_0.012_88)] p-5 shadow-sm">
          <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[var(--primary)]">
                Market benchmarks
              </p>
              <h2
                className="mt-1 text-2xl font-semibold text-text-primary"
                style={{ fontFamily: "'Playfair Display', serif" }}
              >
                Credibility signals behind the PMC story
              </h2>
              <p className="mt-1 max-w-3xl text-sm text-text-secondary">
                Use these as historical source stats and case-by-case proof points. Live copy should
                lead with the practice-management problem first, then show the statistic and the
                operational implication.
              </p>
            </div>
            <div className="rounded-lg border border-amber-700/30 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              Source: PMC overview, brochure stats section
            </div>
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
            {MARKET_BENCHMARKS.map(b => (
              <div key={b.label} className="rounded-xl border border-border bg-card p-4">
                <div
                  className="text-3xl font-semibold text-[var(--primary)]"
                  style={{ fontFamily: "'Playfair Display', serif" }}
                >
                  {b.stat}
                </div>
                <h3 className="mt-2 text-sm font-semibold text-text-primary">{b.label}</h3>
                <p className="mt-2 text-xs leading-relaxed text-text-secondary">{b.implication}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Value prop tiles */}
        <section className="grid gap-4 md:grid-cols-3">
          {PMC_VALUE_PROPS.map(v => {
            // eslint-disable-next-line @typescript-eslint/naming-convention
            const Icon = VALUE_PROP_ICONS[v.icon];
            return (
              <div
                key={v.title}
                className="rounded-xl border-2 border-primary/20 bg-card p-5 transition-all hover:border-primary/60"
              >
                <Icon className="mb-3 h-5 w-5 text-primary" />
                <h3 className="text-base font-semibold text-text-primary">{v.title}</h3>
                <p className="mt-2 text-sm text-text-secondary">{v.body}</p>
              </div>
            );
          })}
        </section>

        {/* Data-viz row 1: Revenue lines composite + Pipeline funnel */}
        <section className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-xl border border-border bg-card p-5">
            <div className="mb-1 flex items-baseline justify-between">
              <h3 className="text-sm font-semibold text-text-primary">
                Revenue lines — composite score (marketability × readiness × cycle)
              </h3>
              <span className="text-[10px] text-text-tertiary">
                {PMC_REVENUE_LINES_LAST_REVIEWED
                  ? `Vault · reviewed ${PMC_REVENUE_LINES_LAST_REVIEWED}`
                  : 'PRD 2026-05-13'}
              </span>
            </div>
            <p className="mb-3 text-[11px] text-text-tertiary">
              Higher = closer to revenue. BH-Therapy leads; Fountain WPB now elevated.
            </p>
            <div style={{ height: 260 }}>
              <ResponsiveContainer>
                <BarChart data={REVENUE_LINES} layout="vertical" margin={{ left: 20 }}>
                  <CartesianGrid stroke="oklch(0.88 0.012 88)" horizontal={false} />
                  <XAxis
                    type="number"
                    stroke="oklch(0.55 0.018 255)"
                    fontSize={11}
                    domain={[0, 30]}
                  />
                  <YAxis
                    dataKey="name"
                    type="category"
                    stroke="oklch(0.22 0.04 255)"
                    fontSize={11}
                    width={130}
                  />
                  <Tooltip
                    contentStyle={{
                      background: 'oklch(0.985 0.012 88)',
                      border: '1px solid oklch(0.78 0.018 88)',
                      borderRadius: 8,
                      fontSize: 12,
                      color: 'oklch(0.22 0.04 255)',
                    }}
                  />
                  <Bar dataKey="composite" fill="var(--primary)" radius={[0, 6, 6, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="rounded-xl border border-border bg-card p-5">
            <div className="mb-1 flex items-baseline justify-between">
              <h3 className="text-sm font-semibold text-text-primary">
                Pipeline funnel — Apollo to audit close
              </h3>
              <span className="text-[10px] text-text-tertiary">
                Live · {playgroundData.sequences?.length ?? 0} sequences aggregated
              </span>
            </div>
            <p className="mb-3 text-[11px] text-text-tertiary">
              Stage drop-offs reveal the lever — opens-to-replies is the biggest gap.
            </p>
            {biggestDrop && (
              <div className="mb-3 rounded-md border border-amber-700/30 bg-amber-50 px-3 py-2 text-[11px] text-amber-900">
                <span className="font-semibold">Biggest drop:</span> {biggestDrop.fromStage} →{' '}
                {biggestDrop.toStage} · {Math.round(biggestDrop.conversion * 100)}% conversion (
                {biggestDrop.toCount} of {biggestDrop.fromCount})
              </div>
            )}
            <div style={{ height: 260 }}>
              <ResponsiveContainer>
                <BarChart data={pipelineFunnel} layout="vertical" margin={{ left: 20 }}>
                  <CartesianGrid stroke="oklch(0.88 0.012 88)" horizontal={false} />
                  <XAxis type="number" stroke="oklch(0.55 0.018 255)" fontSize={11} />
                  <YAxis
                    dataKey="stage"
                    type="category"
                    stroke="oklch(0.22 0.04 255)"
                    fontSize={11}
                    width={130}
                  />
                  <Tooltip
                    contentStyle={{
                      background: 'oklch(0.985 0.012 88)',
                      border: '1px solid oklch(0.78 0.018 88)',
                      borderRadius: 8,
                      fontSize: 12,
                      color: 'oklch(0.22 0.04 255)',
                    }}
                  />
                  <Bar dataKey="count" radius={[0, 6, 6, 0]}>
                    {pipelineFunnel.map((_d, i) => (
                      <Cell key={i} fill={`oklch(${0.65 - i * 0.06} 0.14 ${78 + i * 8})`} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </section>

        {/* Data-viz row 1b: Dial-tracker funnel (only when dial data exists) */}
        {dialFunnel.length > 0 && (
          <section className="rounded-xl border border-border bg-card p-5">
            <div className="mb-1 flex items-baseline justify-between">
              <h3 className="text-sm font-semibold text-text-primary">
                Dial-tracker funnel — call cadence to meeting booked
              </h3>
              <span className="text-[10px] text-text-tertiary">
                Live · sourced from dial_tracker_history
              </span>
            </div>
            <p className="mb-3 text-[11px] text-text-tertiary">
              Connected-to-conversation is where most calls fall off. Meeting booked is the north
              star.
            </p>
            <div style={{ height: 220 }}>
              <ResponsiveContainer>
                <BarChart data={dialFunnel} layout="vertical" margin={{ left: 30 }}>
                  <CartesianGrid stroke="oklch(0.88 0.012 88)" horizontal={false} />
                  <XAxis type="number" stroke="oklch(0.55 0.018 255)" fontSize={11} />
                  <YAxis
                    dataKey="stage"
                    type="category"
                    stroke="oklch(0.22 0.04 255)"
                    fontSize={11}
                    width={140}
                  />
                  <Tooltip
                    contentStyle={{
                      background: 'oklch(0.985 0.012 88)',
                      border: '1px solid oklch(0.78 0.018 88)',
                      borderRadius: 8,
                      fontSize: 12,
                      color: 'oklch(0.22 0.04 255)',
                    }}
                  />
                  <Bar dataKey="count" radius={[0, 6, 6, 0]}>
                    {dialFunnel.map((_d, i) => (
                      <Cell key={i} fill={`oklch(${0.62 - i * 0.05} 0.13 ${165 + i * 12})`} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </section>
        )}

        {/* Data-viz row 2: Service-mix donut + first-meetings gauge */}
        <section className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-xl border border-border bg-card p-5">
            <div className="mb-1 flex items-baseline justify-between">
              <h3 className="text-sm font-semibold text-text-primary">
                PMC service mix — pillar weight
              </h3>
              <span className="text-[10px] text-text-tertiary">
                {PMC_PILLARS_LAST_REVIEWED
                  ? `Vault · reviewed ${PMC_PILLARS_LAST_REVIEWED}`
                  : 'Brochure positioning'}
              </span>
            </div>
            <p className="mb-3 text-[11px] text-text-tertiary">
              How PMC packages its advisory: 4 pillars, balanced for full-spectrum embeds.
            </p>
            <div style={{ height: 260 }}>
              <ResponsiveContainer>
                <PieChart>
                  <Pie
                    data={PMC_PILLARS}
                    dataKey="value"
                    nameKey="name"
                    innerRadius={60}
                    outerRadius={100}
                    paddingAngle={4}
                    label={({ name, value }) => `${name}: ${value}%`}
                  >
                    {PMC_PILLARS.map(p => (
                      <Cell key={p.name} fill={p.color} />
                    ))}
                  </Pie>
                  <Tooltip
                    contentStyle={{
                      background: 'oklch(0.985 0.012 88)',
                      border: '1px solid oklch(0.78 0.018 88)',
                      borderRadius: 8,
                      fontSize: 12,
                      color: 'oklch(0.22 0.04 255)',
                    }}
                  />
                </PieChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="rounded-xl border border-border bg-card p-5">
            <div className="mb-1 flex items-baseline justify-between">
              <h3 className="text-sm font-semibold text-text-primary">
                North Star: first meetings booked this week
              </h3>
              <span className="text-[10px] text-text-tertiary">Live</span>
            </div>
            <p className="mb-3 text-[11px] text-text-tertiary">
              Day-30 target: {KPIS.target_30d_meetings}/wk · Day-90: {KPIS.target_90d_meetings}/wk ·
              the single number that matters.
            </p>
            <div style={{ height: 220 }}>
              <ResponsiveContainer>
                <RadialBarChart
                  data={meetingsGaugeData}
                  innerRadius="55%"
                  outerRadius="90%"
                  startAngle={210}
                  endAngle={-30}
                >
                  <PolarAngleAxis type="number" domain={[0, meetingsTarget]} tick={false} />
                  <RadialBar dataKey="value" cornerRadius={12} background />
                </RadialBarChart>
              </ResponsiveContainer>
              <div className="-mt-40 flex flex-col items-center">
                <div
                  className="text-4xl font-bold text-text-primary"
                  style={{ fontFamily: "'Playfair Display', serif" }}
                >
                  {KPIS.meetings_this_week}
                </div>
                <div className="text-[11px] text-text-tertiary">of {meetingsTarget}</div>
              </div>
            </div>
            {/* P1.1 — pace pill */}
            <div className="mt-2 flex items-center justify-center gap-2">
              <span
                className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${
                  pace.status === 'ahead'
                    ? 'border-emerald-700/40 bg-emerald-100 text-emerald-800'
                    : pace.status === 'on-pace'
                      ? 'border-sky-700/40 bg-sky-100 text-sky-800'
                      : pace.status === 'behind'
                        ? 'border-amber-700/40 bg-amber-100 text-amber-800'
                        : 'border-border bg-card text-text-tertiary'
                }`}
              >
                {pace.label}
              </span>
              {meetingsDelta.delta !== 0 && (
                <span
                  className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${
                    meetingsDelta.direction === 'up'
                      ? 'border-emerald-700/40 bg-emerald-100 text-emerald-800'
                      : 'border-amber-700/40 bg-amber-100 text-amber-800'
                  }`}
                >
                  {meetingsDelta.direction === 'up' ? '▲' : '▼'} {Math.abs(meetingsDelta.delta)} vs
                  last wk
                </span>
              )}
            </div>
            {/* P1.2 — D90 trajectory sparkline */}
            <div className="mt-3 border-t border-border pt-3">
              <div className="mb-1 flex items-baseline justify-between">
                <span className="text-[10px] uppercase tracking-wider text-text-tertiary">
                  D90 trajectory · last 4 wks
                </span>
                <span
                  className={`text-[10px] font-medium ${d90.weeklyGap >= 0 ? 'text-emerald-700' : 'text-amber-700'}`}
                >
                  {d90.avgPerWeek.toFixed(1)}/wk avg · target {d90.target}
                </span>
              </div>
              <div className="flex items-end gap-1" style={{ height: 32 }}>
                {d90.trendSeries.length === 0 ? (
                  <span className="text-[10px] text-text-tertiary">No weekly history yet.</span>
                ) : (
                  d90.trendSeries.map((w, i) => {
                    const max = Math.max(d90.target, ...d90.trendSeries.map(t => t.total));
                    const heightPct = max > 0 ? (w.total / max) * 100 : 0;
                    return (
                      <div
                        key={w.week}
                        className="flex flex-1 flex-col items-center justify-end"
                        title={`${w.week}: ${w.total} meetings`}
                      >
                        <div
                          className="w-full rounded-sm bg-[var(--primary)] opacity-70"
                          style={{ height: `${Math.max(heightPct, 4)}%` }}
                        />
                        <span className="mt-0.5 text-[8px] text-text-tertiary">
                          {i === d90.trendSeries.length - 1 ? 'now' : w.week.slice(5)}
                        </span>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </div>
        </section>

        {/* Recent runs + Top prospects */}
        <section className="grid gap-4 lg:grid-cols-3">
          <div className="rounded-xl border border-border bg-card p-5 lg:col-span-1">
            <h3 className="mb-3 text-sm font-semibold text-text-primary">
              Recent PMC workflow runs
            </h3>
            {pmcRuns.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border bg-surface-inset p-4 text-xs">
                <p className="text-text-secondary">No PMC-scoped workflow runs yet.</p>
                <p className="mt-1 text-text-tertiary">
                  Runs prefixed <code className="rounded bg-card px-1 font-mono">jid5274-</code> or{' '}
                  <code className="rounded bg-card px-1 font-mono">pmc-</code> appear here.{' '}
                  <Link to="/workflows" className="text-primary hover:underline">
                    Browse all workflows →
                  </Link>
                </p>
              </div>
            ) : (
              <ul className="space-y-2">
                {pmcRuns.map(run => (
                  <li
                    key={run.id}
                    className="flex items-center justify-between rounded-lg border border-border bg-background px-3 py-2 text-sm"
                  >
                    <Link
                      to={`/workflows/runs/${run.id}`}
                      className="truncate text-text-primary hover:text-primary"
                    >
                      {run.workflow_name}
                    </Link>
                    <span className="ml-2 shrink-0 text-[10px] uppercase tracking-wider text-text-tertiary">
                      {run.status}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="rounded-xl border border-border bg-card p-5 lg:col-span-2">
            <div className="mb-3 flex items-baseline justify-between">
              <h3 className="text-sm font-semibold text-text-primary">
                Top PMC ICP prospects — worklist
              </h3>
              <span className="text-[10px] text-text-tertiary">
                {pmcProspects.length} of {pmcProspectTotal} · sorted by engagement signal
              </span>
            </div>
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {pmcProspects.map((p, idx) => {
                const tier = p.tier?.toLowerCase() ?? '';
                const tierTone =
                  tier.includes('replied') || tier.includes('warm')
                    ? 'border-emerald-700/40 bg-emerald-50 text-emerald-800'
                    : tier.includes('key')
                      ? 'border-sky-700/40 bg-sky-50 text-sky-800'
                      : 'border-border bg-card text-text-tertiary';
                return (
                  <article
                    key={`${p.name}-${idx}`}
                    className="rounded-lg border border-border bg-background p-3 transition-colors hover:border-primary/50"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <h4 className="truncate text-sm font-medium text-text-primary">{p.name}</h4>
                      {p.tier && (
                        <span
                          className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[9px] font-medium ${tierTone}`}
                        >
                          {p.tier}
                        </span>
                      )}
                    </div>
                    {p.title && (
                      <p className="mt-0.5 truncate text-[11px] text-text-secondary">{p.title}</p>
                    )}
                    {p.company && (
                      <p className="mt-0.5 truncate text-[11px] text-text-tertiary">{p.company}</p>
                    )}
                    {(p.source_campaign ?? p.channel ?? p.engagement) && (
                      <p className="mt-1 truncate text-[10px] text-text-tertiary">
                        {[p.source_campaign, p.channel, p.engagement].filter(Boolean).join(' · ')}
                      </p>
                    )}
                    <div className="mt-2 flex flex-wrap gap-x-2 gap-y-1 text-[10px]">
                      {p.email && (
                        <a href={`mailto:${p.email}`} className="text-primary hover:underline">
                          ✉ email
                        </a>
                      )}
                      {p.phone && (
                        <a
                          href={`tel:${p.phone.replace(/[^+0-9]/g, '')}`}
                          className="text-primary hover:underline"
                        >
                          ☏ call
                        </a>
                      )}
                      {p.linkedin_url && (
                        <a
                          href={p.linkedin_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-primary hover:underline"
                        >
                          in/
                        </a>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          </div>
        </section>

        {/* Editorial overview from vault */}
        <section className="rounded-xl border border-border bg-card p-6">
          <div className="mb-3 flex items-baseline justify-between">
            <h2
              className="text-sm font-semibold text-text-primary"
              style={{ fontFamily: "'Playfair Display', serif" }}
            >
              From the vault · positioning + brand guide
            </h2>
            <span className="text-[10px] text-text-tertiary">
              Source: <code className="font-mono">businesses/pmc/overview.md</code> · edit in
              Obsidian, save, hot-reloads
            </span>
          </div>
          <div className="chat-markdown max-w-none text-sm text-text-primary">
            <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS}>
              {pmcOverview.body}
            </ReactMarkdown>
          </div>
        </section>

        {/* Wave 5 — agent-trace static panel (D1=b decision: vault-driven, no backend) */}
        <section className="rounded-xl border border-border bg-card p-5">
          <div className="mb-3 flex items-baseline justify-between">
            <h3 className="text-sm font-semibold text-text-primary">
              Recent Carlos activity — agent trace
            </h3>
            <span className="text-[10px] text-text-tertiary">
              {agentTrace.total_sessions ?? 0} sessions on disk · last {recentAgentSessions.length}{' '}
              shown
            </span>
          </div>
          <p className="mb-3 text-[11px] text-text-tertiary">
            Static JSON built from ~/.hermes/sessions/. Refreshes when{' '}
            <code className="font-mono">build-agent-trace-json.py</code> runs.
          </p>
          <ul className="divide-y divide-border">
            {recentAgentSessions.length > 0 ? (
              recentAgentSessions.map(s => (
                <li key={s.session_id} className="py-2">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-xs font-medium text-text-primary">
                      {s.last_user_message_preview || s.session_id}
                    </span>
                    <span className="shrink-0 text-[10px] text-text-tertiary">
                      {s.started_at ? new Date(s.started_at).toLocaleString() : '—'}
                    </span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 text-[10px] text-text-tertiary">
                    <span>{s.source ?? 'user'}</span>
                    <span>·</span>
                    <span>{s.model ?? 'unknown'}</span>
                    <span>·</span>
                    <span>{s.tool_call_count ?? 0} tool calls</span>
                  </div>
                </li>
              ))
            ) : (
              <li className="rounded-lg border border-dashed border-border bg-background px-3 py-3 text-[11px] text-text-secondary">
                No recent trace rows in the generated snapshot. Run{' '}
                <code className="font-mono text-text-primary">build-agent-trace-json.py</code> to
                refresh this panel.
              </li>
            )}
          </ul>
        </section>

        {/* P3.1 — portfolio cross-sell strip */}
        <section className="rounded-xl border border-border bg-card p-5">
          <div className="mb-3 flex items-baseline justify-between">
            <h3 className="text-sm font-semibold text-text-primary">
              Cross-sell paths from a PMC engagement
            </h3>
            <span className="text-[10px] text-text-tertiary">Portfolio thesis</span>
          </div>
          <p className="mb-4 text-[11px] text-text-tertiary">
            One advisory contract opens multi-line recurring revenue. Click through to the live
            brand dashboards.
          </p>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[
              { name: 'BRT', to: '/brt', tagline: 'BH-Therapy + Chiro+Medspa · composite 25/22' },
              { name: 'EWC', to: '/ewc', tagline: 'Elevated Wellness Co · Aura landing site' },
              { name: 'Fountain WPB', to: '/fountain', tagline: 'Wellness clinic · composite 24' },
              {
                name: 'AccuFit',
                to: '/accufit',
                tagline: 'Partner-coordinated · body-composition tech',
              },
            ].map(p => (
              <Link
                key={p.name}
                to={p.to}
                className="group rounded-lg border border-border bg-background p-3 transition-all hover:border-primary/60 hover:shadow-sm"
              >
                <div className="flex items-center justify-between">
                  <h4 className="text-sm font-semibold text-text-primary group-hover:text-primary">
                    {p.name}
                  </h4>
                  <ArrowUpRight className="h-3.5 w-3.5 text-text-tertiary group-hover:text-primary" />
                </div>
                <p className="mt-1 text-[11px] text-text-secondary">{p.tagline}</p>
              </Link>
            ))}
          </div>
        </section>
        {/* Footer */}
        <footer className="border-t border-border pt-4 text-[10px] text-text-tertiary">
          Last data refresh {generatedAtValid ? generatedAt.toLocaleString() : '—'}
          {isStale && hoursStale !== null && (
            <span className="ml-2 rounded-full border border-amber-700/40 bg-amber-100 px-2 py-0.5 font-medium text-amber-800">
              ⚠ {Math.round(hoursStale)}h stale — playground refresh due
            </span>
          )}
          {/* Tailscale Funnel deploy chain status is rendered globally via Layout.tsx -> DeployStatusFooter (D3). */}
        </footer>
      </div>
    </div>
  );
}
