import { useState } from 'react';
import { AlertCircle, ExternalLink, Activity, BookOpen, ShieldCheck, Target } from 'lucide-react';
import { BRANDS } from '@/lib/brands';

/**
 * VA Workspace — the entry point for Jason's VA team
 * (Louise, James, Trisha, Vincent, Ed) and the Claude-project agent.
 *
 * Source of truth for everything on this page:
 *   second-brain/businesses/pmc/messaging/va-claude-project/VA-PLAYBOOK-PMC-EWC-CONTENT-OPS.md
 *   (dated 2026-05-31, active campaign window 2026-05-31 → 2026-08-31)
 *
 * Apollo metric data is intentionally placeholder until the API/scraper is wired
 * (blocked on plan-tier upgrade — see specs/apollo-wiring-spec.md §Plan-tier blocker).
 */

interface ActiveSequence {
  id: string;
  name: string;
  status: 'live' | 'paused' | 'drafting';
  channel: 'email' | 'linkedin' | 'instagram';
  touches: number;
  vaultPath: string;
  notes?: string;
}

interface CampaignPillar {
  num: 1 | 2 | 3 | 4;
  belief: string;
  challenge: string;
  surface: string;
}

const CAMPAIGN_PILLARS: CampaignPillar[] = [
  {
    num: 1,
    belief: "The system you're in isn't the only option",
    challenge: '"Reimbursements are tight. Burnout is the cost of caring. No exit."',
    surface: 'PMC LinkedIn · EWC IG · Jason personal',
  },
  {
    num: 2,
    belief: 'Visibility problem, not revenue problem',
    challenge: '"My practice is doing fine -- I\'d know if it weren\'t."',
    surface: 'PMC LinkedIn · PMC IG',
  },
  {
    num: 3,
    belief: "Cash-pay isn't a luxury. It's the next default.",
    challenge: '"My patients won\'t pay cash. That\'s for concierge people."',
    surface: 'EWC IG primary',
  },
  {
    num: 4,
    belief: "You don't need to assemble it yourself",
    challenge: '"I\'d love to make the leap but don\'t have time to figure out which vendors."',
    surface: 'EWC IG · occasional PMC',
  },
];

const COMPLIANCE_GATES = [
  "Approval flow: nothing ships without Jason's explicit OK.",
  'No named entities (health systems, payers, pharma, insurers) in the body without prior approval. Source citations OK.',
  'Every claim has a tier 1-3 source: peer-reviewed > regulatory > government > major investigative journalism.',
  'Medical-adjacent: no FDA disease claims on BRT content. No specific medical advice. Composite cases labeled.',
];

/**
 * Real active sequences per brand, sourced from the vault.
 * Metrics live behind the "needs API wiring" banner until Apollo is connected.
 */
const ACTIVE_SEQUENCES: Record<string, ActiveSequence[]> = {
  pmc: [
    {
      id: 'pmc-apollo-4touch',
      name: 'PMC Apollo Cold Sequence (4 touches)',
      status: 'live',
      channel: 'email',
      touches: 4,
      vaultPath: 'businesses/pmc/messaging/apollo-sequence.md',
      notes:
        'Voss-calibrated open, labeling mid-sequence, no-oriented close. Physician = hero, PMC = guide. Replaces retired Apr-2026 sample sequence.',
    },
    {
      id: 'pmc-apollo-6step-abc',
      name: 'PMC Apollo 6-Step (A/B/C variant)',
      status: 'live',
      channel: 'email',
      touches: 6,
      vaultPath: 'businesses/pmc/messaging/apollo-6step-abc.md',
      notes: 'A/B/C variant testing. Physician-owner ICP, 1-8 providers.',
    },
    {
      id: 'pmc-heyreach-li',
      name: 'PMC HeyReach LinkedIn Campaign v1',
      status: 'live',
      channel: 'linkedin',
      touches: 5,
      vaultPath: 'businesses/pmc/messaging/heyreach-campaign-plan-pmc-v1.md',
      notes: 'Ed owns execution. NEPQ-informed connection + DM cadence.',
    },
  ],
  brt: [
    {
      id: 'brt-apollo-cold',
      name: 'BioReg Apollo Cold Outreach Sequences',
      status: 'live',
      channel: 'email',
      touches: 4,
      vaultPath: 'businesses/pmc/bioreg/sales/apollo-sequences.md',
      notes:
        'Deliverability-engineered for physician inboxes. Plain text, <120 words, no exclamations, 15-20/day ramp.',
    },
    {
      id: 'brt-ig-bioreg-tech',
      name: '@bioreg.tech IG — Cross-brand trust layer',
      status: 'live',
      channel: 'instagram',
      touches: 0,
      vaultPath: 'businesses/pmc/bioreg/',
      notes:
        'Patient-warm, pattern-first. Never lead with the device. Schwartz Unaware register. Trisha owns posting cadence.',
    },
  ],
  ttts: [
    {
      id: 'ttts-closed-door',
      name: 'TTTS Closed-Door 12-Founder Session (June 27, 2026)',
      status: 'live',
      channel: 'email',
      touches: 0,
      vaultPath: 'projects/events/ttts-june-2026/',
      notes:
        'Demoted from top objective 2026-05-13. Pivoted to invitation-only Sarasota session. BD asset feeding PMC + EWC pipelines.',
    },
  ],
  ewc: [
    {
      id: 'ewc-practice-transformation-avatars',
      name: 'EWC Practice Transformation Outbound — 3 avatar variants',
      status: 'drafting',
      channel: 'email',
      touches: 5,
      vaultPath: 'businesses/pmc/ewc/apollo-sequence-spec.md',
      notes:
        'Spec-ready 5-step Apollo sequence for Frustrated PCP, Ambitious DPC Founder, and Medical Spa Owner lanes. Pending Jason Option A ratification before Apollo launch.',
    },
  ],
  ihht: [],
  qep: [],
};

const CANON_LINKS = [
  {
    label: 'VA Playbook — PMC + EWC Content Ops (Master)',
    path: 'businesses/pmc/messaging/va-claude-project/VA-PLAYBOOK-PMC-EWC-CONTENT-OPS.md',
    description: 'Read this once. Upload to your Claude project. Single source of truth.',
  },
  {
    label: 'Brand Voice Canon',
    path: 'resources/brand/_brand-voice.md',
    description: 'PMC quiet-luxury, EWC Sage/Hero/Partner, BRT clinical. Pre-write check.',
  },
  {
    label: 'Framework Cheatsheet',
    path: 'frameworks/canonical-reference.md',
    description: 'Welsh OS, atomic essay, Hormozi hooks, Voss labeling, NEPQ, 10-slide carousel.',
  },
  {
    label: 'Firehose-to-Poignant Funnel',
    path: 'businesses/pmc/messaging/va-claude-project/01-firehose-to-poignant-funnel.md',
    description: 'Daily content discipline. Raw input → on-thesis draft.',
  },
  {
    label: 'Trisha — Social addendum',
    path: 'businesses/pmc/messaging/va-claude-project/02-trisha-social-addendum.md',
    description: 'Trisha role canon.',
  },
  {
    label: 'Vincent — Creative addendum',
    path: 'businesses/pmc/messaging/va-claude-project/03-vincent-creative-addendum.md',
    description: 'Vincent role canon.',
  },
  {
    label: 'Ed — LinkedIn addendum',
    path: 'businesses/pmc/messaging/va-claude-project/04-ed-linkedin-addendum.md',
    description: 'Ed role canon.',
  },
  {
    label: 'Louise — PM Router addendum',
    path: 'businesses/pmc/messaging/va-claude-project/05-louise-pm-router-addendum.md',
    description: 'Louise role canon (Main PM / ambiguous-ask router).',
  },
  {
    label: 'James — Asst PM addendum',
    path: 'businesses/pmc/messaging/va-claude-project/06-james-asst-pm-addendum.md',
    description: 'James role canon.',
  },
];

export function SocialContentPage(): React.ReactElement {
  const [activeSlug, setActiveSlug] = useState<string>(BRANDS[0].slug);
  const activeBrand = BRANDS.find(b => b.slug === activeSlug) ?? BRANDS[0];
  const sequences = ACTIVE_SEQUENCES[activeSlug] ?? [];

  return (
    <div className="flex flex-1 flex-col gap-6 p-6">
      {/* Header */}
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold text-text-primary">
          VA Workspace — Content & Outbound
        </h1>
        <p className="text-sm text-text-secondary">
          Active campaign and live outbound sequences for the PMC portfolio. North-star metric:{' '}
          <span className="font-semibold text-text-primary">first meetings booked per week</span>{' '}
          (Day-30 target 8/wk · Day-90 15/wk).
        </p>
      </div>

      {/* Active campaign banner */}
      <div className="flex items-start gap-3 rounded-md border border-emerald-700/40 bg-emerald-100 p-4">
        <Target className="mt-0.5 h-5 w-5 flex-shrink-0 text-emerald-700" />
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium text-emerald-900">
            Active Campaign: 2026-05-31 → 2026-08-31 (60-90 day window)
          </p>
          <p className="text-xs text-emerald-800">
            <span className="font-medium">Two throughlines:</span>{' '}
            <span className="italic">
              "Your practice was the dream. Built for the physicians who refused to quit caring."
            </span>{' '}
            (PMC LinkedIn primary) ·{' '}
            <span className="italic">"Independent medicine, reengineered."</span> (EWC IG primary).
          </p>
          <p className="text-xs text-emerald-800">
            We are subliminally challenging how readers see healthcare while championing the
            independent physician.{' '}
            <span className="font-semibold">
              Advocate, not crusader. Invitational, never preachy.
            </span>
          </p>
        </div>
      </div>

      {/* The 4 Campaign Pillars */}
      <section className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <Target className="h-4 w-4 text-text-secondary" />
          <h2 className="text-base font-semibold text-text-primary">
            The 4 Campaign Pillars (pick ONE per piece)
          </h2>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {CAMPAIGN_PILLARS.map(pillar => (
            <div
              key={pillar.num}
              className="rounded-md border border-border bg-surface-elevated p-4"
            >
              <div className="mb-2 flex items-center gap-2">
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/20 text-xs font-bold text-primary">
                  {pillar.num}
                </span>
                <h3 className="text-sm font-semibold text-text-primary">{pillar.belief}</h3>
              </div>
              <p className="mb-1 text-xs italic text-text-tertiary">
                Belief being challenged: {pillar.challenge}
              </p>
              <p className="text-[11px] font-mono uppercase tracking-wide text-text-tertiary">
                Best surface: {pillar.surface}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* Compliance Gates */}
      <section className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-text-secondary" />
          <h2 className="text-base font-semibold text-text-primary">
            4 Hard Compliance Gates (clear ALL 4 before submit)
          </h2>
        </div>
        <div className="rounded-md border border-rose-700/40 bg-rose-100 p-4">
          <ol className="flex flex-col gap-2 text-xs text-rose-900">
            {COMPLIANCE_GATES.map((gate, i) => (
              <li key={i} className="flex gap-2">
                <span className="font-semibold text-rose-700">{i + 1}.</span>
                <span>{gate}</span>
              </li>
            ))}
          </ol>
          <p className="mt-3 border-t border-rose-700/30 pt-2 text-[11px] text-rose-800">
            <span className="font-semibold">Universal voice rules:</span> No em-dashes (use{' '}
            <code className="rounded bg-surface-inset px-1 py-0.5">--</code>). Precise odd numbers
            only ($147,200, not $150K). Physician = hero, PMC/EWC = guide. One controlling idea per
            post.
          </p>
        </div>
      </section>

      {/* Subtab nav */}
      <div className="flex flex-wrap gap-1 border-b border-border">
        {BRANDS.map(brand => {
          const isActive = brand.slug === activeSlug;
          const seqCount = (ACTIVE_SEQUENCES[brand.slug] ?? []).length;
          return (
            <button
              key={brand.slug}
              onClick={(): void => {
                setActiveSlug(brand.slug);
              }}
              className={`flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                isActive
                  ? 'border-primary text-primary'
                  : 'border-transparent text-text-secondary hover:text-text-primary'
              }`}
            >
              {brand.label}
              {seqCount > 0 && (
                <span
                  className={`inline-flex min-w-[1.25rem] items-center justify-center rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
                    isActive
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-surface-inset text-text-secondary'
                  }`}
                >
                  {seqCount}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Brand context card */}
      <div className="rounded-md border border-border bg-surface-elevated p-4">
        <div className="mb-2 flex items-center gap-2">
          <span className="rounded bg-primary/10 px-2 py-0.5 text-xs font-mono font-semibold text-primary">
            [{activeBrand.apolloPrefix}]
          </span>
          <h2 className="text-base font-semibold text-text-primary">{activeBrand.label} ICP</h2>
        </div>
        <p className="text-sm text-text-secondary">{activeBrand.icp}</p>
        {activeBrand.adjacentIcps.length > 0 && (
          <p className="mt-2 text-xs text-text-tertiary">
            <span className="font-semibold">Adjacent ICPs:</span>{' '}
            {activeBrand.adjacentIcps.join(' · ')}
          </p>
        )}
      </div>

      {/* Apollo wiring notice */}
      <div className="flex items-start gap-3 rounded-md border border-amber-700/40 bg-amber-100 p-4">
        <AlertCircle className="mt-0.5 h-5 w-5 flex-shrink-0 text-amber-700" />
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium text-amber-900">
            Live metrics pending — Apollo API wiring in progress
          </p>
          <p className="text-xs text-amber-800">
            Sequence names, channels, and vault paths below are real and current. Performance
            metrics (sent, open, reply, booked) will populate once the Apollo plan-tier blocker is
            resolved.{' '}
            <a
              href="https://app.apollo.io/#/settings/plans"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 font-medium text-amber-900 hover:text-amber-700"
            >
              Apollo plan settings <ExternalLink className="h-3 w-3" />
            </a>
          </p>
        </div>
      </div>

      {/* Active sequences */}
      <section className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-text-secondary" />
          <h2 className="text-base font-semibold text-text-primary">
            Active Sequences & Campaigns ({sequences.length})
          </h2>
        </div>
        {sequences.length === 0 ? (
          <div className="rounded-md border border-dashed border-border bg-surface-elevated p-6 text-center">
            <p className="text-sm text-text-secondary">
              No active sequences for {activeBrand.label} yet.
            </p>
            <p className="mt-1 text-xs text-text-tertiary">
              When a sequence launches in Apollo, prefix the name with{' '}
              <code className="rounded bg-surface-inset px-1 py-0.5 font-mono text-text-primary">
                [{activeBrand.apolloPrefix}]
              </code>{' '}
              and add a vault doc under{' '}
              <code className="rounded bg-surface-inset px-1 py-0.5 font-mono text-text-primary">
                businesses/pmc/{activeBrand.slug}/
              </code>
              .
            </p>
          </div>
        ) : (
          <div className="grid gap-3">
            {sequences.map(seq => (
              <div key={seq.id} className="rounded-md border border-border bg-surface-elevated p-4">
                <div className="mb-2 flex items-start justify-between gap-3">
                  <div className="flex flex-col gap-1">
                    <h3 className="text-sm font-semibold text-text-primary">{seq.name}</h3>
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={`inline-flex w-fit items-center rounded px-2 py-0.5 text-[10px] font-medium ${
                          seq.status === 'live'
                            ? 'bg-emerald-100 text-emerald-800 border border-emerald-700/40'
                            : seq.status === 'drafting'
                              ? 'bg-blue-100 text-blue-800 border border-blue-700/40'
                              : 'bg-surface-inset text-text-secondary'
                        }`}
                      >
                        {seq.status}
                      </span>
                      <span className="inline-flex w-fit items-center rounded bg-surface-inset px-2 py-0.5 text-[10px] font-medium text-text-secondary capitalize">
                        {seq.channel}
                      </span>
                      {seq.touches > 0 && (
                        <span className="text-[11px] font-mono text-text-tertiary">
                          {seq.touches} touch{seq.touches === 1 ? '' : 'es'}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
                {seq.notes && <p className="mb-2 text-xs text-text-secondary">{seq.notes}</p>}
                <p className="text-[11px] font-mono text-text-tertiary">
                  <span className="text-text-tertiary">Vault:</span>{' '}
                  <code className="rounded bg-surface-inset px-1 py-0.5">{seq.vaultPath}</code>
                </p>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Canon links */}
      <section className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <BookOpen className="h-4 w-4 text-text-secondary" />
          <h2 className="text-base font-semibold text-text-primary">
            Canon — Read Before You Write
          </h2>
        </div>
        <p className="text-xs text-text-tertiary">
          Source-of-truth docs in the second-brain vault. Upload the VA Playbook (top) to your
          Claude project; Claude reads the rest as needed.
        </p>
        <div className="grid gap-2">
          {CANON_LINKS.map(link => (
            <div
              key={link.path}
              className="flex flex-col gap-1 rounded-md border border-border bg-surface-elevated p-3"
            >
              <p className="text-sm font-semibold text-text-primary">{link.label}</p>
              <p className="text-xs text-text-secondary">{link.description}</p>
              <p className="text-[11px] font-mono text-text-tertiary">
                <code className="rounded bg-surface-inset px-1 py-0.5">{link.path}</code>
              </p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
