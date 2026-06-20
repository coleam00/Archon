import overviewRaw from '@second-brain/businesses/pmc/bioreg/overview.md?raw';
import {
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  ResponsiveContainer,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from 'recharts';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { Zap, Activity, Stethoscope, BarChart3, Microscope } from 'lucide-react';
import { parseFrontmatter } from '@/lib/pmc-frontmatter';
import prospectsData from '@/lib/business-prospects.generated.json';
import prospectContactsData from '@/lib/pmc-prospect-contacts.generated.json';
import playgroundData from '@/lib/playground.generated.json';
import type { BusinessProspect } from '@/components/business/BusinessPage';

const REMARK_PLUGINS = [remarkGfm, remarkBreaks];
const REHYPE_PLUGINS = [rehypeHighlight];

const doc = parseFrontmatter(overviewRaw);

interface PmcProspectContact {
  brand_fit?: string[];
  apollo_sequence_name?: string;
}

interface PmcProspectContactsPayload {
  brand_counts?: Record<string, number>;
  prospects?: PmcProspectContact[];
}

// Real Apollo sequence data filtered to BRT
const BRT_SEQUENCES = (
  (playgroundData.sequences as
    | {
        name: string;
        brand: string;
        sent: number;
        opened: number;
        replied: number;
        reply_rate: number;
        open_rate: number;
        bounce_rate?: number;
        health_flag?: string;
      }[]
    | undefined) ?? []
).filter(s => s.brand === 'BRT');

const SEQUENCE_REPLY_DATA = BRT_SEQUENCES.map(s => ({
  name: s.name.length > 22 ? s.name.slice(0, 20) + '…' : s.name,
  fullName: s.name,
  replyRate: s.reply_rate,
  openRate: s.open_rate,
  sent: s.sent,
  replied: s.replied,
})).sort((a, b) => b.replyRate - a.replyRate);

const FALLBACK_ICP_SEGMENTS = [
  { name: 'BH-Therapy', value: 368, color: '#1e40af' },
  { name: 'Chiropractic', value: 122, color: '#2563eb' },
  { name: 'Medspa', value: 52, color: '#3b82f6' },
  { name: 'BH-Psych', value: 30, color: '#60a5fa' },
];

const ICP_COLORS: Record<string, string> = {
  'BH-Therapy': '#1e40af',
  Chiropractic: '#2563eb',
  Medspa: '#3b82f6',
  'BH-Psych': '#60a5fa',
  Other: '#93c5fd',
};

function classifyBrtIcp(contact: PmcProspectContact): string {
  const sequence = (contact.apollo_sequence_name ?? '').toLowerCase();
  if (sequence.includes('psychiatric') || sequence.includes('psych')) return 'BH-Psych';
  if (sequence.includes('behavioral') || sequence.includes('therapy')) return 'BH-Therapy';
  if (sequence.includes('chiro')) return 'Chiropractic';
  if (sequence.includes('medspa') || sequence.includes('aesthetic')) return 'Medspa';
  return 'Other';
}

const prospectContacts = prospectContactsData as Partial<PmcProspectContactsPayload>;
const safeProspectContacts = Array.isArray(prospectContacts.prospects)
  ? prospectContacts.prospects
  : [];
const BRT_PROSPECT_CONTACTS = safeProspectContacts.filter(contact =>
  contact.brand_fit?.includes('BRT')
);
const BRT_ACTIVE_CONTACT_COUNT = prospectContacts.brand_counts?.BRT ?? BRT_PROSPECT_CONTACTS.length;

const computedIcpSegments = Object.entries(
  BRT_PROSPECT_CONTACTS.reduce<Record<string, number>>((acc, contact) => {
    const segment = classifyBrtIcp(contact);
    acc[segment] = (acc[segment] ?? 0) + 1;
    return acc;
  }, {})
)
  .map(([name, value]) => ({ name, value, color: ICP_COLORS[name] ?? ICP_COLORS.Other }))
  .sort((a, b) => b.value - a.value);

const ICP_SEGMENTS = computedIcpSegments.length > 0 ? computedIcpSegments : FALLBACK_ICP_SEGMENTS;
const ICP_TOTAL = ICP_SEGMENTS.reduce((s, x) => s + x.value, 0);

const CLINICAL_EVIDENCE = [
  { study: 'Hennecke (1997)', focus: 'PEMF + chronic pain' },
  { study: 'Fedorowski (2004)', focus: 'BRT + autonomic regulation' },
  { study: 'Nienhaus (2006)', focus: 'Bioregulation efficacy meta' },
  { study: 'Heredia-Rojas (2011)', focus: 'EMF cellular signaling' },
];

const VALUE_PROPS = [
  {
    title: 'Clinical PEMF + EEG biofeedback',
    body: '20+ years of LENYO Bioregulation Therapy development. Targets parasympathetic activation — a measurable physiological outcome, not a wellness vibe.',
    icon: Activity,
  },
  {
    title: 'Nonthermal at 10 µT',
    body: 'Very low-amplitude PEMF (~20% of Earth\u2019s magnetic field). Direct cellular signaling effect without heating — durable, multi-modality safety profile.',
    icon: Zap,
  },
  {
    title: 'Two-modality device platform',
    body: 'Endogenous mode personalizes therapy from each patient\u2019s own EMF signature. Exogenous mode runs broad-spectrum harmonics (Lakhovsky principle).',
    icon: Stethoscope,
  },
];

const KPI_TILES = [
  {
    label: 'Active contacts',
    value: String(BRT_ACTIVE_CONTACT_COUNT || ICP_TOTAL),
    sub: 'From consolidated prospect snapshot',
  },
  {
    label: 'Live sequences',
    value: String(BRT_SEQUENCES.length),
    sub: 'Apollo + reply triage 5-min cron',
  },
  {
    label: 'Replies (cumulative)',
    value: String(BRT_SEQUENCES.reduce((s, x) => s + x.replied, 0)),
    sub: `${BRT_SEQUENCES.reduce((s, x) => s + x.sent, 0)} sent`,
  },
  {
    label: 'Composite rank',
    value: '#1 (25 / 30)',
    sub: 'Highest revenue-pull line',
  },
];

const BRT_PROSPECTS: BusinessProspect[] = (
  (prospectsData.by_business as Record<string, BusinessProspect[]> | undefined)?.BRT ?? []
).slice(0, 12);

export function BRTPage(): React.ReactElement {
  const name = doc.frontmatter.name ?? 'BioReg Technologies';

  return (
    <div className="flex flex-1 flex-col overflow-auto">
      {/* HERO */}
      <header className="border-b border-border bg-gradient-to-b from-[oklch(0.985_0.012_88)] to-[var(--background)] px-8 pt-10 pb-12">
        <div className="mx-auto flex max-w-7xl flex-col gap-4">
          <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[var(--primary)]">
            Clinical PEMF · Biofeedback · LENYO Bioregulation Therapy
          </p>
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <h1
                className="text-4xl font-bold tracking-tight text-text-primary"
                style={{ fontFamily: "'Playfair Display', serif" }}
              >
                {name}
              </h1>
              <p className="mt-2 max-w-2xl text-base text-text-secondary">
                Parasympathetic nervous-system activation via 20+ years of LENYO bioregulation
                science. US distribution + clinical-partner program.
              </p>
            </div>
            {doc.frontmatter.website && (
              <a
                href={
                  doc.frontmatter.website.startsWith('http://') ||
                  doc.frontmatter.website.startsWith('https://')
                    ? doc.frontmatter.website
                    : `https://${doc.frontmatter.website}`
                }
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-md border border-border bg-card px-3 py-1.5 text-xs text-text-secondary transition-colors hover:border-primary hover:text-primary"
              >
                {doc.frontmatter.website} ↗
              </a>
            )}
          </div>
        </div>
      </header>

      <div className="mx-auto w-full max-w-7xl space-y-8 px-8 py-8">
        {/* KPI strip */}
        <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {KPI_TILES.map(k => (
            <div
              key={k.label}
              className="rounded-xl border border-border bg-card p-4 transition-all hover:border-primary/50 hover:shadow-md"
            >
              <span className="text-[10px] font-semibold uppercase tracking-wider text-text-tertiary">
                {k.label}
              </span>
              <div
                className="mt-2 text-2xl font-semibold text-text-primary"
                style={{ fontFamily: "'Playfair Display', serif" }}
              >
                {k.value}
              </div>
              <p className="mt-1 text-[11px] text-text-tertiary">{k.sub}</p>
            </div>
          ))}
        </section>

        {/* Value props */}
        <section className="grid gap-4 md:grid-cols-3">
          {VALUE_PROPS.map(v => {
            // eslint-disable-next-line @typescript-eslint/naming-convention
            const Icon = v.icon;
            return (
              <div
                key={v.title}
                className="rounded-xl border-2 border-primary/20 bg-card p-5 transition-all hover:border-primary/60"
              >
                <Icon className="mb-3 h-5 w-5 text-primary" />
                <h3
                  className="text-base font-semibold text-text-primary"
                  style={{ fontFamily: "'Playfair Display', serif" }}
                >
                  {v.title}
                </h3>
                <p className="mt-2 text-sm text-text-secondary">{v.body}</p>
              </div>
            );
          })}
        </section>

        {/* Data viz row 1: Sequence reply rates */}
        <section className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-xl border border-border bg-card p-5">
            <div className="mb-1 flex items-baseline justify-between">
              <h3
                className="text-sm font-semibold text-text-primary"
                style={{ fontFamily: "'Playfair Display', serif" }}
              >
                Sequence reply rate (live Apollo)
              </h3>
              <span className="text-[10px] text-text-tertiary">
                <BarChart3 className="inline h-3 w-3" /> Live
              </span>
            </div>
            <p className="mb-3 text-[11px] text-text-tertiary">
              Reply-rate % per active BRT sequence. Therapy + Chiro pulling weight.
            </p>
            <div style={{ height: 260 }}>
              <ResponsiveContainer>
                <BarChart data={SEQUENCE_REPLY_DATA} layout="vertical" margin={{ left: 20 }}>
                  <CartesianGrid stroke="oklch(0.88 0.012 88)" horizontal={false} />
                  <XAxis type="number" stroke="oklch(0.55 0.018 255)" fontSize={11} unit="%" />
                  <YAxis
                    dataKey="name"
                    type="category"
                    stroke="oklch(0.22 0.04 255)"
                    fontSize={11}
                    width={150}
                  />
                  <Tooltip
                    contentStyle={{
                      background: 'oklch(0.985 0.012 88)',
                      border: '1px solid oklch(0.78 0.018 88)',
                      borderRadius: 8,
                      fontSize: 12,
                      color: 'oklch(0.22 0.04 255)',
                    }}
                    formatter={(_v: unknown, _n: unknown, item: unknown): React.ReactNode => {
                      const payload = (
                        item as {
                          payload?: {
                            sent: number;
                            replied: number;
                            openRate: number;
                            replyRate: number;
                          };
                        }
                      ).payload;
                      if (!payload) return '';
                      return `${payload.sent} sent · ${payload.replied} replied · ${payload.replyRate}% reply · ${payload.openRate}% open`;
                    }}
                  />
                  <Bar dataKey="replyRate" fill="var(--primary)" radius={[0, 6, 6, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="rounded-xl border border-border bg-card p-5">
            <div className="mb-1 flex items-baseline justify-between">
              <h3
                className="text-sm font-semibold text-text-primary"
                style={{ fontFamily: "'Playfair Display', serif" }}
              >
                ICP segment mix — {ICP_TOTAL} active contacts
              </h3>
              <span className="text-[10px] text-text-tertiary">Apollo load</span>
            </div>
            <p className="mb-3 text-[11px] text-text-tertiary">
              Where the outbound is currently focused. Behavioral health dominates.
            </p>
            <div style={{ height: 260 }}>
              <ResponsiveContainer>
                <PieChart>
                  <Pie
                    data={ICP_SEGMENTS}
                    dataKey="value"
                    nameKey="name"
                    innerRadius={60}
                    outerRadius={100}
                    paddingAngle={4}
                    label={({ name, value }) => `${name}: ${value}`}
                  >
                    {ICP_SEGMENTS.map(s => (
                      <Cell key={s.name} fill={s.color} />
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
        </section>

        {/* Clinical credibility tile */}
        <section className="rounded-xl border border-border bg-card p-5">
          <div className="mb-3 flex items-baseline justify-between">
            <h3
              className="text-sm font-semibold text-text-primary"
              style={{ fontFamily: "'Playfair Display', serif" }}
            >
              <Microscope className="inline h-4 w-4 text-primary" /> Clinical evidence
            </h3>
            <span className="text-[10px] text-text-tertiary">From BRT White Paper V2</span>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {CLINICAL_EVIDENCE.map(e => (
              <div
                key={e.study}
                className="rounded-lg border border-border bg-background p-3 transition-colors hover:border-primary/40"
              >
                <p
                  className="text-sm font-medium text-text-primary"
                  style={{ fontFamily: "'Playfair Display', serif" }}
                >
                  {e.study}
                </p>
                <p className="mt-1 text-xs text-text-secondary">{e.focus}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Top engaged BRT contacts */}
        <section className="rounded-xl border border-border bg-card p-5">
          <div className="mb-3 flex items-baseline justify-between">
            <h3
              className="text-sm font-semibold text-text-primary"
              style={{ fontFamily: "'Playfair Display', serif" }}
            >
              Top engaged BRT contacts — Apollo replied
            </h3>
            <span className="text-[10px] text-text-tertiary">
              {BRT_PROSPECTS.length} of{' '}
              {(prospectsData.totals as Record<string, number> | undefined)?.BRT ?? 0} engaged
            </span>
          </div>
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {BRT_PROSPECTS.map((p, idx) => (
              <article
                key={`${p.name}-${idx}`}
                className="rounded-lg border border-border bg-background p-3 transition-colors hover:border-primary/50"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h4 className="truncate text-sm font-medium text-text-primary">{p.name}</h4>
                    {p.title && (
                      <p className="mt-0.5 truncate text-[11px] text-text-secondary">{p.title}</p>
                    )}
                    {p.company && (
                      <p className="mt-0.5 truncate text-[11px] text-text-tertiary">{p.company}</p>
                    )}
                  </div>
                </div>
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
                {p.source_campaign && (
                  <p className="mt-1.5 text-[10px] text-text-tertiary">
                    {p.source_campaign.length > 38
                      ? p.source_campaign.slice(0, 36) + '…'
                      : p.source_campaign}
                  </p>
                )}
              </article>
            ))}
          </div>
        </section>

        {/* From the vault */}
        <section className="rounded-xl border border-border bg-card p-6">
          <h2
            className="mb-3 text-sm font-semibold text-text-primary"
            style={{ fontFamily: "'Playfair Display', serif" }}
          >
            From the vault · BRT overview
          </h2>
          <div className="chat-markdown max-w-none text-sm text-text-primary">
            <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS}>
              {doc.body}
            </ReactMarkdown>
          </div>
        </section>

        <footer className="border-t border-border pt-4 text-[10px] text-text-tertiary">
          Source: <code className="font-mono">second-brain/businesses/pmc/bioreg/overview.md</code>{' '}
          · Edit in Obsidian, save, dashboard hot-reloads
        </footer>
      </div>
    </div>
  );
}
