import {
  CalendarDays,
  CheckCircle2,
  ExternalLink,
  FileText,
  Mail,
  MapPin,
  Phone,
  ShieldAlert,
  Sparkles,
  Target,
  Users,
  Video,
} from 'lucide-react';
import prospectsData from '@/lib/business-prospects.generated.json';
import type { BusinessProspect } from '@/components/business/BusinessPage';

interface MetricCardProps {
  label: string;
  value: string;
  note: string;
  tone?: 'green' | 'amber' | 'rose' | 'purple' | 'blue';
}

interface PipelineItem {
  company: string;
  lane: string;
  status: string;
  next: string;
}

interface ActionItem {
  title: string;
  owner: string;
  timing: string;
  proof: string;
}

interface LaneItem {
  label: string;
  rule: string;
}

const METRICS: MetricCardProps[] = [
  { label: 'Original batch', value: '47 sent', note: '0 failed, 0 bounces found', tone: 'green' },
  {
    label: 'Inbound replies',
    value: '6',
    note: 'Robb warm issue, Sarasota Ford review + decline',
    tone: 'blue',
  },
  { label: 'Next wave', value: '50', note: 'Curated targets with lane logic', tone: 'purple' },
  {
    label: 'Drafts ready',
    value: '8',
    note: 'Gmail drafts staged with reel + sponsor PDF',
    tone: 'green',
  },
  {
    label: 'Phone path',
    value: '2',
    note: 'Holcomb-Kreithen and Dolphin scripts ready',
    tone: 'amber',
  },
  {
    label: 'Primary goal',
    value: 'meetings',
    note: 'Partner conversations before category commitments',
    tone: 'green',
  },
];

const STAGED_DRAFTS: PipelineItem[] = [
  {
    company: 'Nautilus Homes',
    lane: 'Luxury home / design',
    status: 'Gmail draft ready',
    next: 'Review and send',
  },
  {
    company: 'John Cannon Homes',
    lane: 'Luxury home / design',
    status: 'Gmail draft ready',
    next: 'Review and send',
  },
  {
    company: 'Shumaker Sarasota',
    lane: 'Professional prestige',
    status: 'Gmail draft ready',
    next: 'Review and send',
  },
  {
    company: 'Douglas Elliman Sarasota',
    lane: 'Luxury real estate',
    status: 'Gmail draft ready',
    next: 'Sent-to-both rule applied',
  },
  {
    company: 'Engel & Volkers LWR',
    lane: 'Luxury real estate',
    status: 'Gmail draft ready',
    next: 'Review and send',
  },
  {
    company: 'Caldwell Trust',
    lane: 'Wealth / trust',
    status: 'Gmail draft ready',
    next: 'Review and send',
  },
  {
    company: 'Cumberland Advisors',
    lane: 'Wealth advisory',
    status: 'Gmail draft ready',
    next: 'Review and send',
  },
  {
    company: 'SRQ Media',
    lane: 'Media / community',
    status: 'Gmail draft ready',
    next: 'Ask for meeting to determine lane',
  },
];

const HOT_FOLLOW_UPS: PipelineItem[] = [
  {
    company: 'Robb & Stucky',
    lane: 'Luxury design',
    status: 'Corporate reviewing',
    next: 'Pending call with corporate review path',
  },
  {
    company: 'Sarasota Ford / Lincoln',
    lane: 'Luxury auto',
    status: 'Declined 2026 budget',
    next: 'Relationship-save note, ask 2027 window',
  },
  {
    company: 'Mercedes-Benz of Sarasota',
    lane: 'Luxury auto',
    status: 'Non-responder',
    next: 'Second follow-up',
  },
  {
    company: 'Sarasota Yacht Club',
    lane: 'Luxury / community',
    status: 'Non-responder',
    next: 'Second follow-up',
  },
  {
    company: 'Northern Trust Sarasota',
    lane: 'Private wealth',
    status: 'Non-responder',
    next: 'Second follow-up',
  },
  {
    company: "Premier Sotheby's",
    lane: 'Luxury real estate',
    status: 'Non-responder',
    next: 'Second follow-up',
  },
];

const MANUAL_ACTIONS: ActionItem[] = [
  {
    title: 'Send 8 staged drafts',
    owner: 'Jason',
    timing: 'Now',
    proof: 'Draft IDs logged in staging file',
  },
  {
    title: 'Call Holcomb-Kreithen',
    owner: 'Jason',
    timing: 'Next call block',
    proof: 'Phone script ready',
  },
  {
    title: 'Call Dolphin Aviation',
    owner: 'Jason',
    timing: 'Next call block',
    proof: 'Phone script ready',
  },
  {
    title: 'Resend Robb & Stucky links',
    owner: 'Jason / Carlos',
    timing: 'Now',
    proof: 'Warm operational issue',
  },
  {
    title: 'Run second follow-up to top non-responders',
    owner: 'Carlos stages, Jason sends',
    timing: 'After staged 8',
    proof: 'Template in audit brief',
  },
];

const RULES: LaneItem[] = [
  {
    label: 'Category overlap',
    rule: 'Pitch multiple prospects first. Use exclusivity only after real interest.',
  },
  {
    label: 'Approved categories',
    rule: 'Luxury, professional services, wealth, wellness, art/dance adjacent.',
  },
  { label: 'Restaurants', rule: 'Case by case only. Must be high-end and strategically useful.' },
  {
    label: 'SRQ Media',
    rule: 'Position as a high-end night of luxury performances. Get the meeting, determine lane later.',
  },
  {
    label: 'Alternate paths',
    rule: 'Offer cash sponsor, custom activation, VIP alignment, in-kind, media/community, or hybrid.',
  },
  { label: 'Landmines', rule: 'Jason confirmed none in the current staged wave.' },
];

const ASSETS = [
  {
    label: 'Luxury sponsor reel',
    file: 'video-projects/sarasota-art-dance-luxury-sponsor-reel/sarasota-art-dance-luxury-sponsor-reel.mp4',
    use: 'Attached to staged sponsor drafts',
  },
  {
    label: 'Susan sponsorship PDF',
    file: 'businesses/external-reps/sadn/attachments/2026-05-20-susan-small-sponsorship-opportunities.pdf',
    use: 'Attached to staged sponsor drafts',
  },
  {
    label: 'Second follow-up template',
    file: 'intelligence/briefs/2026-06-26-sadn-outreach-audit-and-next-50.md',
    use: 'Short follow-up for non-responders',
  },
  {
    label: 'Phone scripts',
    file: 'drafts/2026-06-26-sadn-phone-scripts-hk-dolphin.md',
    use: 'Holcomb-Kreithen and Dolphin Aviation routing calls',
  },
];

const VAULT_LINKS = [
  {
    label: 'SADN master audit and next 50',
    path: 'intelligence/briefs/2026-06-26-sadn-outreach-audit-and-next-50.md',
  },
  {
    label: 'Next 50 target list',
    path: 'businesses/external-reps/sadn/prospects/sadn-next-50-targets-2026-06-26.csv',
  },
  {
    label: 'Draft staging log',
    path: 'businesses/external-reps/sadn/prospects/sadn-next-wave-10-draft-staging-2026-06-26.md',
  },
  {
    label: 'Contact verification',
    path: 'businesses/external-reps/sadn/prospects/sadn-next-wave-20-contact-verification-2026-06-26.csv',
  },
  { label: 'Phone scripts', path: 'drafts/2026-06-26-sadn-phone-scripts-hk-dolphin.md' },
  { label: 'Engagement MOC', path: 'businesses/external-reps/sadn/_sadn.md' },
];

function toneClasses(tone: MetricCardProps['tone']): string {
  if (tone === 'green') return 'border-emerald-700/30 bg-emerald-100 text-emerald-900';
  if (tone === 'amber') return 'border-amber-700/30 bg-amber-100 text-amber-900';
  if (tone === 'rose') return 'border-rose-700/30 bg-rose-100 text-rose-900';
  if (tone === 'purple') return 'border-purple-700/30 bg-purple-100 text-purple-900';
  return 'border-blue-700/30 bg-blue-100 text-blue-900';
}

function MetricCard({ label, value, note, tone = 'blue' }: MetricCardProps): React.ReactElement {
  return (
    <div className={`rounded-lg border p-4 ${toneClasses(tone)}`}>
      <p className="text-[10px] font-medium uppercase tracking-wide opacity-80">{label}</p>
      <p className="mt-1 text-2xl font-semibold">{value}</p>
      <p className="mt-1 text-xs opacity-80">{note}</p>
    </div>
  );
}

function PipelineCard({ item }: { item: PipelineItem }): React.ReactElement {
  return (
    <div className="rounded-md border border-border bg-surface-inset p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-text-primary">{item.company}</p>
          <p className="mt-1 text-[11px] text-text-tertiary">{item.lane}</p>
        </div>
        <span className="rounded-full bg-surface-elevated px-2 py-0.5 text-[10px] font-medium text-text-secondary">
          {item.status}
        </span>
      </div>
      <p className="mt-2 text-xs text-text-secondary">Next: {item.next}</p>
    </div>
  );
}

interface SADNPageProps {
  publicView?: boolean;
}

export function SADNPage({ publicView = false }: SADNPageProps = {}): React.ReactElement {
  return (
    <div className="flex flex-1 flex-col gap-6 p-6">
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold text-text-primary">SADN 2026</h1>
          <span className="rounded border border-amber-700/40 bg-amber-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-800">
            external rep
          </span>
          <span className="rounded border border-emerald-700/40 bg-emerald-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-800">
            active outreach
          </span>
          <span className="rounded border border-purple-700/40 bg-purple-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-purple-800">
            luxury partner pipeline
          </span>
        </div>
        <p className="max-w-4xl text-sm text-text-secondary">
          Sarasota Art and Dance Night partner-outreach command center. Built to keep Susan's
          sponsor pipeline organized, protect category strategy, and maximize first meetings from a
          curated, premium prospect universe.
        </p>
      </div>

      <div className="rounded-lg border border-purple-700/40 bg-purple-100 p-4">
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          <div className="flex items-center gap-2">
            <CalendarDays className="h-4 w-4 text-purple-700" />
            <span className="text-sm font-semibold text-purple-900">November 15, 2026</span>
          </div>
          <div className="flex items-center gap-2">
            <MapPin className="h-4 w-4 text-purple-700" />
            <span className="text-sm text-purple-900">Art Ovation Hotel, downtown Sarasota</span>
          </div>
          <div className="flex items-center gap-2">
            <ExternalLink className="h-4 w-4 text-purple-700" />
            <a
              href="https://sarasotaartanddance.com"
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-purple-900 hover:text-purple-700 hover:underline"
            >
              sarasotaartanddance.com
            </a>
          </div>
        </div>
        <p className="mt-3 text-xs text-purple-800 italic">
          High-end evening of art, dance, luxury performances, curated networking, and community
          visibility.
        </p>
      </div>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
        {METRICS.map(metric => (
          <MetricCard key={metric.label} {...metric} />
        ))}
      </section>

      <section className="grid gap-3 lg:grid-cols-[1fr_1fr]">
        <div className="rounded-lg border border-border bg-surface-elevated p-4">
          <div className="mb-3 flex items-center gap-2">
            <Target className="h-4 w-4 text-text-secondary" />
            <h2 className="text-base font-semibold text-text-primary">
              Next actions to win meetings
            </h2>
          </div>
          <div className="space-y-2">
            {MANUAL_ACTIONS.map(action => (
              <div
                key={action.title}
                className="rounded-md border border-border bg-surface-inset p-3"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-text-primary">{action.title}</p>
                    <p className="mt-1 text-xs text-text-secondary">{action.proof}</p>
                  </div>
                  <span className="rounded-full bg-surface-elevated px-2 py-0.5 text-[10px] font-medium text-text-secondary">
                    {action.timing}
                  </span>
                </div>
                <p className="mt-2 text-[11px] text-text-tertiary">Owner: {action.owner}</p>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-lg border border-border bg-surface-elevated p-4">
          <div className="mb-3 flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-text-secondary" />
            <h2 className="text-base font-semibold text-text-primary">Rules Jason approved</h2>
          </div>
          <div className="space-y-2">
            {RULES.map(rule => (
              <div
                key={rule.label}
                className="rounded-md border border-border bg-surface-inset p-3"
              >
                <p className="text-sm font-semibold text-text-primary">{rule.label}</p>
                <p className="mt-1 text-xs text-text-secondary">{rule.rule}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="grid gap-3 xl:grid-cols-2">
        <div className="rounded-lg border border-border bg-surface-elevated p-4">
          <div className="mb-3 flex items-center gap-2">
            <Mail className="h-4 w-4 text-text-secondary" />
            <h2 className="text-base font-semibold text-text-primary">
              8 Gmail drafts ready to send
            </h2>
          </div>
          <div className="grid gap-2 md:grid-cols-2">
            {STAGED_DRAFTS.map(item => (
              <PipelineCard key={item.company} item={item} />
            ))}
          </div>
        </div>

        <div className="rounded-lg border border-border bg-surface-elevated p-4">
          <div className="mb-3 flex items-center gap-2">
            <Users className="h-4 w-4 text-text-secondary" />
            <h2 className="text-base font-semibold text-text-primary">Hot follow-up board</h2>
          </div>
          <div className="grid gap-2 md:grid-cols-2">
            {HOT_FOLLOW_UPS.map(item => (
              <PipelineCard key={item.company} item={item} />
            ))}
          </div>
        </div>
      </section>

      <section className="grid gap-3 lg:grid-cols-3">
        <div className="rounded-lg border border-amber-700/30 bg-amber-100 p-4">
          <div className="mb-2 flex items-center gap-2">
            <Phone className="h-4 w-4 text-amber-800" />
            <h3 className="text-sm font-semibold text-amber-950">Call path</h3>
          </div>
          <p className="text-xs text-amber-900">
            Holcomb-Kreithen and Dolphin Aviation are high-fit but need phone/contact-form routing
            before email.
          </p>
        </div>
        <div className="rounded-lg border border-emerald-700/30 bg-emerald-100 p-4">
          <div className="mb-2 flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-emerald-800" />
            <h3 className="text-sm font-semibold text-emerald-950">Assets verified</h3>
          </div>
          <p className="text-xs text-emerald-900">
            Sampled staged drafts include the sponsor reel and Susan PDF.
          </p>
        </div>
        <div className="rounded-lg border border-rose-700/30 bg-rose-100 p-4">
          <div className="mb-2 flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 text-rose-800" />
            <h3 className="text-sm font-semibold text-rose-950">Suppression reminder</h3>
          </div>
          <p className="text-xs text-rose-900">
            ARC owns independent service shops. SADN owns luxury sponsors and dealership marketing
            lanes.
          </p>
        </div>
      </section>

      {!publicView && (
        <section className="grid gap-3 lg:grid-cols-2">
          <div className="rounded-lg border border-border bg-surface-elevated p-4">
            <div className="mb-3 flex items-center gap-2">
              <Video className="h-4 w-4 text-text-secondary" />
              <h2 className="text-base font-semibold text-text-primary">Working assets</h2>
            </div>
            <div className="space-y-2">
              {ASSETS.map(asset => (
                <div
                  key={asset.file}
                  className="rounded-md border border-border bg-surface-inset p-3"
                >
                  <p className="text-sm font-semibold text-text-primary">{asset.label}</p>
                  <p className="mt-1 text-xs text-text-secondary">{asset.use}</p>
                  <code className="mt-1 block break-all text-[11px] font-mono text-text-tertiary">
                    {asset.file}
                  </code>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-lg border border-border bg-surface-elevated p-4">
            <div className="mb-3 flex items-center gap-2">
              <FileText className="h-4 w-4 text-text-secondary" />
              <h2 className="text-base font-semibold text-text-primary">Canon and trackers</h2>
            </div>
            <div className="space-y-2">
              {VAULT_LINKS.map(link => (
                <div
                  key={link.path}
                  className="rounded-md border border-border bg-surface-inset p-3"
                >
                  <p className="text-sm font-semibold text-text-primary">{link.label}</p>
                  <code className="mt-1 block break-all text-[11px] font-mono text-text-tertiary">
                    {link.path}
                  </code>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      <section className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-emerald-800" />
          <h2 className="text-base font-semibold text-text-primary">
            First-wave sent roster from real email log
          </h2>
        </div>
        <p className="text-xs text-text-secondary">
          Cleaned active roster from the 2026-06-10 send log. Removed Medge Jaspan, Coral & Reef,
          Sarasota Personal Medicine, and Valley Bank per Jason. Use this as the live follow-up
          universe.
        </p>
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {(
            (prospectsData.by_business as Record<string, BusinessProspect[]> | undefined)?.SADN ??
            []
          ).map((p, idx) => (
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
              {p.email && <p className="mt-1 text-[11px] text-text-tertiary">{p.email}</p>}
              {p.engagement && (
                <p className="mt-2 text-[11px] text-text-secondary">
                  <span className="text-text-tertiary">Status:</span> {p.engagement}
                </p>
              )}
              {p.ask && (
                <p className="mt-2 text-[11px] text-text-secondary">
                  <span className="text-text-tertiary">Ask:</span> {p.ask}
                </p>
              )}
              {p.sponsor_value_lane && (
                <p className="mt-1 text-[11px] text-text-secondary">
                  <span className="text-text-tertiary">Value lane:</span> {p.sponsor_value_lane}
                </p>
              )}
              {p.next_touch && (
                <p className="mt-1 text-[11px] text-text-secondary">
                  <span className="text-text-tertiary">Next touch:</span> {p.next_touch}
                </p>
              )}
              {p.notes && <p className="mt-1 text-[11px] italic text-text-secondary">{p.notes}</p>}
            </article>
          ))}
        </div>
      </section>

      <div className="rounded-lg border border-border bg-surface-elevated p-4 text-xs text-text-secondary">
        Sender: <code className="rounded bg-surface-inset px-1">jason@sarasotaartanddance.com</code>{' '}
        with <code className="rounded bg-surface-inset px-1">contact@sarasotaartanddance.com</code>{' '}
        CC. Every sponsor send should include the locked reel and sponsor PDF.
      </div>
    </div>
  );
}
