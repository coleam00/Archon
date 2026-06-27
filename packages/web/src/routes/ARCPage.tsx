import {
  AlertCircle,
  ExternalLink,
  CheckCircle2,
  Circle,
  Clock,
  ShieldAlert,
  Target,
  FileText,
  Mail,
} from 'lucide-react';

/**
 * ARC Brand Agency -- external-rep engagement.
 *
 * Source of truth:
 *   second-brain/businesses/external-reps/arc-brand-agency/_arc-brand-agency.md
 *   second-brain/businesses/external-reps/arc-brand-agency/intake-2026-06-02.md
 *   second-brain/businesses/external-reps/arc-brand-agency/operations/operational-playbook.md
 *
 * Trial window: 2026-06-02 → 2026-07-31
 * Principal: Adam Riley
 * Lane: European luxury auto service centers (Porsche/Audi/Lamborghini/Ferrari), FL + coastal
 */

interface StatusItem {
  label: string;
  state: 'done' | 'pending' | 'blocked';
  notes?: string;
}

const TRIAL_STATUS: StatusItem[] = [
  { label: 'Verbal agreement closed', state: 'done', notes: '2026-06-02' },
  {
    label: 'Lane assigned',
    state: 'done',
    notes: 'Florida exotic / European auto service centers + luxury dealership service',
  },
  { label: 'Payee confirmed', state: 'done', notes: 'Elevated Wellness LLC' },
  {
    label: 'Rate',
    state: 'done',
    notes: 'Work log template received; current model tracks $30/hr hourly base',
  },
  {
    label: 'Prospect seed list',
    state: 'done',
    notes: '23 Florida shops received; needs enrichment',
  },
  {
    label: 'Email templates',
    state: 'done',
    notes: '3 rough ARC templates received; rewrite recommended',
  },
  {
    label: 'Work log',
    state: 'done',
    notes: 'Excel tracker received for hours, stages, outcomes, commission',
  },
  {
    label: 'Launch brief',
    state: 'done',
    notes: '2026-06-26 ARC campaign launch brief written in vault',
  },
  {
    label: 'Campaign proof assets',
    state: 'pending',
    notes: 'Adam to provide past campaigns / promotions',
  },
  {
    label: 'Calendly / booking link',
    state: 'pending',
    notes: 'Adam to set up or approve Jason scheduling path',
  },
  { label: 'Sales mailbox provisioned', state: 'pending', notes: 'Awaiting credentials from Adam' },
  {
    label: 'Domain hygiene confirmed',
    state: 'blocked',
    notes: 'Confirm sending mailbox + SPF / DKIM / DMARC before first send',
  },
  {
    label: 'First outbound',
    state: 'blocked',
    notes: 'Blocked on mailbox + proof assets + enriched contacts',
  },
];

const JASON_DELIVERABLES = [
  {
    id: 'enrich-list',
    text: 'Enrich the 23-account seed list with owner / GM / service-manager contacts',
    due: 'Mon',
  },
  {
    id: 'add-lookalikes',
    text: 'Add 27 lookalike Florida accounts for a 50-account pilot',
    due: 'Mon',
  },
  {
    id: 'rewrite-copy',
    text: 'Rewrite ARC templates into a Luxury Service Demand Audit sequence',
    due: 'Mon',
  },
  { id: 'send-test', text: 'Send 5 internal test emails before live launch', due: 'Tue' },
  {
    id: 'launch-wave',
    text: 'Launch first 15-20 live emails once mailbox + proof assets are ready',
    due: 'Tue',
  },
];

const OPEN_QUESTIONS = [
  'Exact sending mailbox and login credentials?',
  'SPF / DKIM / DMARC confirmed for the sending domain?',
  'Calendly link from Adam, or should Jason book manually?',
  'Two or three past campaign assets Jason can cite on calls?',
  'Is Adam comfortable with a proof-light first wave if assets are not ready Monday?',
  'Should first wave include dealerships or only independent service centers?',
];

function StatusIcon({ state }: { state: StatusItem['state'] }): React.ReactElement {
  if (state === 'done') return <CheckCircle2 className="h-4 w-4 flex-shrink-0 text-emerald-700" />;
  if (state === 'blocked') return <ShieldAlert className="h-4 w-4 flex-shrink-0 text-rose-700" />;
  return <Clock className="h-4 w-4 flex-shrink-0 text-amber-700" />;
}

export function ARCPage(): React.ReactElement {
  return (
    <div className="flex flex-1 flex-col gap-6 p-6">
      {/* Header */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <h1 className="text-2xl font-semibold text-text-primary">ARC Brand Agency</h1>
          <span className="rounded border border-amber-700/40 bg-amber-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-800">
            external rep
          </span>
          <span className="rounded border border-emerald-700/40 bg-emerald-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-800">
            active trial
          </span>
        </div>
        <p className="text-sm text-text-secondary">
          Jason as 1099 outside sales for Adam Riley's Google Ads / PPC shop (ARC Media Production
          LLC dba ARC Brand Agency). Trial window:{' '}
          <span className="font-mono">2026-06-02 → 2026-07-31</span>. Off-thesis revenue line, NOT a
          PMC sub-brand.
        </p>
      </div>

      {/* Engagement card */}
      <section className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-md border border-border bg-surface-elevated p-4">
          <h3 className="mb-2 text-sm font-semibold text-text-primary">Principal</h3>
          <dl className="grid grid-cols-[120px_1fr] gap-y-1 text-xs text-text-secondary">
            <dt className="text-text-tertiary">Name:</dt>
            <dd>Adam Riley</dd>
            <dt className="text-text-tertiary">Entity:</dt>
            <dd>ARC Media Production LLC (dba ARC Brand Agency)</dd>
            <dt className="text-text-tertiary">Site:</dt>
            <dd>
              <a
                href="https://arcbrandagency.com"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline"
              >
                arcbrandagency.com <ExternalLink className="inline h-3 w-3" />
              </a>
            </dd>
            <dt className="text-text-tertiary">Stage:</dt>
            <dd>Launch-ready after mailbox, proof assets, and contact enrichment</dd>
            <dt className="text-text-tertiary">Public proof:</dt>
            <dd>G2 Motorsports Park, Glickenhaus, Modded America, Luxia Network</dd>
          </dl>
        </div>

        <div className="rounded-md border border-border bg-surface-elevated p-4">
          <h3 className="mb-2 text-sm font-semibold text-text-primary">Jason's lane</h3>
          <dl className="grid grid-cols-[120px_1fr] gap-y-1 text-xs text-text-secondary">
            <dt className="text-text-tertiary">Vertical:</dt>
            <dd>Exotic / European service demand capture</dd>
            <dt className="text-text-tertiary">Brands:</dt>
            <dd>Porsche · BMW · Mercedes · Audi · Ferrari · Lamborghini · McLaren</dd>
            <dt className="text-text-tertiary">Geo:</dt>
            <dd>
              Florida first: South FL, Tampa Bay/Sarasota, Orlando, Naples/Fort Myers, Jacksonville
            </dd>
            <dt className="text-text-tertiary">Offer:</dt>
            <dd>15-minute Luxury Service Demand Audit</dd>
            <dt className="text-text-tertiary">Product:</dt>
            <dd>
              Google Search / PPC around service promotions, launches, and booked appointments
            </dd>
            <dt className="text-text-tertiary">First wave:</dt>
            <dd>50 curated accounts; one primary decision-maker per account</dd>
          </dl>
        </div>
      </section>

      {/* Domain warning banner */}
      <div className="flex items-start gap-3 rounded-md border border-amber-700/40 bg-amber-100 p-4">
        <AlertCircle className="mt-0.5 h-5 w-5 flex-shrink-0 text-amber-700" />
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium text-amber-900">
            Launch blocker: mailbox + proof assets before live outbound
          </p>
          <p className="text-xs text-amber-800">
            The public site supports ARC's automotive / luxury / motorsport positioning, but the
            campaign should not go live until Adam provides the sending mailbox, confirms SPF / DKIM
            / DMARC, shares a scheduling link, and sends 1-2 campaign examples Jason can cite on
            calls.
          </p>
        </div>
      </div>

      {/* Trial status */}
      <section className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <Target className="h-4 w-4 text-text-secondary" />
          <h2 className="text-base font-semibold text-text-primary">Trial Status</h2>
        </div>
        <div className="rounded-md border border-border bg-surface-elevated p-4">
          <ul className="flex flex-col gap-2">
            {TRIAL_STATUS.map(item => (
              <li key={item.label} className="flex items-start gap-2 text-xs">
                <StatusIcon state={item.state} />
                <div className="flex flex-col">
                  <span className="text-text-primary">{item.label}</span>
                  {item.notes && <span className="text-text-tertiary">{item.notes}</span>}
                </div>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* Jason's deliverables */}
      <section className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <CheckCircle2 className="h-4 w-4 text-text-secondary" />
          <h2 className="text-base font-semibold text-text-primary">
            Jason's deliverables (this week)
          </h2>
        </div>
        <div className="rounded-md border border-border bg-surface-elevated p-4">
          <ul className="flex flex-col gap-2">
            {JASON_DELIVERABLES.map(d => (
              <li key={d.id} className="flex items-start gap-2 text-xs">
                <Circle className="h-4 w-4 flex-shrink-0 text-text-tertiary" />
                <span className="text-text-primary flex-1">{d.text}</span>
                <span className="font-mono text-[11px] text-text-tertiary whitespace-nowrap">
                  due {d.due}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* Open questions */}
      <section className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <Mail className="h-4 w-4 text-text-secondary" />
          <h2 className="text-base font-semibold text-text-primary">Open questions for Adam</h2>
        </div>
        <div className="rounded-md border border-border bg-surface-elevated p-4">
          <ul className="flex flex-col gap-1.5">
            {OPEN_QUESTIONS.map((q, i) => (
              <li key={i} className="text-xs text-text-secondary flex gap-2">
                <span className="text-text-tertiary font-mono">{i + 1}.</span>
                <span>{q}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* Trial checkpoint */}
      <section className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <Clock className="h-4 w-4 text-text-secondary" />
          <h2 className="text-base font-semibold text-text-primary">
            Trial checkpoint -- 2026-07-31
          </h2>
        </div>
        <div className="grid gap-2 sm:grid-cols-3">
          <div className="rounded-md border border-border bg-surface-elevated p-3">
            <p className="text-sm font-semibold text-emerald-800">Renegotiate</p>
            <p className="mt-1 text-xs text-text-tertiary">
              Base + per-meeting bonus or % of first-month closed (if Jason booked &gt; X meetings
              that closed).
            </p>
          </div>
          <div className="rounded-md border border-border bg-surface-elevated p-3">
            <p className="text-sm font-semibold text-amber-800">Extend on current terms</p>
            <p className="mt-1 text-xs text-text-tertiary">
              Pipeline is warming but no closes yet.
            </p>
          </div>
          <div className="rounded-md border border-border bg-surface-elevated p-3">
            <p className="text-sm font-semibold text-text-secondary">Sunset cleanly</p>
            <p className="mt-1 text-xs text-text-tertiary">
              Not converting and hours are pulling from PMC pipeline.
            </p>
          </div>
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
              label: 'Engagement MOC + status board',
              path: 'businesses/external-reps/arc-brand-agency/_arc-brand-agency.md',
            },
            {
              label: 'Campaign launch brief (2026-06-26)',
              path: 'intelligence/briefs/2026-06-26-arc-campaign-launch-brief.md',
            },
            {
              label: 'Operational playbook (launch rules, metrics, sending hygiene)',
              path: 'businesses/external-reps/arc-brand-agency/operations/operational-playbook.md',
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
