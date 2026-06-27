import {
  AlertCircle,
  CheckCircle2,
  Circle,
  Clock,
  ExternalLink,
  FileText,
  Mail,
  Phone,
  ShieldAlert,
  Target,
  TrendingUp,
  Users,
} from 'lucide-react';

interface StatusItem {
  label: string;
  state: 'done' | 'pending' | 'blocked';
  notes?: string;
}

interface MetricCardProps {
  label: string;
  value: string;
  note: string;
  tone?: 'green' | 'amber' | 'rose' | 'blue';
}

interface WorkstreamItem {
  title: string;
  status: string;
  owner: string;
  next: string;
}

interface ProspectLane {
  lane: string;
  count: string;
  status: string;
  next: string;
}

const METRICS: MetricCardProps[] = [
  {
    label: 'Pilot universe',
    value: '23 + 6',
    note: '23 seed accounts enriched, 6 cleaner replacements researched',
    tone: 'blue',
  },
  {
    label: 'Clean list',
    value: 'v2',
    note: 'Ambiguous rows replaced with stronger FL exotic/Euro shops',
    tone: 'green',
  },
  {
    label: 'Launch blocker',
    value: 'mailbox',
    note: 'Live sends wait on Adam mailbox + domain auth',
    tone: 'amber',
  },
  {
    label: 'Goal',
    value: 'first meetings',
    note: 'Booked calls for Luxury Service Demand Audit',
    tone: 'green',
  },
];

const TRIAL_STATUS: StatusItem[] = [
  { label: 'Verbal agreement closed', state: 'done', notes: '2026-06-02' },
  {
    label: 'Lane assigned',
    state: 'done',
    notes: 'Florida exotic / European auto service centers',
  },
  { label: 'Payee confirmed', state: 'done', notes: 'Elevated Wellness LLC' },
  { label: 'Launch brief written', state: 'done', notes: '2026-06-26 campaign launch brief' },
  {
    label: 'Decision-maker enrichment',
    state: 'done',
    notes: 'Owner / GM / service-manager path added where public',
  },
  { label: 'Weak rows cleaned', state: 'done', notes: 'Clean v2 list plus reserve replacements' },
  {
    label: 'Proof assets',
    state: 'pending',
    notes: 'Adam to provide 1-2 campaign examples Jason can cite',
  },
  { label: 'Calendly / booking path', state: 'pending', notes: 'Adam approval needed' },
  {
    label: 'Sales mailbox',
    state: 'blocked',
    notes: 'Awaiting credentials and SPF / DKIM / DMARC check',
  },
  {
    label: 'First outbound wave',
    state: 'blocked',
    notes: 'Blocked until mailbox + proof + booking path are confirmed',
  },
];

const WORKSTREAMS: WorkstreamItem[] = [
  {
    title: 'Contact enrichment',
    status: 'Complete',
    owner: 'Carlos',
    next: 'Use clean v2 list as only launch source',
  },
  {
    title: 'Replacement prospects',
    status: 'Complete',
    owner: 'Carlos',
    next: 'Keep two reserve rows if Adam rejects any account',
  },
  {
    title: 'Mailbox + auth',
    status: 'Blocked',
    owner: 'Adam',
    next: 'Confirm sales mailbox, credentials, SPF, DKIM, DMARC',
  },
  {
    title: 'Proof and booking',
    status: 'Pending',
    owner: 'Adam / Jason',
    next: 'Lock assets and meeting handoff before sending',
  },
  {
    title: 'First live wave',
    status: 'Ready after blockers',
    owner: 'Jason',
    next: 'Send 10-15 best accounts, then call day 2',
  },
];

const PROSPECT_LANES: ProspectLane[] = [
  { lane: 'Independent Euro service', count: 'Core', status: 'Best fit', next: 'Owner / GM first' },
  {
    lane: 'Exotic performance shops',
    count: 'Core',
    status: 'High value',
    next: 'Lead with demand capture',
  },
  {
    lane: 'Dealership service',
    count: 'Selective',
    status: 'Use carefully',
    next: 'Avoid SADN luxury sponsor overlap',
  },
  {
    lane: 'Reserve replacements',
    count: '2',
    status: 'Held',
    next: 'Swap if a row is weak or conflicted',
  },
];

const OPEN_QUESTIONS = [
  'Exact sending mailbox and login credentials?',
  'SPF / DKIM / DMARC confirmed for the sending domain?',
  'Adam Calendly link, or should Jason book manually?',
  'Two or three past campaign assets Jason can cite on calls?',
  'Can the first wave launch proof-light if assets lag?',
];

const VAULT_LINKS = [
  {
    label: 'Engagement MOC',
    path: 'businesses/external-reps/arc-brand-agency/_arc-brand-agency.md',
  },
  {
    label: 'Campaign launch brief',
    path: 'intelligence/briefs/2026-06-26-arc-campaign-launch-brief.md',
  },
  {
    label: 'Clean v2 prospect list',
    path: 'businesses/external-reps/arc-brand-agency/prospects/arc-fl-exotic-euro-contact-enrichment-v2-clean-2026-06-26.csv',
  },
  {
    label: 'Replacement prospects',
    path: 'businesses/external-reps/arc-brand-agency/prospects/arc-replacement-prospects-florida-2026-06-26.csv',
  },
  {
    label: 'Decision-maker enrichment brief',
    path: 'intelligence/briefs/2026-06-26-arc-sadn-decision-maker-contact-enrichment.md',
  },
];

function toneClasses(tone: MetricCardProps['tone']): string {
  if (tone === 'green') return 'border-emerald-700/30 bg-emerald-100 text-emerald-900';
  if (tone === 'amber') return 'border-amber-700/30 bg-amber-100 text-amber-900';
  if (tone === 'rose') return 'border-rose-700/30 bg-rose-100 text-rose-900';
  return 'border-blue-700/30 bg-blue-100 text-blue-900';
}

function StatusIcon({ state }: { state: StatusItem['state'] }): React.ReactElement {
  if (state === 'done') return <CheckCircle2 className="h-4 w-4 flex-shrink-0 text-emerald-700" />;
  if (state === 'blocked') return <ShieldAlert className="h-4 w-4 flex-shrink-0 text-rose-700" />;
  return <Clock className="h-4 w-4 flex-shrink-0 text-amber-700" />;
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

export function ARCPage(): React.ReactElement {
  return (
    <div className="flex flex-1 flex-col gap-6 p-6">
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold text-text-primary">ARC Brand Agency</h1>
          <span className="rounded border border-amber-700/40 bg-amber-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-800">
            external rep
          </span>
          <span className="rounded border border-emerald-700/40 bg-emerald-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-800">
            active trial
          </span>
          <span className="rounded border border-rose-700/40 bg-rose-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-rose-800">
            launch blocked
          </span>
        </div>
        <p className="max-w-4xl text-sm text-text-secondary">
          Operator view for Jason's ARC outbound: keep the clean account list, blockers, next
          actions, and first-meeting pipeline in one place. This is a 1099 external-rep engagement
          for Adam Riley, separate from PMC and SADN.
        </p>
      </div>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {METRICS.map(metric => (
          <MetricCard key={metric.label} {...metric} />
        ))}
      </section>

      <section className="grid gap-3 lg:grid-cols-[1.1fr_0.9fr]">
        <div className="rounded-lg border border-border bg-surface-elevated p-4">
          <div className="mb-3 flex items-center gap-2">
            <Target className="h-4 w-4 text-text-secondary" />
            <h2 className="text-base font-semibold text-text-primary">Launch command center</h2>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <div className="rounded-md border border-border bg-surface-inset p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-text-tertiary">
                Who we sell
              </p>
              <p className="mt-1 text-sm text-text-primary">
                Independent exotic / European service centers in Florida.
              </p>
              <p className="mt-2 text-xs text-text-secondary">
                Decision-maker priority: owner, founder, GM, service manager, then marketing.
              </p>
            </div>
            <div className="rounded-md border border-border bg-surface-inset p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-text-tertiary">
                What we book
              </p>
              <p className="mt-1 text-sm text-text-primary">
                15-minute Luxury Service Demand Audit.
              </p>
              <p className="mt-2 text-xs text-text-secondary">
                CTA should create a meeting, not explain PPC in the inbox.
              </p>
            </div>
            <div className="rounded-md border border-border bg-surface-inset p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-text-tertiary">
                Do not cross
              </p>
              <p className="mt-1 text-sm text-text-primary">
                Avoid SADN luxury-auto sponsor contacts.
              </p>
              <p className="mt-2 text-xs text-text-secondary">
                ARC owns service shops. SADN owns sponsor / dealership marketing lanes.
              </p>
            </div>
            <div className="rounded-md border border-border bg-surface-inset p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-text-tertiary">
                Next trigger
              </p>
              <p className="mt-1 text-sm text-text-primary">Mailbox + proof + booking path.</p>
              <p className="mt-2 text-xs text-text-secondary">
                Once locked, stage 3 sample drafts before the first wave.
              </p>
            </div>
          </div>
        </div>

        <div className="rounded-lg border border-amber-700/30 bg-amber-100 p-4">
          <div className="mb-2 flex items-center gap-2">
            <AlertCircle className="h-4 w-4 text-amber-800" />
            <h2 className="text-base font-semibold text-amber-950">Blockers to clear</h2>
          </div>
          <ul className="space-y-2 text-xs text-amber-900">
            {OPEN_QUESTIONS.map((q, i) => (
              <li key={q} className="flex gap-2">
                <span className="font-mono opacity-70">{i + 1}.</span>
                <span>{q}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="grid gap-3 lg:grid-cols-2">
        <div className="rounded-lg border border-border bg-surface-elevated p-4">
          <div className="mb-3 flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-text-secondary" />
            <h2 className="text-base font-semibold text-text-primary">Workstreams</h2>
          </div>
          <div className="space-y-2">
            {WORKSTREAMS.map(item => (
              <div
                key={item.title}
                className="rounded-md border border-border bg-surface-inset p-3"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-text-primary">{item.title}</p>
                    <p className="mt-1 text-xs text-text-secondary">{item.next}</p>
                  </div>
                  <span className="rounded-full bg-surface-elevated px-2 py-0.5 text-[10px] font-medium text-text-secondary">
                    {item.status}
                  </span>
                </div>
                <p className="mt-2 text-[11px] text-text-tertiary">Owner: {item.owner}</p>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-lg border border-border bg-surface-elevated p-4">
          <div className="mb-3 flex items-center gap-2">
            <Users className="h-4 w-4 text-text-secondary" />
            <h2 className="text-base font-semibold text-text-primary">Prospect lanes</h2>
          </div>
          <div className="space-y-2">
            {PROSPECT_LANES.map(lane => (
              <div
                key={lane.lane}
                className="grid grid-cols-[1fr_auto] gap-2 rounded-md border border-border bg-surface-inset p-3"
              >
                <div>
                  <p className="text-sm font-semibold text-text-primary">{lane.lane}</p>
                  <p className="mt-1 text-xs text-text-secondary">{lane.next}</p>
                </div>
                <div className="text-right">
                  <p className="text-xs font-semibold text-text-primary">{lane.count}</p>
                  <p className="text-[11px] text-text-tertiary">{lane.status}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <CheckCircle2 className="h-4 w-4 text-text-secondary" />
          <h2 className="text-base font-semibold text-text-primary">Readiness checklist</h2>
        </div>
        <div className="grid gap-2 md:grid-cols-2">
          {TRIAL_STATUS.map(item => (
            <div
              key={item.label}
              className="flex items-start gap-2 rounded-md border border-border bg-surface-elevated p-3 text-xs"
            >
              <StatusIcon state={item.state} />
              <div>
                <p className="font-medium text-text-primary">{item.label}</p>
                {item.notes && <p className="mt-1 text-text-tertiary">{item.notes}</p>}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="grid gap-3 lg:grid-cols-3">
        <div className="rounded-lg border border-border bg-surface-elevated p-4">
          <div className="mb-2 flex items-center gap-2">
            <Mail className="h-4 w-4 text-text-secondary" />
            <h3 className="text-sm font-semibold text-text-primary">Day 0</h3>
          </div>
          <p className="text-xs text-text-secondary">
            Send 10-15 carefully selected accounts after mailbox auth. Use clean v2 list only.
          </p>
        </div>
        <div className="rounded-lg border border-border bg-surface-elevated p-4">
          <div className="mb-2 flex items-center gap-2">
            <Phone className="h-4 w-4 text-text-secondary" />
            <h3 className="text-sm font-semibold text-text-primary">Day 2</h3>
          </div>
          <p className="text-xs text-text-secondary">
            Call owner / GM path. Goal is audit booking, not technical PPC education.
          </p>
        </div>
        <div className="rounded-lg border border-border bg-surface-elevated p-4">
          <div className="mb-2 flex items-center gap-2">
            <Circle className="h-4 w-4 text-text-secondary" />
            <h3 className="text-sm font-semibold text-text-primary">Day 7</h3>
          </div>
          <p className="text-xs text-text-secondary">
            Second touch to non-responders, then update outcome and next action per account.
          </p>
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <FileText className="h-4 w-4 text-text-secondary" />
          <h2 className="text-base font-semibold text-text-primary">Canon and working files</h2>
        </div>
        <div className="grid gap-2 md:grid-cols-2">
          {VAULT_LINKS.map(link => (
            <div
              key={link.path}
              className="rounded-md border border-border bg-surface-elevated p-3"
            >
              <p className="text-sm font-semibold text-text-primary">{link.label}</p>
              <code className="mt-1 block text-[11px] font-mono text-text-tertiary">
                {link.path}
              </code>
            </div>
          ))}
        </div>
      </section>

      <div className="rounded-lg border border-border bg-surface-elevated p-4 text-xs text-text-secondary">
        ARC site:{' '}
        <a
          href="https://arcbrandagency.com"
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary hover:underline"
        >
          arcbrandagency.com <ExternalLink className="inline h-3 w-3" />
        </a>
      </div>
    </div>
  );
}
