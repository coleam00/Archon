import {
  CalendarDays,
  MapPin,
  Target,
  ShieldAlert,
  FileText,
  Users,
  Sparkles,
  ExternalLink,
  Video,
  AlertCircle,
} from 'lucide-react';
import prospectsData from '@/lib/business-prospects.generated.json';
import type { BusinessProspect } from '@/components/business/BusinessPage';

/**
 * SADN -- Sarasota Art and Dance Night 2026 partner-outreach engagement.
 *
 * Source of truth:
 *   second-brain/businesses/external-reps/sadn/_sadn.md
 *   second-brain/businesses/external-reps/sadn/messaging/cold-email-touch-1-approved.md
 *
 * Event: 2026-11-15, Art Ovation Hotel, downtown Sarasota
 * Principal: Susan Szantosi (Vividiance LLC)
 */

const PRIORITY_CATEGORIES = [
  'Wealth management & financial advisors',
  'Private banking',
  'Luxury real estate agents & brokerages',
  'Fine jewelry stores',
  'Interior design firms',
  'Home builders and remodelers',
  'Medical spas and cosmetic practices',
  'Boutique fitness and wellness brands',
  'Law firms',
  'Luxury automotive dealerships',
  'Private aviation and yacht-related',
  'High-end retail and lifestyle brands',
  'Upscale restaurants and cocktail lounges',
  'Local businesses targeting affluent Sarasota residents',
];

const EXCLUSIONS = [
  'Art galleries (existing gallery partners)',
  'Hotels (Art Ovation is venue partner)',
  'Dance studios',
];

const OUTREACH_CADENCE = [
  { step: 1, label: 'Email intro OR LinkedIn connection request', timing: 'Day 0' },
  { step: 2, label: 'Phone call', timing: 'Day 2-3' },
  { step: 3, label: 'Follow-up email/call', timing: 'Day 7-10' },
  { step: 4, label: 'Personal invitation to attend the event', timing: 'Day 14+' },
];

const ASSETS = [
  {
    label: 'Community Impact pitch PDF (12 pages)',
    file: 'small_SarasotaArtAndDance_CommunityImpact.pdf',
    use: 'Email follow-up attachment (touch 2 if requested)',
  },
  {
    label: 'Save-the-Date horizontal video',
    file: 'SADN2026 Save the date_TicketsAvailable_Horizontal.mp4',
    use: 'Email signature embed',
  },
  {
    label: 'Save-the-Date vertical video',
    file: 'SADN2026 Save the date_Vertical IG.mp4',
    use: 'Instagram stories / DMs',
  },
  {
    label: '2024 recap on YouTube',
    file: 'youtube.com/watch?v=fvejHofIvvU',
    use: 'LinkedIn message link (Susan wants this cut down -- Vincent handoff?)',
  },
];

export function SADNPage(): React.ReactElement {
  return (
    <div className="flex flex-1 flex-col gap-6 p-6">
      {/* Header */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          <h1 className="text-2xl font-semibold text-text-primary">SADN 2026</h1>
          <span className="rounded bg-amber-950/40 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-300">
            external rep
          </span>
          <span className="rounded bg-green-950/40 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-green-300">
            active
          </span>
          <span className="rounded bg-surface-inset px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-text-secondary">
            volunteer mode (comp tbd)
          </span>
        </div>
        <p className="text-sm text-text-secondary">
          Sarasota Art and Dance Night 2026 -- partner outreach for Susan Szantosi (Vividiance LLC).
          3rd annual cultural event. Jason curates business/community partners against Susan's
          approved ICP and template.
        </p>
      </div>

      {/* Event banner */}
      <div className="rounded-md border border-purple-700/40 bg-purple-950/20 p-4">
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          <div className="flex items-center gap-2">
            <CalendarDays className="h-4 w-4 text-purple-300" />
            <span className="text-sm font-semibold text-purple-200">November 15, 2026</span>
          </div>
          <div className="flex items-center gap-2">
            <MapPin className="h-4 w-4 text-purple-300" />
            <span className="text-sm text-purple-200">Art Ovation Hotel, downtown Sarasota</span>
          </div>
          <div className="flex items-center gap-2">
            <ExternalLink className="h-4 w-4 text-purple-300" />
            <a
              href="https://sarasotaartanddance.com"
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-purple-200 hover:text-purple-100 hover:underline"
            >
              sarasotaartanddance.com
            </a>
          </div>
        </div>
        <p className="mt-3 text-xs text-purple-300/80 italic">
          Visual art + live music + performing arts + social dancing + artist recognition + curated
          networking. Benefits The Creative Bridge Foundation (501(c)(3)) and the Rising Star Award.
        </p>
      </div>

      {/* Principal + positioning */}
      <section className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-md border border-border bg-surface-elevated p-4">
          <h3 className="mb-2 text-sm font-semibold text-text-primary">Principal</h3>
          <dl className="grid grid-cols-[120px_1fr] gap-y-1 text-xs text-text-secondary">
            <dt className="text-text-tertiary">Name:</dt>
            <dd>Susan Szantosi</dd>
            <dt className="text-text-tertiary">Title:</dt>
            <dd>Founder & Cultural Producer (SADN); CEO Vividiance LLC</dd>
            <dt className="text-text-tertiary">Email:</dt>
            <dd>susan@vividiance.com</dd>
            <dt className="text-text-tertiary">Alt email:</dt>
            <dd>contact@sarasotaartanddance.com</dd>
            <dt className="text-text-tertiary">Phone:</dt>
            <dd>(941) 894-4168</dd>
            <dt className="text-text-tertiary">Background:</dt>
            <dd>
              Multidisciplinary artist + 10yr ballroom competitor. Also founded Women in Velocity +
              DancingSRQ.
            </dd>
          </dl>
        </div>

        <div className="rounded-md border border-border bg-surface-elevated p-4">
          <h3 className="mb-2 text-sm font-semibold text-text-primary">
            Susan-approved positioning
          </h3>
          <p className="text-xs text-text-secondary italic mb-2">
            "Join a movement that strengthens Sarasota's cultural economy."
          </p>
          <dl className="grid grid-cols-[100px_1fr] gap-y-1 text-xs text-text-secondary">
            <dt className="text-text-tertiary">Tone:</dt>
            <dd>Elegant. Inspiring. Community-driven. High-quality.</dd>
            <dt className="text-text-tertiary">Frame:</dt>
            <dd>NOT a one-night sponsorship -- a growing cultural platform</dd>
            <dt className="text-text-tertiary">Goal:</dt>
            <dd>Conversation, not immediate sale</dd>
            <dt className="text-text-tertiary">Differentiator:</dt>
            <dd>Partners physically present, not just logos on a flyer</dd>
          </dl>
        </div>
      </section>

      {/* ARC overlap warning */}
      <div className="flex items-start gap-3 rounded-md border border-red-700/40 bg-red-950/20 p-4">
        <ShieldAlert className="mt-0.5 h-5 w-5 flex-shrink-0 text-red-400" />
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium text-red-200">
            Suppression risk: luxury auto dealerships overlap with ARC Brand Agency
          </p>
          <p className="text-xs text-red-300/80">
            "Luxury automotive dealerships" is on Susan's SADN priority list AND on Adam Riley's ARC
            target list. Never send both an ARC cold pitch and an SADN partnership pitch to the same
            Sarasota luxury auto contact in the same week. Proposed split:{' '}
            <span className="font-semibold">ARC owns</span> Sarasota-area independent service
            centers + smaller shops; <span className="font-semibold">SADN owns</span> dealership
            principals + sales / marketing directors at brand-name dealerships.
          </p>
        </div>
      </div>

      {/* Prospect categories */}
      <section className="grid gap-3 lg:grid-cols-2">
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <Target className="h-4 w-4 text-text-secondary" />
            <h2 className="text-base font-semibold text-text-primary">
              Prioritize ({PRIORITY_CATEGORIES.length})
            </h2>
          </div>
          <div className="rounded-md border border-border bg-surface-elevated p-4">
            <ul className="flex flex-col gap-1">
              {PRIORITY_CATEGORIES.map(cat => (
                <li key={cat} className="flex items-start gap-2 text-xs text-text-secondary">
                  <span className="text-green-400">+</span>
                  <span>{cat}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <AlertCircle className="h-4 w-4 text-text-secondary" />
            <h2 className="text-base font-semibold text-text-primary">
              Exclude ({EXCLUSIONS.length})
            </h2>
          </div>
          <div className="rounded-md border border-border bg-surface-elevated p-4">
            <ul className="flex flex-col gap-1">
              {EXCLUSIONS.map(cat => (
                <li key={cat} className="flex items-start gap-2 text-xs text-text-secondary">
                  <span className="text-red-400">-</span>
                  <span>{cat}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      {/* Audience */}
      <section className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <Users className="h-4 w-4 text-text-secondary" />
          <h2 className="text-base font-semibold text-text-primary">Audience profile</h2>
        </div>
        <div className="rounded-md border border-border bg-surface-elevated p-4">
          <p className="text-xs text-text-secondary">
            Business owners, professionals, community leaders, philanthropists, arts supporters, and
            residents who value culture, creativity, and meaningful local connections.
          </p>
        </div>
      </section>

      {/* Outreach cadence */}
      <section className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-text-secondary" />
          <h2 className="text-base font-semibold text-text-primary">
            Outreach cadence (Susan-approved)
          </h2>
        </div>
        <div className="grid gap-2 sm:grid-cols-4">
          {OUTREACH_CADENCE.map(step => (
            <div
              key={step.step}
              className="rounded-md border border-border bg-surface-elevated p-3"
            >
              <div className="mb-1 flex items-center gap-2">
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary/20 text-[10px] font-bold text-primary">
                  {step.step}
                </span>
                <span className="text-[10px] font-mono uppercase tracking-wide text-text-tertiary">
                  {step.timing}
                </span>
              </div>
              <p className="text-xs text-text-primary">{step.label}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Assets */}
      <section className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <Video className="h-4 w-4 text-text-secondary" />
          <h2 className="text-base font-semibold text-text-primary">Assets (Susan's Drive)</h2>
        </div>
        <div className="grid gap-2">
          {ASSETS.map(asset => (
            <div
              key={asset.file}
              className="flex flex-col gap-1 rounded-md border border-border bg-surface-elevated p-3"
            >
              <p className="text-sm font-semibold text-text-primary">{asset.label}</p>
              <p className="text-xs text-text-tertiary">{asset.use}</p>
              <code className="text-[11px] font-mono text-text-tertiary">{asset.file}</code>
            </div>
          ))}
        </div>
      </section>

      {/* Open questions for Susan */}
      <section className="flex flex-col gap-3">
        <h2 className="text-base font-semibold text-text-primary">Open questions for Susan</h2>
        <div className="rounded-md border border-border bg-surface-elevated p-4">
          <ol className="flex flex-col gap-1.5 text-xs text-text-secondary">
            <li>1. Sponsorship tier sheet -- exact entry / mid / top levels + prices?</li>
            <li>2. Compensation for Jason -- pure volunteer, commission, or honorarium?</li>
            <li>
              3. Sending mailbox -- send from{' '}
              <code className="rounded bg-surface-inset px-1">jid5274@gmail.com</code> or provision{' '}
              <code className="rounded bg-surface-inset px-1">jason@sarasotaartanddance.com</code>?
            </li>
            <li>
              4. Calendly handoff -- once prospect says yes to 15-min, book with Jason or Susan?
            </li>
            <li>5. Whose CRM -- Jason's Google Sheet (Susan views) or Susan's existing tracker?</li>
            <li>6. 2024 recap video edit -- Vincent (Creative VA) handoff? Target length?</li>
          </ol>
        </div>
      </section>

      {/* Warm Tier 1 prospects — Jason's prior relationships */}
      <section className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-emerald-800" />
          <h2 className="text-base font-semibold text-text-primary">
            Warm Tier 1 prospects — Jason's prior relationships
          </h2>
        </div>
        <p className="text-xs text-text-secondary">
          Curated from Susan's Sarasota_Businesses sheet + Jason's prior sponsor-track
          relationships. Voice contract: warm, peer-to-peer, single-sentence flattery max, no em
          dashes, sign-off "Jason / Call/text: 412.508.3539".
        </p>
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {((prospectsData.by_business as Record<string, BusinessProspect[]>).SADN ?? []).map(
            (p, idx) => (
              <article
                key={`${p.name}-${idx}`}
                className="rounded-md border border-border bg-surface-elevated p-3"
              >
                <div className="flex items-start justify-between gap-2">
                  <h3 className="text-sm font-medium text-text-primary">{p.name}</h3>
                  {p.tier && (
                    <span className="shrink-0 rounded-md border border-emerald-700/40 bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-800">
                      {p.tier}
                    </span>
                  )}
                </div>
                {p.category && <p className="mt-1 text-[11px] text-text-tertiary">{p.category}</p>}
                {p.ask && (
                  <p className="mt-2 text-[11px] text-text-secondary">
                    <span className="text-text-tertiary">Ask:</span> {p.ask}
                  </p>
                )}
                {p.notes && (
                  <p className="mt-1 text-[11px] italic text-text-secondary">{p.notes}</p>
                )}
              </article>
            )
          )}
        </div>
      </section>

      {/* Vault paths */}
      <section className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <FileText className="h-4 w-4 text-text-secondary" />
          <h2 className="text-base font-semibold text-text-primary">Canon (vault paths)</h2>
        </div>
        <div className="grid gap-2">
          {[
            {
              label: 'SADN engagement MOC + operational playbook',
              path: 'businesses/external-reps/sadn/_sadn.md',
            },
            {
              label: "Susan's approved cold email + prospect criteria + overlap warning",
              path: 'businesses/external-reps/sadn/messaging/cold-email-touch-1-approved.md',
            },
            {
              label: 'External-reps chassis (shared rules)',
              path: 'businesses/external-reps/_external-reps.md',
            },
          ].map(link => (
            <div
              key={link.path}
              className="flex flex-col gap-1 rounded-md border border-border bg-surface-elevated p-3"
            >
              <p className="text-sm font-semibold text-text-primary">{link.label}</p>
              <code className="text-[11px] font-mono text-text-tertiary">{link.path}</code>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
