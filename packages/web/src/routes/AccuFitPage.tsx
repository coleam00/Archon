import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';
import { Zap, Calendar, DollarSign, Building2, Briefcase, Activity, MapPin } from 'lucide-react';

/* ------------------------------------------------------------------ */
/* AccuFit — Lutronic body-composition / contouring device showcase     */
/* Showcase-day engagement with Paul Fulford (BD partner).              */
/* Showpad asset: lutronic.showpad.com/share/5MwdplrytFlgFCWWuzpk4      */
/* Engagement terms captured 2026-03-31 (Jason's 3/31 BRT log).         */
/* ------------------------------------------------------------------ */

const ENGAGEMENT_TERMS = [
  { label: 'Hourly rate', value: '$40 / hr', icon: DollarSign },
  { label: 'Commission', value: '5% per close', icon: Briefcase },
  { label: 'Daily hours', value: '10 hrs / day', icon: Calendar },
  { label: 'Engagement length', value: '10 days', icon: Activity },
];

// Day-rate math at terms above
const REVENUE_MODEL = [
  { label: 'Day 1 (hourly only)', amount: 400 },
  { label: '1 close / day (avg $25K device)', amount: 400 + 1250 },
  { label: '2 closes / day', amount: 400 + 2500 },
  { label: '3 closes / day', amount: 400 + 3750 },
];

const TOTAL_BASE = 400 * 10; // hourly only over 10 days
const ASSUMED_DEVICE_PRICE = 25_000; // placeholder — confirm w/ Fulford

const COMP_SCENARIOS = [
  { closes: 2, total: TOTAL_BASE + 0.05 * ASSUMED_DEVICE_PRICE * 2 },
  { closes: 5, total: TOTAL_BASE + 0.05 * ASSUMED_DEVICE_PRICE * 5 },
  { closes: 10, total: TOTAL_BASE + 0.05 * ASSUMED_DEVICE_PRICE * 10 },
  { closes: 15, total: TOTAL_BASE + 0.05 * ASSUMED_DEVICE_PRICE * 15 },
].map(s => ({ name: `${s.closes} closes`, total: Math.round(s.total) }));

const RESPONSIBILITIES = [
  'Run AccuFit device showcase day(s) — demo + objection handling',
  'Coordinate provider schedules with practice owner / coordinator',
  'Submit weekly activity log (30-minute increments)',
  'Zelle invoicing — direct billing',
];

const ASSETS = [
  {
    title: 'Showpad — AccuFit (Computer + Tablet Version)',
    url: 'https://lutronic.showpad.com/share/5MwdplrytFlgFCWWuzpk4',
    note: 'Lutronic-hosted showcase deck; primary demo asset',
  },
];

const KPI_TILES = [
  { label: 'Status', value: 'Exploring', sub: 'Parked behind PMC/BRT priorities' },
  { label: 'Terms', value: 'Unconfirmed', sub: 'Scenario math only until written terms' },
  {
    label: 'Next confirm',
    value: 'Rep + margin',
    sub: 'Need Lutronic contact + commission structure',
  },
  { label: 'Manufacturer', value: 'Lutronic', sub: 'Aesthetic device line' },
];

export function AccuFitPage(): React.ReactElement {
  return (
    <div className="flex flex-1 flex-col overflow-auto">
      {/* HERO */}
      <header className="border-b border-border bg-gradient-to-b from-[oklch(0.985_0.012_88)] to-[var(--background)] px-8 pt-10 pb-12">
        <div className="mx-auto flex max-w-7xl flex-col gap-4">
          <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[var(--primary)]">
            Showcase Day Sales Engagement · Lutronic · Body Composition
          </p>
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <h1
                className="text-4xl font-bold tracking-tight text-text-primary"
                style={{ fontFamily: "'Playfair Display', serif" }}
              >
                AccuFit
              </h1>
              <p className="mt-2 max-w-2xl text-base text-text-secondary">
                Lutronic AccuFit aesthetic body-composition device. Jason runs showcase days with
                Paul Fulford as BD partner — high-margin hourly + commission side income on the
                multi-line revenue plan.
              </p>
            </div>
            <a
              href="https://lutronic.showpad.com/share/5MwdplrytFlgFCWWuzpk4"
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-md border border-border bg-card px-3 py-1.5 text-xs text-text-secondary transition-colors hover:border-primary hover:text-primary"
            >
              Showpad asset ↗
            </a>
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

        {/* Engagement terms */}
        <section className="rounded-xl border-2 border-primary/20 bg-card p-5">
          <h3
            className="mb-3 text-sm font-semibold text-text-primary"
            style={{ fontFamily: "'Playfair Display', serif" }}
          >
            Engagement terms (per 3/31 capture)
          </h3>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {ENGAGEMENT_TERMS.map(t => {
              // eslint-disable-next-line @typescript-eslint/naming-convention
              const Icon = t.icon;
              return (
                <div key={t.label} className="rounded-lg border border-border bg-background p-3">
                  <Icon className="mb-2 h-4 w-4 text-primary" />
                  <div
                    className="text-lg font-semibold text-text-primary"
                    style={{ fontFamily: "'Playfair Display', serif" }}
                  >
                    {t.value}
                  </div>
                  <div className="text-[10px] uppercase tracking-wider text-text-tertiary">
                    {t.label}
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {/* Revenue model chart */}
        <section className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-xl border border-border bg-card p-5">
            <h3
              className="mb-1 text-sm font-semibold text-text-primary"
              style={{ fontFamily: "'Playfair Display', serif" }}
            >
              Day revenue — single-day scenario
            </h3>
            <p className="mb-3 text-[11px] text-text-tertiary">
              Hourly floor + commission on closes (placeholder device ASP: $25K — confirm w/
              Fulford).
            </p>
            <div style={{ height: 240 }}>
              <ResponsiveContainer>
                <BarChart data={REVENUE_MODEL} layout="vertical" margin={{ left: 20 }}>
                  <CartesianGrid stroke="oklch(0.88 0.012 88)" horizontal={false} />
                  <XAxis type="number" stroke="oklch(0.55 0.018 255)" fontSize={11} />
                  <YAxis
                    dataKey="label"
                    type="category"
                    stroke="oklch(0.22 0.04 255)"
                    fontSize={10}
                    width={160}
                  />
                  <Tooltip
                    formatter={(v: unknown) => [
                      `$${(v as number).toLocaleString()}`,
                      'Day revenue',
                    ]}
                    contentStyle={{
                      background: 'oklch(0.985 0.012 88)',
                      border: '1px solid oklch(0.78 0.018 88)',
                      borderRadius: 8,
                      fontSize: 12,
                      color: 'oklch(0.22 0.04 255)',
                    }}
                  />
                  <Bar dataKey="amount" fill="var(--primary)" radius={[0, 6, 6, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="rounded-xl border border-border bg-card p-5">
            <h3
              className="mb-1 text-sm font-semibold text-text-primary"
              style={{ fontFamily: "'Playfair Display', serif" }}
            >
              10-day engagement scenarios
            </h3>
            <p className="mb-3 text-[11px] text-text-tertiary">
              Hourly base ${'$'}
              {TOTAL_BASE.toLocaleString()} + 5% on each close × closes count.
            </p>
            <div style={{ height: 240 }}>
              <ResponsiveContainer>
                <BarChart data={COMP_SCENARIOS} margin={{ left: 10 }}>
                  <CartesianGrid stroke="oklch(0.88 0.012 88)" vertical={false} />
                  <XAxis dataKey="name" stroke="oklch(0.22 0.04 255)" fontSize={11} />
                  <YAxis
                    stroke="oklch(0.55 0.018 255)"
                    fontSize={11}
                    tickFormatter={v => `$${(v / 1000).toFixed(0)}K`}
                  />
                  <Tooltip
                    formatter={(v: unknown) => [`$${(v as number).toLocaleString()}`, 'Total comp']}
                    contentStyle={{
                      background: 'oklch(0.985 0.012 88)',
                      border: '1px solid oklch(0.78 0.018 88)',
                      borderRadius: 8,
                      fontSize: 12,
                      color: 'oklch(0.22 0.04 255)',
                    }}
                  />
                  <Bar dataKey="total" fill="var(--chart-2)" radius={[6, 6, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </section>

        {/* Contact + Manufacturer cards */}
        <section className="grid gap-4 md:grid-cols-2">
          <div className="rounded-xl border border-border bg-card p-5">
            <div className="flex items-center gap-2">
              <Briefcase className="h-4 w-4 text-primary" />
              <h3
                className="text-sm font-semibold text-text-primary"
                style={{ fontFamily: "'Playfair Display', serif" }}
              >
                Contact status
              </h3>
            </div>
            <p
              className="mt-2 text-lg text-text-primary"
              style={{ fontFamily: "'Playfair Display', serif" }}
            >
              Fulford thread captured; Lutronic rep TBD
            </p>
            <p className="mt-1 text-xs text-text-secondary">
              Vault marks the Lutronic territory rep, commission structure, and first qualified
              co-pitch prospect as the confirmation set before AccuFit should be treated as active.
            </p>
            <p className="mt-2 text-[11px] text-text-tertiary">
              Status: exploring, not the priority focus right now per Jason (2026-06-03)
            </p>
          </div>
          <div className="rounded-xl border border-border bg-card p-5">
            <div className="flex items-center gap-2">
              <Building2 className="h-4 w-4 text-primary" />
              <h3
                className="text-sm font-semibold text-text-primary"
                style={{ fontFamily: "'Playfair Display', serif" }}
              >
                Manufacturer
              </h3>
            </div>
            <p
              className="mt-2 text-lg text-text-primary"
              style={{ fontFamily: "'Playfair Display', serif" }}
            >
              Lutronic
            </p>
            <p className="mt-1 text-xs text-text-secondary">
              Global aesthetic energy-device manufacturer. AccuFit positioned in body-composition /
              contouring line.
            </p>
            <div className="mt-2 flex items-center gap-1 text-[11px] text-text-tertiary">
              <MapPin className="h-3 w-3" />
              <span>Showpad-hosted demo deck (computer + tablet)</span>
            </div>
          </div>
        </section>

        {/* Responsibilities + Assets */}
        <section className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-xl border border-border bg-card p-5">
            <h3
              className="mb-3 text-sm font-semibold text-text-primary"
              style={{ fontFamily: "'Playfair Display', serif" }}
            >
              <Zap className="inline h-4 w-4 text-primary" /> Responsibilities
            </h3>
            <ul className="space-y-2">
              {RESPONSIBILITIES.map(r => (
                <li
                  key={r}
                  className="flex items-start gap-2 rounded-md border border-border bg-background p-2 text-xs text-text-primary"
                >
                  <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
                  <span>{r}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="rounded-xl border border-border bg-card p-5">
            <h3
              className="mb-3 text-sm font-semibold text-text-primary"
              style={{ fontFamily: "'Playfair Display', serif" }}
            >
              Assets
            </h3>
            <ul className="space-y-2">
              {ASSETS.map(a => (
                <li key={a.url} className="rounded-md border border-border bg-background p-3">
                  <a
                    href={a.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm font-medium text-primary hover:underline"
                  >
                    {a.title} ↗
                  </a>
                  <p className="mt-1 text-[11px] text-text-tertiary">{a.note}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* Note */}
        <section className="rounded-xl border border-dashed border-primary/40 bg-card p-5">
          <h3
            className="text-sm font-semibold text-text-primary"
            style={{ fontFamily: "'Playfair Display', serif" }}
          >
            🟡 Confirm before activating
          </h3>
          <p className="mt-2 text-sm text-text-secondary">
            ASP placeholder is $25K and all compensation scenarios are planning math only. Pull
            actual AccuFit device pricing, written commission/margin terms, territory-rep contact,
            and first BRT-overlap prospect before treating this route as an active sales lane.
          </p>
        </section>

        <footer className="border-t border-border pt-4 text-[10px] text-text-tertiary">
          Source: partners/accufit/_accufit.md + Jason 3/31 BRT capture · Last sync 2026-06-15
        </footer>
      </div>
    </div>
  );
}
