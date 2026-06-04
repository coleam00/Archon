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
    notes: 'European luxury auto service centers, FL + coastal',
  },
  { label: 'Payee confirmed', state: 'done', notes: 'Elevated Wellness LLC' },
  {
    label: 'Rate',
    state: 'pending',
    notes: '$30-35/hr range, exact rate pending Adam confirmation',
  },
  { label: '1099 paperwork', state: 'pending', notes: 'Adam to collect Jason info this week' },
  { label: 'Prospect list from Adam', state: 'pending', notes: 'ETA 2026-06-04 (24-48h commit)' },
  { label: 'Content / templates from Adam', state: 'pending', notes: 'ETA 2026-06-04' },
  { label: 'Current-client examples', state: 'pending', notes: 'ETA 2026-06-04' },
  { label: 'Google Sheets CRM dashboard', state: 'pending', notes: 'Adam setting up' },
  { label: 'Apollo enrichment account', state: 'pending', notes: 'Adam to acquire cheap tier' },
  { label: 'Sales mailbox provisioned', state: 'pending', notes: 'Awaiting credentials from Adam' },
  {
    label: 'Domain spelling confirmed (arc vs ark)',
    state: 'blocked',
    notes: 'Doc has both spellings; only arc resolves on web',
  },
  { label: 'First outbound', state: 'blocked', notes: 'Blocked on all of the above' },
];

const JASON_DELIVERABLES = [
  { id: 'review-list', text: 'Review prospect list + templates once received', due: '2026-06-06' },
  { id: 'feedback', text: 'Feedback / plan of action by EOD Fri', due: '2026-06-06' },
  { id: 'info-1099', text: 'Send Adam personal info for 1099 setup', due: 'this week' },
  { id: 'dd-info', text: 'Send EWC LLC direct deposit info', due: 'this week' },
  { id: 'rate-confirm', text: 'Confirm rate ($30 or $35/hr)', due: 'next call' },
];

const OPEN_QUESTIONS = [
  'sales@arcbrandagency.com OR sales@arkbrandagency.com? (only arc resolves on web)',
  'Preferred outbound channel mix: email-first, LinkedIn-first, or parallel?',
  'Calling cadence: cold calls expected, or email + LinkedIn only?',
  'Pitch deck / one-pager: Adam offered to build, worth doing before any outreach?',
  'Sending domain hygiene: SPF / DKIM / DMARC in place, mailbox warmed?',
  'CRM permissions: Jason as editor on Google Sheet, or principal-only edits?',
  'Apollo seat: shared login with Jenna, or separate logins on same account?',
  'Pay cadence: weekly, bi-weekly, monthly invoice?',
  "Adam's direct email / phone / LinkedIn (only shared the universal mailbox)",
  "Adam's HQ location / time zone (Jenna is Tampa; Adam unstated)",
];

function StatusIcon({ state }: { state: StatusItem['state'] }): React.ReactElement {
  if (state === 'done') return <CheckCircle2 className="h-4 w-4 flex-shrink-0 text-green-400" />;
  if (state === 'blocked') return <ShieldAlert className="h-4 w-4 flex-shrink-0 text-red-400" />;
  return <Clock className="h-4 w-4 flex-shrink-0 text-amber-400" />;
}

export function ARCPage(): React.ReactElement {
  return (
    <div className="flex flex-1 flex-col gap-6 p-6">
      {/* Header */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <h1 className="text-2xl font-semibold text-text-primary">ARC Brand Agency</h1>
          <span className="rounded bg-amber-950/40 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-300">
            external rep
          </span>
          <span className="rounded bg-green-950/40 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-green-300">
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
            <dd>Solo operator scaling; still working a day-job he wants to leave</dd>
            <dt className="text-text-tertiary">Parallel rep:</dt>
            <dd>Jenna (Tampa) -- aftermarket performance lane</dd>
          </dl>
        </div>

        <div className="rounded-md border border-border bg-surface-elevated p-4">
          <h3 className="mb-2 text-sm font-semibold text-text-primary">Jason's lane</h3>
          <dl className="grid grid-cols-[120px_1fr] gap-y-1 text-xs text-text-secondary">
            <dt className="text-text-tertiary">Vertical:</dt>
            <dd>European luxury auto service centers</dd>
            <dt className="text-text-tertiary">Brands:</dt>
            <dd>Porsche · Audi · Lamborghini · Ferrari</dd>
            <dt className="text-text-tertiary">Geo:</dt>
            <dd>Florida + coastal states (independent shops); also open to luxury dealerships</dd>
            <dt className="text-text-tertiary">Product:</dt>
            <dd>Google Search / PPC (Adam's core); Meta available but scaling down; no SEO</dd>
            <dt className="text-text-tertiary">Time cap:</dt>
            <dd>~6 hr/wk soft, 8 hr/wk hard</dd>
            <dt className="text-text-tertiary">Rate:</dt>
            <dd>$30-35/hr, paid to Elevated Wellness LLC</dd>
          </dl>
        </div>
      </section>

      {/* Domain warning banner */}
      <div className="flex items-start gap-3 rounded-md border border-red-700/40 bg-red-950/20 p-4">
        <AlertCircle className="mt-0.5 h-5 w-5 flex-shrink-0 text-red-400" />
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium text-red-200">
            Domain spelling needs confirmation before any outbound
          </p>
          <p className="text-xs text-red-300/80">
            The intake doc has both{' '}
            <code className="rounded bg-surface-inset px-1 py-0.5">sales@arcbrandagency.com</code>{' '}
            (in the exec summary; matches the public site) and{' '}
            <code className="rounded bg-surface-inset px-1 py-0.5">sales@arkbrandagency.com</code>{' '}
            (Adam said verbally twice). Only{' '}
            <code className="rounded bg-surface-inset px-1 py-0.5">arc</code> resolves on the web.
            Ask Adam to confirm before provisioning Jason's access.
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
            <p className="text-sm font-semibold text-green-400">Renegotiate</p>
            <p className="mt-1 text-xs text-text-tertiary">
              Base + per-meeting bonus or % of first-month closed (if Jason booked &gt; X meetings
              that closed).
            </p>
          </div>
          <div className="rounded-md border border-border bg-surface-elevated p-3">
            <p className="text-sm font-semibold text-amber-400">Extend on current terms</p>
            <p className="mt-1 text-xs text-text-tertiary">
              Pipeline is warming but no closes yet.
            </p>
          </div>
          <div className="rounded-md border border-border bg-surface-elevated p-3">
            <p className="text-sm font-semibold text-text-tertiary">Sunset cleanly</p>
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
              label: 'Full intake brief (2026-06-02 onboarding call)',
              path: 'businesses/external-reps/arc-brand-agency/intake-2026-06-02.md',
            },
            {
              label: 'Operational playbook (data separation, sending hygiene, suppression)',
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
