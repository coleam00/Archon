import {
  BarChart,
  Bar,
  AreaChart,
  Area,
  ResponsiveContainer,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Legend,
  ReferenceLine,
  LineChart,
  Line,
} from 'recharts';
import { useMemo, useState } from 'react';
import playgroundData from '@/lib/playground.generated.json';

// --- Types matching build-playground-json.py shape ---
interface Sequence {
  slug: string;
  name: string;
  brand: string;
  apollo_id: string | null;
  contacts: number;
  active: number;
  paused: number;
  sent: number;
  opened: number;
  replied: number;
  clicked: number;
  reply_rate: number;
  open_rate: number;
  click_rate: number;
  status: string;
  num_steps: number;
}

interface DialDay {
  date: string;
  outcome: string;
  count: number;
}

interface FunnelStage {
  stage: string;
  count: number;
}

interface MeetingsWeek {
  week: string;
  total: number;
  by_line: Record<string, number>;
}

interface Kpis {
  meetings_this_week: number;
  dials_last_7d: number;
  active_sequences: number;
  reply_rate_14d: number;
  open_rate_14d: number;
  total_delivered: number;
  total_replied: number;
  target_30d_meetings: number;
  target_90d_meetings: number;
}

interface PlaygroundData {
  generated_at: string;
  kpis: Kpis;
  sequences: Sequence[];
  dials_by_day: DialDay[];
  outcome_funnel: FunnelStage[];
  meetings_by_week: MeetingsWeek[];
}

const data = playgroundData as unknown as PlaygroundData;

// --- Brand palette (matches the Tailwind tokens in BusinessPage) ---
const BRAND_COLOR: Record<string, string> = {
  BRT: '#34d399', // emerald-400
  PMC: '#38bdf8', // sky-400
  EWC: '#fbbf24', // amber-400
  TTTS: '#a78bfa', // violet-400
  QEP: '#f472b6', // pink-400
  IHHT: '#22d3ee', // cyan-400
  'SG INK': '#fb923c', // orange-400
  Unassigned: '#71717a', // zinc-500
};

const OUTCOME_COLOR: Record<string, string> = {
  'no-answer': '#71717a',
  voicemail: '#a1a1aa',
  gatekeeper: '#fbbf24',
  'wrong-number': '#52525b',
  'not-interested': '#f87171',
  'follow-up': '#38bdf8',
  interested: '#34d399',
  'meeting-booked': '#10b981',
  'closed-deal': '#059669',
  'closed-test': '#52525b',
};

const FUNNEL_LABEL: Record<string, string> = {
  'total-dials': 'Dialed',
  connected: 'Connected',
  conversation: 'Conversation',
  'follow-up': 'Follow-up',
  'meeting-booked': 'Meeting booked',
};

// --- Helpers ---
function ChartCard({
  title,
  subtitle,
  children,
  height = 280,
}: {
  title: string;
  subtitle?: React.ReactNode;
  children: React.ReactNode;
  height?: number;
}): React.ReactElement {
  return (
    <section className="rounded-lg border border-border bg-surface-elevated p-4">
      <header className="mb-3 flex items-baseline justify-between">
        <h3 className="text-sm font-semibold text-text-primary">{title}</h3>
        {subtitle && <span className="text-xs text-text-tertiary">{subtitle}</span>}
      </header>
      <div style={{ width: '100%', height }}>{children}</div>
    </section>
  );
}

function KpiTile({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}): React.ReactElement {
  return (
    <div className="rounded-lg border border-border bg-surface-elevated p-3">
      <div className="text-[10px] uppercase tracking-wider text-text-tertiary">{label}</div>
      <div className="mt-1 text-lg font-semibold text-text-primary">{value}</div>
      {hint && <div className="mt-0.5 text-[10px] text-text-tertiary">{hint}</div>}
    </div>
  );
}

export function PlaygroundPage(): React.ReactElement {
  const [highlightedBrand, setHighlightedBrand] = useState<string | null>(null);
  const [sequenceMetric, setSequenceMetric] = useState<
    'sent' | 'replied' | 'reply_rate' | 'open_rate'
  >('sent');

  // Sequence reply-rate horizontal bar
  const seqChartData = useMemo(
    () =>
      data.sequences.map(s => ({
        name: s.name.length > 32 ? s.name.slice(0, 30) + '…' : s.name,
        replyRate: s.reply_rate,
        openRate: s.open_rate,
        sent: s.sent,
        replied: s.replied,
        contacts: s.contacts,
        active: s.active,
        brand: s.brand,
        fill: BRAND_COLOR[s.brand] ?? BRAND_COLOR.Unassigned,
        dim: highlightedBrand !== null && s.brand !== highlightedBrand,
      })),
    [highlightedBrand]
  );

  const SEQUENCE_METRIC_LABEL: Record<typeof sequenceMetric, string> = {
    sent: 'Sent (delivered)',
    replied: 'Replies',
    reply_rate: 'Reply rate %',
    open_rate: 'Open rate %',
  };

  // Dial outcomes stacked area — pivot dial_by_day into wide format
  const dialsAreaData = useMemo(() => {
    const byDate: Record<string, Record<string, number>> = {};
    for (const d of data.dials_by_day) {
      byDate[d.date] ??= {};
      byDate[d.date][d.outcome] = d.count;
    }
    const outcomeKeys = Array.from(new Set(data.dials_by_day.map(d => d.outcome))).filter(
      o => o !== 'closed-test'
    );
    const rows = Object.entries(byDate)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, outcomes]) => {
        const row: Record<string, string | number> = { date };
        for (const o of outcomeKeys) row[o] = outcomes[o] ?? 0;
        return row;
      });
    return { rows, outcomeKeys };
  }, []);

  // Funnel rendered as horizontal bars (descending stages)
  const funnelData = useMemo(
    () =>
      data.outcome_funnel.map(f => ({
        stage: FUNNEL_LABEL[f.stage] ?? f.stage,
        count: f.count,
      })),
    []
  );

  // Meetings per week — line with reference lines for D30/D90 targets
  const meetingsLineData = useMemo(
    () =>
      data.meetings_by_week.map(m => ({
        week: m.week.slice(5), // MM-DD only for x-axis
        meetings: m.total,
      })),
    []
  );

  const brands = Array.from(new Set(data.sequences.map(s => s.brand)));

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex-1 overflow-auto p-6 space-y-6">
        <header>
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <div>
              <h1 className="text-lg font-semibold text-text-primary">Playground</h1>
              <p className="mt-0.5 text-xs text-text-secondary">
                Live charts off Apollo + Dial Tracker + PMC pipeline. Hover, click a brand chip to
                focus.
              </p>
            </div>
            <span className="text-[10px] text-text-tertiary">
              Source generated: <code className="font-mono">{data.generated_at.slice(0, 19)}Z</code>
            </span>
          </div>
        </header>

        {/* KPI strip */}
        <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <KpiTile
            label="Meetings this week"
            value={String(data.kpis.meetings_this_week)}
            hint={`Day-30 target: ${data.kpis.target_30d_meetings}/wk`}
          />
          <KpiTile label="Dials (last 7d)" value={String(data.kpis.dials_last_7d)} />
          <KpiTile
            label="Active sequences"
            value={String(data.kpis.active_sequences)}
            hint={`${data.kpis.total_delivered} delivered / ${data.kpis.total_replied} replied`}
          />
          <KpiTile
            label="Reply rate (14d)"
            value={`${data.kpis.reply_rate_14d}%`}
            hint={`Open rate: ${data.kpis.open_rate_14d}%`}
          />
        </section>

        {/* Brand-focus chips */}
        <section className="flex flex-wrap gap-2">
          <button
            onClick={(): void => {
              setHighlightedBrand(null);
            }}
            className={`rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${
              highlightedBrand === null
                ? 'border-primary text-primary'
                : 'border-border text-text-secondary hover:text-text-primary'
            }`}
          >
            All brands
          </button>
          {brands.map(b => (
            <button
              key={b}
              onClick={(): void => {
                setHighlightedBrand(highlightedBrand === b ? null : b);
              }}
              className={`rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${
                highlightedBrand === b
                  ? 'border-primary text-primary'
                  : 'border-border text-text-secondary hover:text-text-primary'
              }`}
              style={{
                borderColor: highlightedBrand === b ? BRAND_COLOR[b] : undefined,
                color: highlightedBrand === b ? BRAND_COLOR[b] : undefined,
              }}
            >
              {b}
            </button>
          ))}
        </section>

        {/* Apollo sequence health */}
        <h2 className="text-sm font-semibold text-text-primary">Apollo sequence health</h2>
        <div className="grid gap-3 lg:grid-cols-2">
          <ChartCard
            title={`Sequence ${SEQUENCE_METRIC_LABEL[sequenceMetric].toLowerCase()}`}
            subtitle={
              <span className="flex gap-1">
                {(['sent', 'replied', 'reply_rate', 'open_rate'] as const).map(m => (
                  <button
                    key={m}
                    onClick={(): void => {
                      setSequenceMetric(m);
                    }}
                    className={`rounded border px-1.5 py-0.5 text-[10px] transition-colors ${
                      sequenceMetric === m
                        ? 'border-primary text-primary'
                        : 'border-border text-text-tertiary hover:text-text-secondary'
                    }`}
                  >
                    {m === 'sent'
                      ? 'sent'
                      : m === 'replied'
                        ? 'replies'
                        : m === 'reply_rate'
                          ? 'reply%'
                          : 'open%'}
                  </button>
                ))}
              </span>
            }
          >
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={seqChartData} layout="vertical" margin={{ left: 30 }}>
                <CartesianGrid stroke="#27272a" horizontal={false} />
                <XAxis type="number" stroke="#71717a" fontSize={11} />
                <YAxis dataKey="name" type="category" stroke="#71717a" fontSize={11} width={180} />
                <Tooltip
                  contentStyle={{
                    background: '#18181b',
                    border: '1px solid #3f3f46',
                    borderRadius: 6,
                    fontSize: 12,
                  }}
                  formatter={(_v: unknown, _name: unknown, item: unknown): React.ReactNode => {
                    const payload = (
                      item as {
                        payload?: {
                          sent: number;
                          replied: number;
                          reply_rate?: number;
                          replyRate?: number;
                          openRate: number;
                        };
                      }
                    ).payload;
                    if (!payload) return '';
                    return [
                      `${payload.sent} sent`,
                      `${payload.replied} replied`,
                      `${payload.replyRate ?? payload.reply_rate ?? 0}% reply`,
                      `${payload.openRate}% open`,
                    ].join(' · ');
                  }}
                />
                <Bar
                  dataKey={
                    sequenceMetric === 'sent'
                      ? 'sent'
                      : sequenceMetric === 'replied'
                        ? 'replied'
                        : sequenceMetric === 'reply_rate'
                          ? 'replyRate'
                          : 'openRate'
                  }
                  name={SEQUENCE_METRIC_LABEL[sequenceMetric]}
                >
                  {seqChartData.map(d => (
                    <rect key={d.name} fill={d.fill} opacity={d.dim ? 0.25 : 1} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>

          <ChartCard
            title="Outcome funnel (all-time)"
            subtitle={`${data.kpis.dials_last_7d > 0 ? '' : 'historical'} — dial → meeting`}
          >
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={funnelData} layout="vertical" margin={{ left: 30 }}>
                <CartesianGrid stroke="#27272a" horizontal={false} />
                <XAxis type="number" stroke="#71717a" fontSize={11} />
                <YAxis dataKey="stage" type="category" stroke="#71717a" fontSize={11} width={120} />
                <Tooltip
                  contentStyle={{
                    background: '#18181b',
                    border: '1px solid #3f3f46',
                    borderRadius: 6,
                    fontSize: 12,
                  }}
                />
                <Bar dataKey="count" fill="#38bdf8" />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>
        </div>

        {/* Dial tracker */}
        <h2 className="text-sm font-semibold text-text-primary">Dial Tracker — daily outcomes</h2>
        <ChartCard
          title="Outcomes by day (last 30d)"
          subtitle="Stacked by call outcome — click legend to toggle"
          height={320}
        >
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={dialsAreaData.rows}>
              <CartesianGrid stroke="#27272a" />
              <XAxis dataKey="date" stroke="#71717a" fontSize={11} />
              <YAxis stroke="#71717a" fontSize={11} />
              <Tooltip
                contentStyle={{
                  background: '#18181b',
                  border: '1px solid #3f3f46',
                  borderRadius: 6,
                  fontSize: 12,
                }}
              />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              {dialsAreaData.outcomeKeys.map(o => (
                <Area
                  key={o}
                  type="monotone"
                  dataKey={o}
                  stackId="1"
                  stroke={OUTCOME_COLOR[o] ?? '#71717a'}
                  fill={OUTCOME_COLOR[o] ?? '#71717a'}
                  fillOpacity={0.6}
                />
              ))}
            </AreaChart>
          </ResponsiveContainer>
        </ChartCard>

        {/* PMC Pipeline */}
        <h2 className="text-sm font-semibold text-text-primary">
          PMC Pipeline — first meetings per week (North Star)
        </h2>
        <ChartCard
          title="First meetings booked per week"
          subtitle="Reference lines: Day-30 target (8/wk) · Day-90 target (15/wk)"
          height={320}
        >
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={meetingsLineData}>
              <CartesianGrid stroke="#27272a" />
              <XAxis dataKey="week" stroke="#71717a" fontSize={11} />
              <YAxis stroke="#71717a" fontSize={11} />
              <Tooltip
                contentStyle={{
                  background: '#18181b',
                  border: '1px solid #3f3f46',
                  borderRadius: 6,
                  fontSize: 12,
                }}
              />
              <ReferenceLine
                y={data.kpis.target_30d_meetings}
                stroke="#fbbf24"
                strokeDasharray="4 4"
                label={{
                  value: 'Day-30 target',
                  fill: '#fbbf24',
                  fontSize: 10,
                  position: 'insideTopRight',
                }}
              />
              <ReferenceLine
                y={data.kpis.target_90d_meetings}
                stroke="#34d399"
                strokeDasharray="4 4"
                label={{
                  value: 'Day-90 target',
                  fill: '#34d399',
                  fontSize: 10,
                  position: 'insideTopRight',
                }}
              />
              <Line
                type="monotone"
                dataKey="meetings"
                stroke="#38bdf8"
                strokeWidth={2}
                dot={{ fill: '#38bdf8', r: 3 }}
              />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>

        <footer className="border-t border-border pt-4 text-[10px] text-text-tertiary">
          Sources:{' '}
          <code className="font-mono">intelligence/briefs/2026-05-13-apollo-dial-list-all.csv</code>{' '}
          · <code className="font-mono">~/.hermes/state/dial_tracker_history.json</code> · Calendly
          + Gmail aggregator (Phase 2). Build script:{' '}
          <code className="font-mono">scripts/build-playground-json.py</code>
        </footer>
      </div>
    </div>
  );
}
