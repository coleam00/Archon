import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  PieChart,
  Pie,
  Cell,
} from 'recharts';
import { MapPin, Phone, Activity, Microscope, Heart, Dna, Sparkles, Pill } from 'lucide-react';

/* ------------------------------------------------------------------ */
/* The Fountain WPB — Boutique anti-aging + wellness center             */
/* West Palm Beach, FL · 561-320-3142 · thefountainwpb.com              */
/* Sourced 2026-06-03 from public website + Jason engagement notes.     */
/* ------------------------------------------------------------------ */

const FUNCTIONAL_DIAGNOSTICS = [
  {
    name: 'BodyView Full Body MRI',
    icon: Microscope,
    body: 'Single 1-hour scan screens for cancer + 500+ conditions across up to 13 organs (incl. brain). Lead anchor for the diagnostics line.',
  },
  {
    name: 'Biological Age Testing',
    icon: Activity,
    body: 'Quantifies pace-of-aging vs. chronological age. Lifestyle + environment + stress baseline.',
  },
  {
    name: 'Functional DNA Testing',
    icon: Dna,
    body: 'Mood, behavior, diet/nutrition, sleep, methylation pathways — predisposition mapping.',
  },
  {
    name: 'Advanced Bloodwork',
    icon: Heart,
    body: 'Comprehensive panel beyond routine checkups — links to MRI + DNA insights.',
  },
];

const THERAPEUTICS = [
  { name: 'Non-Surgical Joint Restoration' },
  { name: 'Exosome Therapy' },
  { name: 'HRT + Peptide Therapy' },
  { name: 'Medical Weight Loss' },
  { name: 'Stem Cell Therapy' },
  { name: 'IV Therapy' },
];

const AESTHETICS = [{ name: 'Dermal Fillers' }, { name: 'Botox Treatments' }];

// Cross-sell map: Fountain's diagnostic-first model is the natural feeder
// for BRT + AccuFit + EWC body-comp / wellness journeys.
const PMC_PORTFOLIO_FIT = [
  {
    name: 'BRT (PEMF + EEG)',
    value: 32,
    color: '#1e40af',
    note: 'Parasympathetic activation pairs with HRT + peptide protocols',
  },
  {
    name: 'AccuFit (body comp)',
    value: 25,
    color: '#c9a84c',
    note: 'Composition tracking complements Bio-Age + weight-loss line',
  },
  {
    name: 'EWC (Lumnen)',
    value: 18,
    color: '#10b981',
    note: 'Clinical wellness journey, recovery-room overlap',
  },
  {
    name: 'Quicksilver Scientific',
    value: 25,
    color: '#a855f7',
    note: 'Practitioner-grade nutraceutical protocols attached to diagnostic + therapeutic deliverables (supersedes the legacy "Naba" framing per 2026-06-01 directive).',
  },
];

// Anchored Universal Wellness Package — flagship membership
const MEMBERSHIP_ANCHOR = {
  name: 'Universal Wellness Package',
  city: 'West Palm Beach, FL',
  positioning: 'Boutique medical spa for health + wellness. Inside-out diagnostics-first care.',
};

const KPI_TILES = [
  { label: 'Service verticals', value: '12+', sub: 'Diagnostics · therapeutics · aesthetics' },
  {
    label: 'Anchor diagnostic',
    value: 'BodyView MRI',
    sub: '13 organs · 500+ conditions · 1 hour',
  },
  { label: 'Client tier', value: 'Core', sub: 'Elevated 2026-06-03 · same tier as BioReg' },
  { label: 'Key contact', value: 'Blake Baynham', sub: 'Warm relationship via QEP partnership' },
];

export function FountainPage(): React.ReactElement {
  const serviceMix = [
    { name: 'Functional Diagnostics', value: 4 },
    { name: 'Therapeutics', value: THERAPEUTICS.length },
    { name: 'Aesthetics', value: AESTHETICS.length },
  ];

  return (
    <div className="flex flex-1 flex-col overflow-auto">
      {/* HERO */}
      <header className="border-b border-border bg-gradient-to-b from-[oklch(0.985_0.012_88)] to-[var(--background)] px-8 pt-10 pb-12">
        <div className="mx-auto flex max-w-7xl flex-col gap-4">
          <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[var(--primary)]">
            Anti-Aging · Diagnostics-First Wellness · West Palm Beach
          </p>
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <h1
                className="text-4xl font-bold tracking-tight text-text-primary"
                style={{ fontFamily: "'Playfair Display', serif" }}
              >
                The Fountain · WPB
              </h1>
              <p className="mt-2 max-w-2xl text-base text-text-secondary">
                Boutique medical spa pairing advanced imaging, genetic analysis, and comprehensive
                bloodwork with regenerative therapies, hormone optimization, and aesthetic care.
              </p>
            </div>
            <div className="flex flex-col gap-1 text-xs text-text-secondary">
              <a
                href="https://thefountainwpb.com"
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-md border border-border bg-card px-3 py-1.5 transition-colors hover:border-primary hover:text-primary"
              >
                thefountainwpb.com ↗
              </a>
              <div className="flex items-center gap-2 px-3 text-text-tertiary">
                <Phone className="h-3 w-3" />
                <span>561-320-3142</span>
              </div>
              <div className="flex items-center gap-2 px-3 text-text-tertiary">
                <MapPin className="h-3 w-3" />
                <span>West Palm Beach, FL</span>
              </div>
            </div>
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

        {/* Positioning */}
        <section className="rounded-xl border-2 border-primary/20 bg-card p-6">
          <p className="text-[10px] font-semibold uppercase tracking-[0.15em] text-text-tertiary">
            Anchor Membership
          </p>
          <h2
            className="mt-2 text-2xl font-semibold text-text-primary"
            style={{ fontFamily: "'Playfair Display', serif" }}
          >
            {MEMBERSHIP_ANCHOR.name}
          </h2>
          <p className="mt-2 text-sm text-text-secondary">{MEMBERSHIP_ANCHOR.positioning}</p>
          <p className="mt-3 text-xs italic text-text-tertiary">
            “Inside-out: diagnostics first, optimization second, aesthetics third — never the
            reverse.”
          </p>
        </section>

        {/* Functional Diagnostics — the lead line */}
        <section>
          <div className="mb-3 flex items-baseline justify-between">
            <h3
              className="text-sm font-semibold text-text-primary"
              style={{ fontFamily: "'Playfair Display', serif" }}
            >
              Functional Diagnostics — lead line
            </h3>
            <span className="text-[10px] text-text-tertiary">4 anchor tests</span>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {FUNCTIONAL_DIAGNOSTICS.map(d => {
              // eslint-disable-next-line @typescript-eslint/naming-convention
              const Icon = d.icon;
              return (
                <article
                  key={d.name}
                  className="rounded-xl border border-border bg-card p-4 transition-all hover:border-primary/40 hover:shadow-md"
                >
                  <Icon className="mb-2 h-5 w-5 text-primary" />
                  <h4 className="text-sm font-semibold text-text-primary">{d.name}</h4>
                  <p className="mt-1 text-xs text-text-secondary">{d.body}</p>
                </article>
              );
            })}
          </div>
        </section>

        {/* Therapeutics + Aesthetics */}
        <section className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-xl border border-border bg-card p-5">
            <h3
              className="mb-3 text-sm font-semibold text-text-primary"
              style={{ fontFamily: "'Playfair Display', serif" }}
            >
              <Pill className="inline h-4 w-4 text-primary" /> Therapeutics
            </h3>
            <ul className="grid grid-cols-2 gap-2">
              {THERAPEUTICS.map(t => (
                <li
                  key={t.name}
                  className="rounded-md border border-border bg-background px-3 py-2 text-xs text-text-primary"
                >
                  {t.name}
                </li>
              ))}
            </ul>
          </div>
          <div className="rounded-xl border border-border bg-card p-5">
            <h3
              className="mb-3 text-sm font-semibold text-text-primary"
              style={{ fontFamily: "'Playfair Display', serif" }}
            >
              <Sparkles className="inline h-4 w-4 text-primary" /> Aesthetics
            </h3>
            <ul className="grid grid-cols-2 gap-2">
              {AESTHETICS.map(t => (
                <li
                  key={t.name}
                  className="rounded-md border border-border bg-background px-3 py-2 text-xs text-text-primary"
                >
                  {t.name}
                </li>
              ))}
            </ul>
            <p className="mt-3 text-[11px] text-text-tertiary">
              Aesthetics are downstream of the diagnostic + therapeutic ladder, not a stand-alone
              medspa.
            </p>
          </div>
        </section>

        {/* Service-mix + PMC portfolio fit */}
        <section className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-xl border border-border bg-card p-5">
            <h3
              className="mb-1 text-sm font-semibold text-text-primary"
              style={{ fontFamily: "'Playfair Display', serif" }}
            >
              Service mix by line count
            </h3>
            <p className="mb-3 text-[11px] text-text-tertiary">
              Therapeutics is the busiest line; diagnostics is the anchor.
            </p>
            <div style={{ height: 240 }}>
              <ResponsiveContainer>
                <BarChart data={serviceMix} margin={{ left: 10 }}>
                  <CartesianGrid stroke="oklch(0.88 0.012 88)" vertical={false} />
                  <XAxis dataKey="name" stroke="oklch(0.22 0.04 255)" fontSize={11} />
                  <YAxis stroke="oklch(0.55 0.018 255)" fontSize={11} />
                  <Tooltip
                    contentStyle={{
                      background: 'oklch(0.985 0.012 88)',
                      border: '1px solid oklch(0.78 0.018 88)',
                      borderRadius: 8,
                      fontSize: 12,
                      color: 'oklch(0.22 0.04 255)',
                    }}
                  />
                  <Bar dataKey="value" fill="var(--primary)" radius={[6, 6, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="rounded-xl border border-border bg-card p-5">
            <h3
              className="mb-1 text-sm font-semibold text-text-primary"
              style={{ fontFamily: "'Playfair Display', serif" }}
            >
              PMC portfolio cross-sell fit
            </h3>
            <p className="mb-3 text-[11px] text-text-tertiary">
              Where Fountain's diagnostics-first model plugs into the rest of the portfolio.
            </p>
            <div style={{ height: 240 }}>
              <ResponsiveContainer>
                <PieChart>
                  <Pie
                    data={PMC_PORTFOLIO_FIT}
                    dataKey="value"
                    nameKey="name"
                    innerRadius={55}
                    outerRadius={95}
                    paddingAngle={3}
                    label={({ name, value }) => `${name}: ${value}%`}
                  >
                    {PMC_PORTFOLIO_FIT.map(p => (
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
        </section>

        {/* Cross-sell notes */}
        <section className="rounded-xl border border-border bg-card p-5">
          <h3
            className="mb-3 text-sm font-semibold text-text-primary"
            style={{ fontFamily: "'Playfair Display', serif" }}
          >
            Cross-sell logic
          </h3>
          <div className="grid gap-2 md:grid-cols-2">
            {PMC_PORTFOLIO_FIT.map(p => (
              <div key={p.name} className="rounded-lg border border-border bg-background p-3">
                <div className="flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full" style={{ background: p.color }} />
                  <p className="text-sm font-medium text-text-primary">{p.name}</p>
                </div>
                <p className="mt-1 text-xs text-text-secondary">{p.note}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Engagement status — sourced from vault */}
        <section className="rounded-xl border border-dashed border-primary/40 bg-card p-5">
          <h3
            className="text-sm font-semibold text-text-primary"
            style={{ fontFamily: "'Playfair Display', serif" }}
          >
            🟢 Core client · build phase
          </h3>
          <p className="mt-2 text-sm text-text-secondary">
            Elevated to core client tier 2026-06-03 (same tier as BioReg). Phase: build — engagement
            scope and module composition still forming. Top blocker: lock the intake conversation
            with Blake to nail down contract structure (retainer vs equipment placement vs
            rev-share) and QEP protocol composition.
          </p>
          <div className="mt-3 grid gap-2 md:grid-cols-2">
            <div className="rounded-md border border-border bg-background p-3">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-text-tertiary">
                Cross-brand pull-through (vault)
              </p>
              <ul className="mt-1 list-inside list-disc space-y-0.5 text-xs text-text-secondary">
                <li>BRT — core in-clinic device + session protocol</li>
                <li>IHHT — co-delivered cellular regeneration modality</li>
                <li>QEP — packaged executive program the stack ladders into</li>
                <li>PMC advisory — positioning, pricing, ops consulting</li>
              </ul>
            </div>
            <div className="rounded-md border border-border bg-background p-3">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-text-tertiary">
                Open questions still pending intake
              </p>
              <ul className="mt-1 list-inside list-disc space-y-0.5 text-xs text-text-secondary">
                <li>Contract structure (retainer / equipment / rev-share / hybrid)</li>
                <li>WPB / South FL exclusivity terms</li>
                <li>First-patient timeline for QEP</li>
                <li>Marketing collaboration scope</li>
              </ul>
            </div>
          </div>
          <p className="mt-3 text-[11px] text-text-tertiary">
            Source: <code>second-brain/businesses/pmc/clients/fountain-wpb/overview.md</code>
          </p>
        </section>

        <footer className="border-t border-border pt-4 text-[10px] text-text-tertiary">
          Source: public site (thefountainwpb.com) + vault overview (
          <code>clients/fountain-wpb/overview.md</code>) · Engagement status synced 2026-06-04
        </footer>
      </div>
    </div>
  );
}
