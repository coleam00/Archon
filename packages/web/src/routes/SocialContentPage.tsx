import { useState } from 'react';
import { AlertCircle, ExternalLink, Sparkles, Activity } from 'lucide-react';
import { BRANDS, type BrandDef } from '@/lib/brands';

/**
 * Mock sequence shape — matches what the real Apollo `/api/apollo/sequences`
 * endpoint will return once wired. Keeps the page contract stable so swapping
 * mock for live data is a one-line change.
 */
interface MockSequence {
  id: string;
  name: string;
  status: 'active' | 'paused';
  contacts: number;
  emailsSent: number;
  openRate: number;
  replyRate: number;
  bookedMeetings: number;
}

/**
 * Sample data per brand. Every brand gets at least one sequence so VAs can
 * see the layout shape during the demo. Real data lands once Apollo API key
 * is provisioned.
 */
const MOCK_SEQUENCES: Record<string, MockSequence[]> = {
  pmc: [
    {
      id: 'pmc-1',
      name: '[PMC] Cold Outreach v3',
      status: 'active',
      contacts: 240,
      emailsSent: 612,
      openRate: 0.41,
      replyRate: 0.06,
      bookedMeetings: 8,
    },
    {
      id: 'pmc-2',
      name: '[PMC] Re-engage Stalled Pipeline',
      status: 'active',
      contacts: 87,
      emailsSent: 174,
      openRate: 0.52,
      replyRate: 0.11,
      bookedMeetings: 4,
    },
  ],
  brt: [
    {
      id: 'brt-1',
      name: '[BRT] Wellness Clinic Cold v2',
      status: 'active',
      contacts: 312,
      emailsSent: 856,
      openRate: 0.38,
      replyRate: 0.04,
      bookedMeetings: 6,
    },
  ],
  tts: [
    {
      id: 'tts-1',
      name: '[TTS] June Sponsor Outreach',
      status: 'active',
      contacts: 45,
      emailsSent: 90,
      openRate: 0.62,
      replyRate: 0.18,
      bookedMeetings: 3,
    },
  ],
  'sg-ink': [],
  naba: [],
  ihht: [],
  qep: [],
};

/**
 * Mock recommendations — once we wire the LLM, these come from a backend
 * `/api/apollo/recommendations/:sequenceId/:targetIcp` endpoint.
 */
function getMockRecommendations(brand: BrandDef): {
  targetIcp: string;
  hook: string;
  rationale: string;
}[] {
  return brand.adjacentIcps.map(icp => ({
    targetIcp: icp,
    hook: `[Sample] Tailored opener referencing ${icp.toLowerCase()}-specific pain points.`,
    rationale: `[Sample] This adjacent ICP shares the buying motion of the core ${brand.label} ICP but cares more about [specific outcome]. Adjust subject line + first paragraph; keep CTA.`,
  }));
}

export function SocialContentPage(): React.ReactElement {
  const [activeSlug, setActiveSlug] = useState<string>(BRANDS[0].slug);
  const activeBrand = BRANDS.find(b => b.slug === activeSlug) ?? BRANDS[0];
  const sequences = MOCK_SEQUENCES[activeSlug] ?? [];
  const recommendations = getMockRecommendations(activeBrand);

  return (
    <div className="flex flex-1 flex-col gap-6 p-6">
      {/* Header */}
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold text-text-primary">Social Content</h1>
        <p className="text-sm text-text-secondary">
          Active Apollo sequences and AI-tailored ICP variants, per brand.
        </p>
      </div>

      {/* Connect Apollo banner */}
      <div className="flex items-start gap-3 rounded-md border border-amber-700/40 bg-amber-950/30 p-4">
        <AlertCircle className="mt-0.5 h-5 w-5 flex-shrink-0 text-amber-400" />
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium text-amber-200">
            Apollo plan upgrade required — showing sample data
          </p>
          <p className="text-xs text-amber-300/80">
            The Apollo Professional Monthly plan does not include API data access. Read endpoints
            (sequences, contacts) return{' '}
            <code className="rounded bg-zinc-800 px-1 py-0.5 text-zinc-200">
              403 API_INACCESSIBLE
            </code>
            . Resolution path: upgrade to Apollo Organization (annual) OR build a Playwright scraper
            as a stopgap. Decision pending — see{' '}
            <code className="rounded bg-zinc-800 px-1 py-0.5 text-zinc-200">
              specs/apollo-wiring-spec.md
            </code>{' '}
            §Plan-tier blocker.
          </p>
          <a
            href="https://app.apollo.io/#/settings/plans"
            target="_blank"
            rel="noopener noreferrer"
            className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-amber-200 hover:text-amber-100"
          >
            Apollo plan settings <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      </div>

      {/* Subtab nav */}
      <div className="flex flex-wrap gap-1 border-b border-border">
        {BRANDS.map(brand => {
          const isActive = brand.slug === activeSlug;
          const seqCount = (MOCK_SEQUENCES[brand.slug] ?? []).length;
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
                    isActive ? 'bg-primary text-primary-foreground' : 'bg-zinc-800 text-zinc-300'
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
      </div>

      {/* Active sequences */}
      <section className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-text-secondary" />
          <h2 className="text-base font-semibold text-text-primary">
            Active Sequences ({sequences.length})
          </h2>
        </div>
        {sequences.length === 0 ? (
          <div className="rounded-md border border-dashed border-border bg-surface-elevated p-6 text-center">
            <p className="text-sm text-text-secondary">No sequences for {activeBrand.label} yet.</p>
            <p className="mt-1 text-xs text-text-tertiary">
              In Apollo, prefix any sequence name with{' '}
              <code className="rounded bg-zinc-800 px-1 py-0.5 font-mono text-zinc-200">
                [{activeBrand.apolloPrefix}]
              </code>{' '}
              to surface it here.
            </p>
          </div>
        ) : (
          <div className="grid gap-3">
            {sequences.map(seq => (
              <div key={seq.id} className="rounded-md border border-border bg-surface-elevated p-4">
                <div className="mb-3 flex items-start justify-between gap-3">
                  <div className="flex flex-col">
                    <h3 className="text-sm font-semibold text-text-primary">{seq.name}</h3>
                    <span
                      className={`mt-1 inline-flex w-fit items-center rounded px-2 py-0.5 text-[10px] font-medium ${
                        seq.status === 'active'
                          ? 'bg-green-950/50 text-green-400'
                          : 'bg-zinc-800 text-zinc-400'
                      }`}
                    >
                      {seq.status}
                    </span>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                  <Metric label="Contacts" value={seq.contacts.toLocaleString()} />
                  <Metric label="Sent" value={seq.emailsSent.toLocaleString()} />
                  <Metric label="Open" value={`${(seq.openRate * 100).toFixed(0)}%`} />
                  <Metric label="Reply" value={`${(seq.replyRate * 100).toFixed(0)}%`} />
                  <Metric label="Booked" value={seq.bookedMeetings.toString()} />
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Recommendations panel */}
      <section className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-text-secondary" />
          <h2 className="text-base font-semibold text-text-primary">Tailoring Recommendations</h2>
          <span className="rounded bg-zinc-800 px-2 py-0.5 text-[10px] font-medium text-zinc-400">
            Sample
          </span>
        </div>
        <p className="text-xs text-text-tertiary">
          AI-generated variants of {activeBrand.label} sequences adapted for adjacent ICPs. Real
          recommendations require LLM credentials in the dashboard env.
        </p>
        <div className="grid gap-3">
          {recommendations.map(rec => (
            <div
              key={rec.targetIcp}
              className="rounded-md border border-border bg-surface-elevated p-4"
            >
              <div className="mb-2 flex items-center gap-2">
                <span className="text-xs font-medium text-text-tertiary">Target ICP:</span>
                <span className="text-sm font-semibold text-text-primary">{rec.targetIcp}</span>
              </div>
              <p className="mb-2 text-sm text-text-secondary">
                <span className="text-text-tertiary">Hook:</span> {rec.hook}
              </p>
              <p className="text-xs text-text-tertiary">
                <span className="font-medium">Why:</span> {rec.rationale}
              </p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <div className="flex flex-col">
      <span className="text-[10px] uppercase tracking-wide text-text-tertiary">{label}</span>
      <span className="text-sm font-mono font-semibold text-text-primary">{value}</span>
    </div>
  );
}
