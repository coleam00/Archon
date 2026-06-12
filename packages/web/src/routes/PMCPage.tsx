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
import prospectsData from '@/lib/business-prospects.generated.json';
import playgroundData from '@/lib/playground.generated.json';
import type { BusinessProspect } from '@/components/business/BusinessPage';

const REMARK_PLUGINS = [remarkGfm, remarkBreaks];
const REHYPE_PLUGINS = [rehypeHighlight];

function isPmcScoped(workflowName: string): boolean {
  return workflowName.startsWith('jid5274-') || workflowName.startsWith('pmc-');
}

// Brand-aligned palette (matches CSS chart-1..5 tokens)
// (REVENUE_LINE_COLOR map retired — composite-score bars now use --primary)

const REVENUE_LINES = PMC_REVENUE_LINES;

// Pipeline-stage funnel — computed live from playgroundData.sequences + dial-tracker.
// Audit closed is intentionally a manual roll-up — wire to a vault file once we lock format.
function buildPipelineFunnel(): { stage: string; count: number }[] {
  const seqs = (playgroundData.sequences ?? []) as {
    sent?: number;
    opened?: number;
    replied?: number;
  }[];
  const sent = seqs.reduce((a, s) => a + (s.sent ?? 0), 0);
  const opened = seqs.reduce((a, s) => a + (s.opened ?? 0), 0);
  const replied = seqs.reduce((a, s) => a + (s.replied ?? 0), 0);
  // Discovery booked: count of dial-tracker entries with `interested` outcome
  // (sourced from playgroundData when present; fall back to KPI target ratio if absent).
  const discoveryBooked =
    (playgroundData.kpis as { discovery_booked?: number }).discovery_booked ??
    playgroundData.kpis.meetings_this_week ??
    0;
  return [
    { stage: 'Sequence sent', count: sent },
    { stage: 'Opened', count: opened },
    { stage: 'Replied', count: replied },
    { stage: 'Discovery booked', count: discoveryBooked },
    { stage: 'Audit closed', count: 0 },
  ];
}

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

const KPI_TILES: { label: string; value: string; sub: string; icon: typeof TrendingUp }[] = [
  {
    label: 'First mtgs / wk (target)',
    value: `${playgroundData.kpis.meetings_this_week} / ${playgroundData.kpis.target_30d_meetings}`,
    sub: 'Day-30 target — North Star KPI',
    icon: Target,
  },
  {
    label: 'Active sequences',
    value: String(playgroundData.kpis.active_sequences),
    sub: `${playgroundData.kpis.total_delivered} delivered · ${playgroundData.kpis.total_replied} replied`,
    icon: TrendingUp,
  },
  {
    label: 'Reply rate (14d)',
    value: `${playgroundData.kpis.reply_rate_14d}%`,
    sub: `Open rate: ${playgroundData.kpis.open_rate_14d}%`,
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
      const keys = Object.keys((prospectsData.totals as Record<string, number> | undefined) ?? {});
      return keys.length > 0 ? `Across ${keys.join(' + ')}` : 'Awaiting prospects generator';
    })(),
    icon: Users,
  },
];

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

  // Live pipeline funnel built from playground data + dial-tracker.
  const pipelineFunnel = buildPipelineFunnel();
  const dialFunnel = buildDialFunnel();

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
      value: playgroundData.kpis.meetings_this_week,
      fill: 'var(--primary)',
    },
  ];
  const meetingsTarget = playgroundData.kpis.target_30d_meetings;

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
          {KPI_TILES.map(k => {
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
              </div>
            );
          })}
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
              Day-30 target: 8/wk · Day-90: 15/wk · the single number that matters.
            </p>
            <div style={{ height: 260 }}>
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
              <div className="-mt-44 flex flex-col items-center">
                <div
                  className="text-4xl font-bold text-text-primary"
                  style={{ fontFamily: "'Playfair Display', serif" }}
                >
                  {playgroundData.kpis.meetings_this_week}
                </div>
                <div className="text-[11px] text-text-tertiary">of {meetingsTarget}</div>
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
                Top engaged PMC ICP prospects
              </h3>
              <span className="text-[10px] text-text-tertiary">
                {pmcProspects.length} of {(prospectsData.totals as Record<string, number>).PMC ?? 0}{' '}
                · Apollo replied filter
              </span>
            </div>
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {pmcProspects.map((p, idx) => (
                <article
                  key={`${p.name}-${idx}`}
                  className="rounded-lg border border-border bg-background p-3 transition-colors hover:border-primary/50"
                >
                  <h4 className="truncate text-sm font-medium text-text-primary">{p.name}</h4>
                  {p.title && (
                    <p className="mt-0.5 truncate text-[11px] text-text-secondary">{p.title}</p>
                  )}
                  {p.company && (
                    <p className="mt-0.5 truncate text-[11px] text-text-tertiary">{p.company}</p>
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
              ))}
            </div>
          </div>
        </section>

        {/* Editorial overview from vault */}
        <section className="rounded-xl border border-border bg-card p-6">
          <h2
            className="mb-3 text-sm font-semibold text-text-primary"
            style={{ fontFamily: "'Playfair Display', serif" }}
          >
            From the vault · positioning + brand guide
          </h2>
          <div className="chat-markdown max-w-none text-sm text-text-primary">
            <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS}>
              {pmcOverview.body}
            </ReactMarkdown>
          </div>
        </section>

        {/* Footer */}
        <footer className="border-t border-border pt-4 text-[10px] text-text-tertiary">
          Source: <code className="font-mono">second-brain/businesses/pmc/overview.md</code> · Edit
          in Obsidian, save, dashboard hot-reloads · Last data refresh{' '}
          {generatedAtValid ? generatedAt.toLocaleString() : '—'}
          {isStale && hoursStale !== null && (
            <span className="ml-2 rounded-full border border-amber-700/40 bg-amber-100 px-2 py-0.5 font-medium text-amber-800">
              ⚠ {Math.round(hoursStale)}h stale — playground refresh due
            </span>
          )}
        </footer>
      </div>
    </div>
  );
}
