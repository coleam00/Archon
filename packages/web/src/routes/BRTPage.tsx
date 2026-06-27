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
import {
  Zap,
  Activity,
  Stethoscope,
  BarChart3,
  Microscope,
  RadioTower,
  BadgeDollarSign,
  ShieldCheck,
  FileText,
  Users,
  Target,
  Sparkles,
} from 'lucide-react';
import { parseFrontmatter } from '@/lib/pmc-frontmatter';
import prospectsData from '@/lib/business-prospects.generated.json';
import prospectContactsData from '@/lib/pmc-prospect-contacts.generated.json';
import playgroundData from '@/lib/playground.generated.json';
import type { BusinessProspect } from '@/components/business/BusinessPage';

const REMARK_PLUGINS = [remarkGfm, remarkBreaks];
const REHYPE_PLUGINS = [rehypeHighlight];

const doc = parseFrontmatter(overviewRaw);

interface PmcProspectContact {
  brand_fit: string[];
  apollo_sequence_name?: string;
}

interface PmcProspectContactsPayload {
  brand_counts?: Record<string, number>;
  prospects?: unknown[];
}

interface BrtSequence {
  name: string;
  brand: string;
  sent: number;
  replied: number;
  reply_rate: number;
  open_rate: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function normalizeProspectContact(value: unknown): PmcProspectContact | null {
  if (!isRecord(value)) return null;

  const brandFit = Array.isArray(value.brand_fit)
    ? value.brand_fit.filter((brand): brand is string => typeof brand === 'string')
    : [];
  const sequence =
    typeof value.apollo_sequence_name === 'string' ? value.apollo_sequence_name : undefined;

  if (brandFit.length === 0) return null;

  return {
    brand_fit: brandFit,
    ...(sequence ? { apollo_sequence_name: sequence } : {}),
  };
}

function isBrtSequence(value: unknown): value is BrtSequence {
  return isRecord(value) && typeof value.name === 'string' && value.brand === 'BRT';
}

const playgroundPayload = playgroundData as { sequences?: unknown };
const safePlaygroundSequences = Array.isArray(playgroundPayload.sequences)
  ? playgroundPayload.sequences
  : [];

// Real Apollo sequence data filtered to BRT
const BRT_SEQUENCES = safePlaygroundSequences.filter(isBrtSequence).map(s => ({
  name: s.name,
  brand: s.brand,
  sent: safeNumber(s.sent, 0),
  replied: safeNumber(s.replied, 0),
  reply_rate: safeNumber(s.reply_rate, 0),
  open_rate: safeNumber(s.open_rate, 0),
}));

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
      .map(normalizeProspectContact)
      .filter((contact): contact is PmcProspectContact => contact !== null)
  : [];
const BRT_PROSPECT_CONTACTS = safeProspectContacts.filter(contact =>
  contact.brand_fit.includes('BRT')
);
const BRT_ACTIVE_CONTACT_COUNT = safeNumber(
  prospectContacts.brand_counts?.BRT,
  BRT_PROSPECT_CONTACTS.length
);

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

const SOURCE_ASSETS = [
  {
    title: 'CellCom Flyer Q2 2026',
    role: 'Flagship device explainer',
    body: 'Advanced BRT system combining cellular biofeedback and PEMF. Best for post-call sends, product-page support, and ICP-specific one-pagers.',
    path: 'resources/assets/bioreg/source-documents/cellcom-flyer-q2-2026.pdf',
    icon: FileText,
  },
  {
    title: 'Clinical Partner Program',
    role: 'Fastest meeting-generation asset',
    body: 'Home-rental model for existing Nesta Pro users: between-visit support, templates, onboarding, and a practice-economics hook.',
    path: 'resources/assets/bioreg/source-documents/bioreg-clinical-partner-program-presentation-april-2026.pdf',
    icon: BadgeDollarSign,
  },
  {
    title: 'Cellular Communication Deck V2',
    role: 'Clinical authority narrative',
    body: 'Positions BRT as a communication and self-regulation layer across regenerative, chiropractic, PEMF, and wellness programs.',
    path: 'resources/assets/bioreg/source-documents/brt-cellular-communication-deck-v2-2026.pdf',
    icon: RadioTower,
  },
];

const POSITIONING_LANES = [
  {
    label: 'Device positioning',
    title: 'CellCom is the flagship clinical system',
    body: 'Lead with personalized biofeedback + PEMF, real-time adaptation, broad protocol coverage, onboarding, training, and financing. Keep disease language in the support register.',
    icon: Activity,
  },
  {
    label: 'Partner program',
    title: 'The meeting hook is between-visit continuity',
    body: 'The cleanest first-meeting angle is not device novelty. It is a home-rental layer that creates another patient touchpoint with low operational lift.',
    icon: Users,
  },
  {
    label: 'Clinical proof posture',
    title: 'BRT as the coordination layer',
    body: 'Anchor the education story in nervous-system regulation, cellular communication, HRV/biofeedback, PEMF, and bioelectric signaling. Cite before making clinical-facing claims.',
    icon: Microscope,
  },
  {
    label: 'Marketing strategy',
    title: 'Split authority content from sales activation',
    body: 'Use the Cellular Communication deck for podcasts and LinkedIn authority. Use the Clinical Partner Program for reply-driven outreach and warm post-call follow-up.',
    icon: Target,
  },
];

const PARTNER_PROGRAM_METRICS = [
  { label: 'Partner device price', value: '$2,395', note: 'Confirm vs older $2,195 note' },
  { label: 'Monthly financing', value: '$110', note: '24-month deck assumption' },
  { label: 'Rental cycle', value: '$185-$225', note: '2-week patient home unit rental' },
  { label: 'Net monthly profit', value: '$420', note: '2 devices, 50% utilization, 1 sale/month' },
];

const VISIBILITY_STRATEGY = [
  'Turn the Cellular Communication deck into a 5-part LinkedIn series: nervous system, cellular signaling, bioelectric code, PEMF, between-visit care.',
  'Build a podcast pitch around: Healing is communication -- why regulation and coordination matter in modern care.',
  'Create three ICP-specific one-pagers for mental health, chiropractic, and medspa/wellness so outreach mirrors the buyer context.',
  'Use the Clinical Partner Program as the near-term meeting engine: existing device owners, warm clinics, and revenue-led follow-up.',
];

const COMPLIANCE_FLAGS = [
  'Use support language for anxiety, PTSD, ADHD, autism spectrum, addiction recovery, pain, and immune support.',
  'Do not imply treatment, cure, prevention, FDA clearance, or disease-specific outcomes.',
  'Confirm public phone number, current partner pricing, and device-specific FDA registration wording before external campaign updates.',
];

const VALUE_PROPS = [
  {
    title: 'Clinical PEMF + EEG biofeedback',
    body: '20+ years of LENYO Bioregulation Therapy development. Targets parasympathetic activation -- a measurable physiological outcome, not a wellness vibe.',
    icon: Activity,
  },
  {
    title: 'Nonthermal at 10 µT',
    body: 'Very low-amplitude PEMF (~20% of Earth\u2019s magnetic field). Direct cellular signaling effect without heating -- durable, multi-modality safety profile.',
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
                A clinical communication-and-self-regulation platform: CellCom flagship, Nesta
                home-rental partner program, and BRT education engine for practitioner adoption.
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

        {/* Source asset command center */}
        <section className="overflow-hidden rounded-2xl border border-primary/20 bg-gradient-to-br from-card via-card to-primary/5 shadow-sm">
          <div className="grid gap-0 lg:grid-cols-[1.05fr_0.95fr]">
            <div className="border-b border-border p-6 lg:border-r lg:border-b-0">
              <div className="mb-5 flex items-start justify-between gap-4">
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-primary">
                    BioReg command center
                  </p>
                  <h2
                    className="mt-2 text-2xl font-semibold text-text-primary"
                    style={{ fontFamily: "'Playfair Display', serif" }}
                  >
                    Assets, positioning, proof, and market activation
                  </h2>
                  <p className="mt-2 max-w-2xl text-sm text-text-secondary">
                    The dashboard now splits BRT into three operational lanes: flagship device
                    positioning, partner-program economics, and clinical education for visibility.
                  </p>
                </div>
                <Sparkles className="mt-1 h-5 w-5 shrink-0 text-primary" />
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                {SOURCE_ASSETS.map(asset => {
                  // eslint-disable-next-line @typescript-eslint/naming-convention
                  const Icon = asset.icon;
                  return (
                    <article
                      key={asset.title}
                      className="rounded-xl border border-border bg-background/80 p-4 transition-all hover:-translate-y-0.5 hover:border-primary/50 hover:shadow-md"
                    >
                      <Icon className="mb-3 h-5 w-5 text-primary" />
                      <p className="text-[10px] font-semibold uppercase tracking-wider text-text-tertiary">
                        {asset.role}
                      </p>
                      <h3
                        className="mt-1 text-sm font-semibold text-text-primary"
                        style={{ fontFamily: "'Playfair Display', serif" }}
                      >
                        {asset.title}
                      </h3>
                      <p className="mt-2 text-xs leading-relaxed text-text-secondary">
                        {asset.body}
                      </p>
                      <p className="mt-3 truncate rounded-md bg-primary/5 px-2 py-1 font-mono text-[9px] text-text-tertiary">
                        {asset.path}
                      </p>
                    </article>
                  );
                })}
              </div>
            </div>
            <div className="p-6">
              <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-primary">
                Clinical Partner Program
              </p>
              <h3
                className="mt-2 text-xl font-semibold text-text-primary"
                style={{ fontFamily: "'Playfair Display', serif" }}
              >
                The fastest first-meeting angle
              </h3>
              <p className="mt-2 text-sm text-text-secondary">
                The strongest revenue-led hook is simple: extend care beyond the visit while
                creating a low-lift home-rental layer.
              </p>
              <div className="mt-5 grid grid-cols-2 gap-3">
                {PARTNER_PROGRAM_METRICS.map(metric => (
                  <div
                    key={metric.label}
                    className="rounded-xl border border-border bg-background/80 p-3"
                  >
                    <p className="text-[10px] uppercase tracking-wider text-text-tertiary">
                      {metric.label}
                    </p>
                    <p
                      className="mt-1 text-2xl font-semibold text-text-primary"
                      style={{ fontFamily: "'Playfair Display', serif" }}
                    >
                      {metric.value}
                    </p>
                    <p className="mt-1 text-[10px] text-text-tertiary">{metric.note}</p>
                  </div>
                ))}
              </div>
              <div className="mt-4 rounded-xl border border-amber-200/60 bg-amber-50/70 p-3 text-[11px] leading-relaxed text-amber-900">
                <ShieldCheck className="mr-1 inline h-3.5 w-3.5" /> Pricing and regulatory language
                are source-backed but flagged for confirmation before external campaign updates.
              </div>
            </div>
          </div>
        </section>

        {/* Strategic lanes */}
        <section className="grid gap-4 lg:grid-cols-4">
          {POSITIONING_LANES.map(lane => {
            // eslint-disable-next-line @typescript-eslint/naming-convention
            const Icon = lane.icon;
            return (
              <article
                key={lane.title}
                className="rounded-xl border border-border bg-card p-5 transition-all hover:border-primary/50 hover:shadow-md"
              >
                <div className="mb-3 flex items-center justify-between gap-3">
                  <span className="rounded-full bg-primary/10 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-primary">
                    {lane.label}
                  </span>
                  <Icon className="h-4 w-4 text-primary" />
                </div>
                <h3
                  className="text-sm font-semibold text-text-primary"
                  style={{ fontFamily: "'Playfair Display', serif" }}
                >
                  {lane.title}
                </h3>
                <p className="mt-2 text-xs leading-relaxed text-text-secondary">{lane.body}</p>
              </article>
            );
          })}
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
                ICP segment mix -- {ICP_TOTAL} active contacts
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

        {/* Clinical proof + visibility strategy */}
        <section className="grid gap-4 lg:grid-cols-[0.9fr_1.1fr]">
          <div className="rounded-xl border border-border bg-card p-5">
            <div className="mb-3 flex items-baseline justify-between">
              <h3
                className="text-sm font-semibold text-text-primary"
                style={{ fontFamily: "'Playfair Display', serif" }}
              >
                <Microscope className="inline h-4 w-4 text-primary" /> Clinical proof posture
              </h3>
              <span className="text-[10px] text-text-tertiary">White paper + 2026 deck</span>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
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
            <div className="mt-4 rounded-lg border border-border bg-background p-3">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-text-tertiary">
                Citation leads to verify
              </p>
              <p className="mt-2 text-xs leading-relaxed text-text-secondary">
                Porges, Tracey, Thayer, Levin, Markov, Ross, Liboff, Lehrer, McCraty, and Gevirtz.
                Use these as research leads before publishing clinical-facing long-form claims.
              </p>
            </div>
          </div>

          <div className="rounded-xl border border-border bg-card p-5">
            <div className="mb-3 flex items-baseline justify-between">
              <h3
                className="text-sm font-semibold text-text-primary"
                style={{ fontFamily: "'Playfair Display', serif" }}
              >
                <Target className="inline h-4 w-4 text-primary" /> Visibility and marketing strategy
              </h3>
              <span className="text-[10px] text-text-tertiary">Meetings + authority</span>
            </div>
            <div className="space-y-3">
              {VISIBILITY_STRATEGY.map((item, idx) => (
                <div
                  key={item}
                  className="flex gap-3 rounded-lg border border-border bg-background p-3"
                >
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[11px] font-semibold text-primary">
                    {idx + 1}
                  </span>
                  <p className="text-xs leading-relaxed text-text-secondary">{item}</p>
                </div>
              ))}
            </div>
            <div className="mt-4 rounded-lg border border-rose-200/60 bg-rose-50/70 p-3">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-rose-900">
                Compliance guardrails
              </p>
              <ul className="mt-2 space-y-1.5 text-[11px] leading-relaxed text-rose-900">
                {COMPLIANCE_FLAGS.map(flag => (
                  <li key={flag}>• {flag}</li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        {/* Top engaged BRT contacts */}
        <section className="rounded-xl border border-border bg-card p-5">
          <div className="mb-3 flex items-baseline justify-between">
            <h3
              className="text-sm font-semibold text-text-primary"
              style={{ fontFamily: "'Playfair Display', serif" }}
            >
              Top engaged BRT contacts -- Apollo replied
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
