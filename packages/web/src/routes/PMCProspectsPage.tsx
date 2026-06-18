import { useMemo, useState } from 'react';
import { Database, Search, Target, Users } from 'lucide-react';
import prospectContactsData from '@/lib/pmc-prospect-contacts.generated.json';

interface PmcProspectContact {
  id: string;
  name: string;
  company?: string;
  title?: string;
  specialty?: string;
  email?: string;
  phone?: string;
  linkedin_url?: string;
  website?: string;
  city?: string;
  state?: string;
  source?: string;
  priority?: string;
  apollo_sequence_name?: string;
  apollo_last_open?: string;
  apollo_last_reply?: string;
  apollo_replies?: number;
  apollo_opens?: number;
  salesnav_present?: boolean;
  salesnav_thread_summary?: string;
  heyreach_present?: boolean;
  dial_last_attempt?: string;
  dial_last_outcome?: string;
  dial_attempt_count?: number;
  notes?: string;
  dial_notes?: string;
  brand_fit?: string[];
  approach_angle?: string;
  engagement_subjects?: string[];
  channels_covered?: string[];
  channels_open?: string[];
  channels_covered_count: number;
  missing_fields?: string[];
  latest_engagement?: string;
  latest_outcome?: string;
  strategic_state?: string;
  next_action?: string;
  stop_by_this_week?: boolean;
}

interface PmcProspectContactsPayload {
  generated_at?: string;
  notes?: string[];
  totals?: Record<string, number>;
  brand_counts?: Record<string, number>;
  prospects?: PmcProspectContact[];
}

const PROSPECT_STATE_OPTIONS = ['all', 'hot', 'engaged', 'warmup-active', 'cold', 'dead'];

const STRATEGIC_STATE_TONE: Record<string, string> = {
  hot: 'border-emerald-700/40 bg-emerald-100 text-emerald-800',
  engaged: 'border-sky-700/40 bg-sky-100 text-sky-800',
  'warmup-active': 'border-amber-700/40 bg-amber-100 text-amber-800',
  cold: 'border-border bg-card text-text-tertiary',
  dead: 'border-red-700/40 bg-red-100 text-red-800',
};

const METRIC_CARDS: {
  label: string;
  key: string;
  icon: typeof Database;
}[] = [
  { label: 'Hot', key: 'hot', icon: Target },
  { label: 'Engaged', key: 'engaged', icon: Users },
  { label: 'Warmup active', key: 'warmup_active', icon: Database },
  { label: 'Apollo covered', key: 'apollo_covered', icon: Database },
  { label: 'LinkedIn covered', key: 'linkedin_covered', icon: Users },
  { label: 'Dial covered', key: 'dial_covered', icon: Target },
];

function formatProspectDate(value?: string): string {
  if (!value) return 'n/a';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 10);
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function channelTone(channel: string): string {
  if (channel === 'Apollo') return 'border-indigo-700/30 bg-indigo-50 text-indigo-800';
  if (channel === 'LinkedIn') return 'border-sky-700/30 bg-sky-50 text-sky-800';
  if (channel === 'Dial') return 'border-emerald-700/30 bg-emerald-50 text-emerald-800';
  return 'border-border bg-card text-text-tertiary';
}

function safeTextList(values?: string[]): string[] {
  return Array.isArray(values) ? values.filter(Boolean) : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isProspectContact(value: unknown): value is PmcProspectContact {
  return isRecord(value);
}

function safeMetricRecord(value: unknown): Record<string, number> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, number] => {
      const [, metric] = entry;
      return typeof metric === 'number' && Number.isFinite(metric);
    })
  );
}

export function PMCProspectsPage(): React.ReactElement {
  const prospectContactsPayload = prospectContactsData as Partial<PmcProspectContactsPayload> & {
    prospects?: unknown;
    totals?: unknown;
  };
  const prospectContacts = Array.isArray(prospectContactsPayload.prospects)
    ? prospectContactsPayload.prospects.filter(isProspectContact)
    : [];
  const prospectContactTotals = safeMetricRecord(prospectContactsPayload.totals);
  const prospectBrandOptions = useMemo(() => {
    const brandCounts = isRecord(prospectContactsPayload.brand_counts)
      ? Object.keys(prospectContactsPayload.brand_counts).filter(Boolean)
      : [];
    const brandFits = prospectContacts.flatMap(p => safeTextList(p.brand_fit));
    return [
      'all',
      ...Array.from(new Set([...brandCounts, ...brandFits])).sort((a, b) => a.localeCompare(b)),
    ];
  }, [prospectContacts, prospectContactsPayload.brand_counts]);
  const [prospectSearch, setProspectSearch] = useState('');
  const [prospectBrandFilter, setProspectBrandFilter] = useState('all');
  const [prospectStateFilter, setProspectStateFilter] = useState('all');
  const [selectedProspectId, setSelectedProspectId] = useState<string | null>(
    prospectContacts[0]?.id ?? null
  );

  const filteredProspectContacts = useMemo(() => {
    const query = prospectSearch.trim().toLowerCase();
    return prospectContacts.filter(p => {
      const brandFit = safeTextList(p.brand_fit);
      const channelsCovered = safeTextList(p.channels_covered);
      const brandOk = prospectBrandFilter === 'all' || brandFit.includes(prospectBrandFilter);
      const stateOk = prospectStateFilter === 'all' || p.strategic_state === prospectStateFilter;
      const queryOk =
        !query ||
        [
          p.name,
          p.company,
          p.email,
          p.phone,
          p.linkedin_url,
          p.city,
          p.state,
          p.apollo_sequence_name,
          p.approach_angle,
          p.notes,
          ...brandFit,
          ...channelsCovered,
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
          .includes(query);
      return brandOk && stateOk && queryOk;
    });
  }, [prospectBrandFilter, prospectContacts, prospectSearch, prospectStateFilter]);

  const visibleProspectContacts = filteredProspectContacts.slice(0, 250);
  const selectedProspect =
    filteredProspectContacts.find(p => p.id === selectedProspectId) ??
    filteredProspectContacts[0] ??
    null;

  return (
    <div className="flex flex-1 flex-col gap-6 p-6">
      <section className="rounded-2xl border border-border bg-card p-5 shadow-sm">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[var(--primary)]">
              PMC Prospects
            </p>
            <h1
              className="mt-1 text-3xl font-semibold text-text-primary"
              style={{ fontFamily: "'Playfair Display', serif" }}
            >
              Outreach command center
            </h1>
            <p className="mt-1 max-w-3xl text-sm text-text-secondary">
              Deduped prospect rows with identifiers, channel coverage, engagement subjects,
              approach angles, notes, and next steps across PMC, BRT, Weave, and Neural Cloud.
            </p>
          </div>
          <div className="rounded-lg border border-border bg-background px-3 py-2 text-[11px] text-text-tertiary">
            <div>
              {(prospectContactTotals.prospects ?? prospectContacts.length).toLocaleString()}{' '}
              deduped contacts · {filteredProspectContacts.length.toLocaleString()} shown by filter
            </div>
            <div>Refresh: {formatProspectDate(prospectContactsPayload.generated_at)}</div>
          </div>
        </div>

        <div className="mb-4 grid grid-cols-2 gap-2 md:grid-cols-6">
          {METRIC_CARDS.map(metric => {
            // eslint-disable-next-line @typescript-eslint/naming-convention
            const MetricIcon = metric.icon;
            const value = prospectContactTotals[metric.key] ?? 0;
            return (
              <div key={metric.key} className="rounded-xl border border-border bg-background p-3">
                <div className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-text-tertiary">
                  <MetricIcon className="h-3 w-3" />
                  {metric.label}
                </div>
                <div className="mt-1 text-xl font-semibold text-text-primary">{value}</div>
              </div>
            );
          })}
        </div>

        <div className="mb-4 grid gap-2 md:grid-cols-[1fr_180px_180px]">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-tertiary" />
            <input
              value={prospectSearch}
              onChange={event => {
                setProspectSearch(event.target.value);
              }}
              placeholder="Search name, company, email, channel, angle, notes..."
              className="w-full rounded-lg border border-border bg-background py-2 pl-9 pr-3 text-sm text-text-primary outline-none transition-colors placeholder:text-text-tertiary focus:border-primary"
            />
          </div>
          <select
            value={prospectBrandFilter}
            onChange={event => {
              setProspectBrandFilter(event.target.value);
            }}
            className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-text-primary outline-none focus:border-primary"
          >
            {prospectBrandOptions.map(option => (
              <option key={option} value={option}>
                {option === 'all' ? 'All brand fits' : option}
              </option>
            ))}
          </select>
          <select
            value={prospectStateFilter}
            onChange={event => {
              setProspectStateFilter(event.target.value);
            }}
            className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-text-primary outline-none focus:border-primary"
          >
            {PROSPECT_STATE_OPTIONS.map(option => (
              <option key={option} value={option}>
                {option === 'all' ? 'All states' : option}
              </option>
            ))}
          </select>
        </div>

        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.55fr)_minmax(360px,0.75fr)]">
          <div className="overflow-hidden rounded-xl border border-border">
            <div className="max-h-[calc(100vh-280px)] min-h-[520px] overflow-auto">
              <table className="min-w-full divide-y divide-border text-left text-xs">
                <thead className="sticky top-0 z-10 bg-[oklch(0.985_0.012_88)] text-[10px] uppercase tracking-wider text-text-tertiary">
                  <tr>
                    <th className="px-3 py-2 font-semibold">Prospect</th>
                    <th className="px-3 py-2 font-semibold">Fit / state</th>
                    <th className="px-3 py-2 font-semibold">Channels</th>
                    <th className="px-3 py-2 font-semibold">Subject / activity</th>
                    <th className="px-3 py-2 font-semibold">Next step</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border bg-card">
                  {visibleProspectContacts.map(p => (
                    <tr
                      key={p.id}
                      className={`cursor-pointer transition-colors hover:bg-surface-inset ${
                        selectedProspect?.id === p.id ? 'bg-surface-inset' : ''
                      }`}
                      onClick={() => {
                        setSelectedProspectId(p.id);
                      }}
                    >
                      <td className="px-3 py-3 align-top">
                        <div className="font-medium text-text-primary">{p.name}</div>
                        <div className="mt-0.5 max-w-[220px] truncate text-[11px] text-text-secondary">
                          {p.company || 'Company research needed'}
                        </div>
                        <div className="mt-0.5 text-[10px] text-text-tertiary">
                          {[p.city, p.state].filter(Boolean).join(', ') ||
                            p.source ||
                            'source pending'}
                        </div>
                      </td>
                      <td className="px-3 py-3 align-top">
                        <div className="flex flex-wrap gap-1">
                          {safeTextList(p.brand_fit).map(brand => (
                            <span
                              key={brand}
                              className="rounded-full border border-primary/25 bg-primary/5 px-1.5 py-0.5 text-[9px] font-medium text-primary"
                            >
                              {brand}
                            </span>
                          ))}
                        </div>
                        <span
                          className={`mt-1 inline-flex rounded-full border px-1.5 py-0.5 text-[9px] font-medium ${
                            STRATEGIC_STATE_TONE[p.strategic_state ?? 'cold'] ??
                            STRATEGIC_STATE_TONE.cold
                          }`}
                        >
                          {p.strategic_state ?? 'cold'}
                        </span>
                      </td>
                      <td className="px-3 py-3 align-top">
                        <div className="flex flex-wrap gap-1">
                          {safeTextList(p.channels_covered).map(channel => (
                            <span
                              key={channel}
                              className={`rounded-full border px-1.5 py-0.5 text-[9px] font-medium ${channelTone(channel)}`}
                            >
                              {channel}
                            </span>
                          ))}
                        </div>
                        <div className="mt-1 text-[10px] text-text-tertiary">
                          Open:{' '}
                          {safeTextList(p.channels_open).length
                            ? safeTextList(p.channels_open).join(', ')
                            : 'none'}
                        </div>
                      </td>
                      <td className="px-3 py-3 align-top">
                        <div className="max-w-[260px] text-[11px] text-text-secondary">
                          {safeTextList(p.engagement_subjects)[0] ||
                            p.apollo_sequence_name ||
                            'No subject logged yet'}
                        </div>
                        <div className="mt-1 text-[10px] text-text-tertiary">
                          Dial: {p.dial_last_outcome || 'n/a'} ·{' '}
                          {formatProspectDate(p.dial_last_attempt)}
                        </div>
                      </td>
                      <td className="px-3 py-3 align-top">
                        <div className="max-w-[280px] text-[11px] leading-relaxed text-text-secondary">
                          {p.next_action || 'Research next action.'}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {filteredProspectContacts.length > visibleProspectContacts.length && (
              <div className="border-t border-border bg-background px-3 py-2 text-[10px] text-text-tertiary">
                Showing first {visibleProspectContacts.length.toLocaleString()} filtered rows for
                speed. Narrow search to inspect the rest.
              </div>
            )}
          </div>

          <aside className="rounded-xl border border-border bg-background p-4">
            {selectedProspect ? (
              <div className="space-y-4">
                <div>
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <h3 className="text-base font-semibold text-text-primary">
                        {selectedProspect.name}
                      </h3>
                      <p className="text-xs text-text-secondary">
                        {selectedProspect.company || 'Company research needed'}
                      </p>
                    </div>
                    <span
                      className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${
                        STRATEGIC_STATE_TONE[selectedProspect.strategic_state ?? 'cold'] ??
                        STRATEGIC_STATE_TONE.cold
                      }`}
                    >
                      {selectedProspect.strategic_state ?? 'cold'}
                    </span>
                  </div>
                  <div className="mt-3 grid gap-1 text-[11px] text-text-secondary">
                    {selectedProspect.email && (
                      <a
                        href={`mailto:${selectedProspect.email}`}
                        className="text-primary hover:underline"
                      >
                        {selectedProspect.email}
                      </a>
                    )}
                    {selectedProspect.phone && (
                      <a
                        href={`tel:${selectedProspect.phone.replace(/[^+0-9]/g, '')}`}
                        className="text-primary hover:underline"
                      >
                        {selectedProspect.phone}
                      </a>
                    )}
                    {selectedProspect.linkedin_url && (
                      <a
                        href={selectedProspect.linkedin_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary hover:underline"
                      >
                        LinkedIn profile
                      </a>
                    )}
                  </div>
                </div>

                <div>
                  <h4 className="text-[10px] font-semibold uppercase tracking-wider text-text-tertiary">
                    Approach angle
                  </h4>
                  <p className="mt-1 text-sm leading-relaxed text-text-primary">
                    {selectedProspect.approach_angle || 'Research the angle before outreach.'}
                  </p>
                </div>

                <div className="grid gap-3 text-xs sm:grid-cols-2 xl:grid-cols-1">
                  <div className="rounded-lg border border-border bg-card p-3">
                    <h4 className="text-[10px] font-semibold uppercase tracking-wider text-text-tertiary">
                      Engagement
                    </h4>
                    <ul className="mt-2 space-y-1 text-text-secondary">
                      <li>Apollo: {selectedProspect.apollo_sequence_name || 'not covered'}</li>
                      <li>
                        LinkedIn:{' '}
                        {selectedProspect.salesnav_present || selectedProspect.heyreach_present
                          ? 'covered'
                          : 'not covered'}
                      </li>
                      <li>
                        Dial: {selectedProspect.dial_attempt_count ?? 0} attempts ·{' '}
                        {selectedProspect.dial_last_outcome || 'n/a'}
                      </li>
                      <li>
                        Opens/replies: {selectedProspect.apollo_opens ?? 0} opens ·{' '}
                        {selectedProspect.apollo_replies ?? 0} replies
                      </li>
                    </ul>
                  </div>
                  <div className="rounded-lg border border-border bg-card p-3">
                    <h4 className="text-[10px] font-semibold uppercase tracking-wider text-text-tertiary">
                      Gaps
                    </h4>
                    <p className="mt-2 text-text-secondary">
                      {safeTextList(selectedProspect.missing_fields).length
                        ? safeTextList(selectedProspect.missing_fields).join(', ')
                        : 'No core contact gaps.'}
                    </p>
                    {selectedProspect.salesnav_present && (
                      <p className="mt-2 text-[11px] text-amber-800">
                        Sales Nav messages are manual-only until Jason provides a paste/screenshot
                        or the thread runs through HeyReach.
                      </p>
                    )}
                  </div>
                </div>

                <div>
                  <h4 className="text-[10px] font-semibold uppercase tracking-wider text-text-tertiary">
                    Notes / research
                  </h4>
                  <p className="mt-1 text-sm leading-relaxed text-text-secondary">
                    {selectedProspect.notes ||
                      selectedProspect.dial_notes ||
                      selectedProspect.salesnav_thread_summary ||
                      'No notes yet.'}
                  </p>
                </div>

                <div className="rounded-lg border border-primary/20 bg-primary/5 p-3">
                  <h4 className="text-[10px] font-semibold uppercase tracking-wider text-primary">
                    Next step
                  </h4>
                  <p className="mt-1 text-sm leading-relaxed text-text-primary">
                    {selectedProspect.next_action || 'Research next action.'}
                  </p>
                </div>
              </div>
            ) : (
              <div className="rounded-lg border border-dashed border-border bg-card p-4 text-sm text-text-secondary">
                No prospect selected.
              </div>
            )}
          </aside>
        </div>

        <div className="mt-4 rounded-lg border border-amber-700/30 bg-amber-50 px-3 py-2 text-[11px] text-amber-900">
          Constraint: Apollo per-contact opens/replies are schema-ready, but will stay zero until
          the per-contact Apollo activity snapshot runs. Sales Navigator message bodies are not
          readable by API, so those summaries are manual until screenshots/pastes or HeyReach
          routing fills them.
        </div>
      </section>
    </div>
  );
}
