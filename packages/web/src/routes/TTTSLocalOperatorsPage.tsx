import { createElement, useMemo, useState } from 'react';
import { ExternalLink, Search, Target, Users, Phone, Mail, Wrench } from 'lucide-react';
import localOperatorData from '@/lib/ttts-local-operators.generated.json';

interface LocalOperator {
  priority?: string;
  relationship_lane?: string;
  prospect?: string;
  title?: string;
  company?: string;
  icp_bucket?: string;
  fit_score?: string;
  city?: string;
  state?: string;
  phone?: string;
  email?: string;
  website?: string;
  linkedin_url?: string;
  instagram_handle?: string;
  source_channels?: string;
  source_systems?: string;
  evidence_type?: string;
  outreach_status?: string;
  interest_level?: string;
  event_attendance_status?: string;
  last_signal_date?: string;
  last_message_or_note?: string;
  campaign_or_context?: string;
  recommended_next_action?: string;
  owner?: string;
  ttts_master_id?: string;
  heyreach_campaign_id?: string;
  heyreach_lead_status?: string;
  heyreach_connection_status?: string;
  heyreach_message_status?: string;
  dial_status?: string;
  meeting_status?: string;
  suppression_status?: string;
  source_artifacts?: string;
  notes?: string;
}

interface LocalOperatorPayload {
  generated_at?: string;
  google_sheet_url?: string;
  local_workbook?: string;
  source_note?: string;
  totals?: Record<string, number>;
  lane_counts?: Record<string, number>;
  icp_counts?: Record<string, number>;
  notes?: string[];
  operators?: LocalOperator[];
}

const LANE_OPTIONS = [
  'all',
  'P0 attended / RSVP follow-up',
  'P1 September / collaboration',
  'P1 book next conversation',
  'P2 future event nurture',
  'P3 reached -- no reply yet',
  'P4 attempted -- repair channel',
];

const LANE_TONES: Record<string, string> = {
  'P0 attended / RSVP follow-up': 'border-emerald-700/40 bg-emerald-100 text-emerald-800',
  'P1 September / collaboration': 'border-violet-700/40 bg-violet-100 text-violet-800',
  'P1 book next conversation': 'border-sky-700/40 bg-sky-100 text-sky-800',
  'P2 future event nurture': 'border-amber-700/40 bg-amber-100 text-amber-800',
  'P3 reached -- no reply yet': 'border-slate-700/30 bg-slate-100 text-slate-800',
  'P4 attempted -- repair channel': 'border-red-700/30 bg-red-100 text-red-800',
};

function safeOperators(value: unknown): LocalOperator[] {
  return Array.isArray(value)
    ? value.filter((row): row is LocalOperator => typeof row === 'object' && row !== null)
    : [];
}

function safeTotals(value: unknown): Record<string, number> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, number] => {
      const [, metric] = entry;
      return typeof metric === 'number' && Number.isFinite(metric);
    })
  );
}

function splitParts(value?: string): string[] {
  return (value ?? '')
    .split('|')
    .map(part => part.trim())
    .filter(Boolean)
    .slice(0, 4);
}

function laneTone(lane?: string): string {
  return lane
    ? (LANE_TONES[lane] ?? 'border-border bg-card text-text-tertiary')
    : 'border-border bg-card text-text-tertiary';
}

function operatorId(row: LocalOperator, index = 0): string {
  return (
    row.ttts_master_id ||
    row.prospect ||
    row.company ||
    row.email ||
    row.phone ||
    row.linkedin_url ||
    row.instagram_handle ||
    row.website ||
    row.source_artifacts ||
    `operator-${index}`
  );
}

function normalizeDate(value?: string): string {
  if (!value) return 'n/a';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 10);
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function TTTSLocalOperatorsPage(): React.ReactElement {
  const payload = localOperatorData as Partial<LocalOperatorPayload> & { operators?: unknown };
  const operators = safeOperators(payload.operators);
  const totals = safeTotals(payload.totals);
  const laneCounts = safeTotals(payload.lane_counts);
  const icpCounts = safeTotals(payload.icp_counts);
  const notes = Array.isArray(payload.notes)
    ? payload.notes.filter((n): n is string => typeof n === 'string')
    : [];

  const [search, setSearch] = useState('');
  const [laneFilter, setLaneFilter] = useState('all');
  const [icpFilter, setIcpFilter] = useState('all');
  const [selectedId, setSelectedId] = useState<string | null>(
    operators[0] ? operatorId(operators[0]) : null
  );

  const icpOptions = useMemo(() => ['all', ...Object.keys(icpCounts).sort()], [icpCounts]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return operators.filter(row => {
      const laneOk = laneFilter === 'all' || row.relationship_lane === laneFilter;
      const icpOk = icpFilter === 'all' || (row.icp_bucket || 'Unknown') === icpFilter;
      const queryOk =
        !q ||
        [
          row.prospect,
          row.title,
          row.company,
          row.icp_bucket,
          row.city,
          row.state,
          row.phone,
          row.email,
          row.linkedin_url,
          row.instagram_handle,
          row.source_channels,
          row.outreach_status,
          row.interest_level,
          row.last_message_or_note,
          row.recommended_next_action,
          row.notes,
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
          .includes(q);
      return laneOk && icpOk && queryOk;
    });
  }, [icpFilter, laneFilter, operators, search]);

  const visible = filtered.slice(0, 250);
  const selected =
    filtered.find((row, index) => operatorId(row, index) === selectedId) ?? filtered[0] ?? null;

  const metricCards = [
    { label: 'Total operators', value: totals.included ?? operators.length, icon: Users },
    { label: 'Hot follow-up', value: totals.hot_follow_up ?? 0, icon: Target },
    { label: 'Phone available', value: totals.with_phone ?? 0, icon: Phone },
    { label: 'Email available', value: totals.with_email ?? 0, icon: Mail },
    { label: 'LinkedIn available', value: totals.with_linkedin ?? 0, icon: Users },
    { label: 'Repair channel', value: totals.repair_channel ?? 0, icon: Wrench },
  ];

  return (
    <div className="flex flex-1 flex-col gap-6 p-6">
      <section className="rounded-2xl border border-border bg-card p-5 shadow-sm">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[var(--primary)]">
              TTTS Local Operators
            </p>
            <h1
              className="mt-1 text-3xl font-semibold text-text-primary"
              style={{ fontFamily: "'Playfair Display', serif" }}
            >
              Local health & wellness business inventory
            </h1>
            <p className="mt-1 max-w-3xl text-sm text-text-secondary">
              Deduped post-event operator list from HeyReach, LinkedIn/Sales Nav capture, dialer
              outcomes, Instagram-evidence rows, and Jason's TTTS event summary. Explicit
              not-interested responses are excluded from this active operator view.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {payload.google_sheet_url && (
              <a
                href={payload.google_sheet_url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-2 rounded-md border border-primary/40 bg-primary/10 px-3 py-2 text-xs font-medium text-primary hover:bg-primary/15"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                Open Google Sheet
              </a>
            )}
            <span className="rounded-full border border-border bg-surface-elevated px-3 py-2 text-xs text-text-secondary">
              generated {normalizeDate(payload.generated_at)}
            </span>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          {metricCards.map(card => (
            <div
              key={card.label}
              className="rounded-xl border border-border bg-surface-elevated p-3"
            >
              <div className="mb-2 flex items-center justify-between text-text-tertiary">
                <span className="text-[10px] uppercase tracking-wider">{card.label}</span>
                {createElement(card.icon, { className: 'h-4 w-4' })}
              </div>
              <p className="text-2xl font-semibold text-text-primary">{card.value}</p>
            </div>
          ))}
        </div>

        {notes.length > 0 && (
          <div className="mt-4 grid gap-2 text-xs text-text-secondary md:grid-cols-2">
            {notes.slice(0, 4).map(note => (
              <div key={note} className="rounded-lg border border-border bg-surface-inset p-3">
                {note}
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="grid min-h-[620px] gap-4 lg:grid-cols-[minmax(0,1.25fr)_minmax(360px,0.75fr)]">
        <div className="rounded-2xl border border-border bg-card p-4 shadow-sm">
          <div className="mb-3 grid gap-2 md:grid-cols-[minmax(220px,1fr)_220px_180px]">
            <label className="relative block">
              <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-text-tertiary" />
              <input
                value={search}
                onChange={e => {
                  setSearch(e.target.value);
                }}
                placeholder="Search name, company, phone, email, city, signal..."
                className="w-full rounded-md border border-border bg-surface px-9 py-2 text-sm text-text-primary outline-none focus:border-primary"
              />
            </label>
            <select
              value={laneFilter}
              onChange={e => {
                setLaneFilter(e.target.value);
              }}
              className="rounded-md border border-border bg-surface px-3 py-2 text-sm text-text-primary outline-none focus:border-primary"
            >
              {LANE_OPTIONS.map(lane => (
                <option key={lane} value={lane}>
                  {lane === 'all' ? 'All lanes' : `${lane} (${laneCounts[lane] ?? 0})`}
                </option>
              ))}
            </select>
            <select
              value={icpFilter}
              onChange={e => {
                setIcpFilter(e.target.value);
              }}
              className="rounded-md border border-border bg-surface px-3 py-2 text-sm text-text-primary outline-none focus:border-primary"
            >
              {icpOptions.map(icp => (
                <option key={icp} value={icp}>
                  {icp === 'all' ? 'All ICPs' : `${icp} (${icpCounts[icp] ?? 0})`}
                </option>
              ))}
            </select>
          </div>

          <div className="mb-2 flex items-center justify-between text-xs text-text-tertiary">
            <span>
              Showing {visible.length} of {filtered.length} matching operators
            </span>
            <span>{totals.excluded_not_interested ?? 0} explicit not-interested rows excluded</span>
          </div>

          <div className="space-y-2 overflow-y-auto pr-1" style={{ maxHeight: 560 }}>
            {visible.map((row, index) => {
              const id = operatorId(row, index);
              const active = selectedId === id;
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => {
                    setSelectedId(id);
                  }}
                  className={`w-full rounded-xl border p-3 text-left transition-colors ${
                    active
                      ? 'border-primary bg-primary/5'
                      : 'border-border bg-surface-elevated hover:border-border-bright hover:bg-surface-hover'
                  }`}
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <p className="text-sm font-semibold text-text-primary">
                        {row.prospect || row.company || 'Unnamed operator'}
                      </p>
                      <p className="text-xs text-text-secondary">
                        {[row.title, row.company].filter(Boolean).join(' · ') || 'Company TBD'}
                      </p>
                    </div>
                    <span
                      className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${laneTone(row.relationship_lane)}`}
                    >
                      {row.relationship_lane || 'unclassified'}
                    </span>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1 text-[10px] text-text-tertiary">
                    {row.icp_bucket && (
                      <span className="rounded-full bg-surface-inset px-2 py-0.5">
                        {row.icp_bucket}
                      </span>
                    )}
                    {row.city && (
                      <span className="rounded-full bg-surface-inset px-2 py-0.5">{row.city}</span>
                    )}
                    {row.phone && (
                      <span className="rounded-full bg-surface-inset px-2 py-0.5">phone</span>
                    )}
                    {row.email && (
                      <span className="rounded-full bg-surface-inset px-2 py-0.5">email</span>
                    )}
                    {row.linkedin_url && (
                      <span className="rounded-full bg-surface-inset px-2 py-0.5">LinkedIn</span>
                    )}
                  </div>
                  {(row.last_message_or_note || row.recommended_next_action) && (
                    <p className="mt-2 line-clamp-2 text-xs text-text-secondary">
                      {row.last_message_or_note || row.recommended_next_action}
                    </p>
                  )}
                </button>
              );
            })}
            {visible.length === 0 && (
              <div className="rounded-xl border border-dashed border-border bg-surface-elevated p-4 text-sm text-text-secondary">
                No operators match the current filters. Clear search or switch lane / ICP filters to
                restore the active TTTS outreach list.
              </div>
            )}
          </div>
        </div>

        <aside className="rounded-2xl border border-border bg-card p-4 shadow-sm">
          {selected ? (
            <div className="space-y-4">
              <div>
                <div className="mb-2 flex flex-wrap gap-2">
                  <span
                    className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${laneTone(selected.relationship_lane)}`}
                  >
                    {selected.relationship_lane}
                  </span>
                  {selected.ttts_master_id && (
                    <span className="rounded-full border border-border bg-surface-elevated px-2 py-0.5 text-[10px] text-text-tertiary">
                      {selected.ttts_master_id}
                    </span>
                  )}
                </div>
                <h2 className="text-xl font-semibold text-text-primary">
                  {selected.prospect || selected.company}
                </h2>
                <p className="text-sm text-text-secondary">
                  {[selected.title, selected.company].filter(Boolean).join(' · ')}
                </p>
              </div>

              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="rounded-lg border border-border bg-surface-elevated p-3">
                  <div className="text-text-tertiary">ICP / fit</div>
                  <div className="mt-1 font-medium text-text-primary">
                    {selected.icp_bucket || 'Unknown'}{' '}
                    {selected.fit_score ? `· ${selected.fit_score}/5` : ''}
                  </div>
                </div>
                <div className="rounded-lg border border-border bg-surface-elevated p-3">
                  <div className="text-text-tertiary">Last signal</div>
                  <div className="mt-1 font-medium text-text-primary">
                    {normalizeDate(selected.last_signal_date)}
                  </div>
                </div>
              </div>

              <div className="space-y-2 text-sm">
                {selected.phone && (
                  <p>
                    <strong className="text-text-primary">Phone:</strong>{' '}
                    <span className="text-text-secondary">{selected.phone}</span>
                  </p>
                )}
                {selected.email && (
                  <p>
                    <strong className="text-text-primary">Email:</strong>{' '}
                    <span className="text-text-secondary">{selected.email}</span>
                  </p>
                )}
                {(selected.city || selected.state) && (
                  <p>
                    <strong className="text-text-primary">Location:</strong>{' '}
                    <span className="text-text-secondary">
                      {[selected.city, selected.state].filter(Boolean).join(', ')}
                    </span>
                  </p>
                )}
              </div>

              <div className="flex flex-wrap gap-2">
                {selected.linkedin_url && (
                  <a
                    href={selected.linkedin_url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 rounded-md border border-border bg-surface-elevated px-2 py-1 text-xs text-text-secondary hover:text-primary"
                  >
                    LinkedIn <ExternalLink className="h-3 w-3" />
                  </a>
                )}
                {selected.website && (
                  <a
                    href={selected.website}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 rounded-md border border-border bg-surface-elevated px-2 py-1 text-xs text-text-secondary hover:text-primary"
                  >
                    Website <ExternalLink className="h-3 w-3" />
                  </a>
                )}
                {selected.instagram_handle && (
                  <span className="rounded-md border border-border bg-surface-elevated px-2 py-1 text-xs text-text-secondary">
                    IG: {selected.instagram_handle}
                  </span>
                )}
              </div>

              <div className="rounded-xl border border-border bg-surface-elevated p-3">
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-text-tertiary">
                  Signal / note
                </h3>
                <p className="text-sm text-text-secondary">
                  {selected.last_message_or_note || 'No note captured.'}
                </p>
              </div>

              <div className="rounded-xl border border-border bg-surface-elevated p-3">
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-text-tertiary">
                  Next action
                </h3>
                <p className="text-sm text-text-secondary">
                  {selected.recommended_next_action || 'Qualify follow-up path.'}
                </p>
              </div>

              <div className="rounded-xl border border-border bg-surface-elevated p-3 text-xs text-text-secondary">
                <h3 className="mb-2 font-semibold uppercase tracking-wider text-text-tertiary">
                  Source coverage
                </h3>
                <p>
                  <strong>Channels:</strong> {selected.source_channels || 'n/a'}
                </p>
                <p>
                  <strong>Systems:</strong> {selected.source_systems || 'n/a'}
                </p>
                <p>
                  <strong>Outreach:</strong> {selected.outreach_status || 'n/a'}
                </p>
                <p>
                  <strong>HeyReach:</strong>{' '}
                  {[
                    selected.heyreach_lead_status,
                    selected.heyreach_connection_status,
                    selected.heyreach_message_status,
                  ]
                    .filter(Boolean)
                    .join(' · ') || 'n/a'}
                </p>
                <p>
                  <strong>Dial:</strong> {selected.dial_status || 'n/a'}
                </p>
              </div>

              {splitParts(selected.source_artifacts).length > 0 && (
                <div className="rounded-xl border border-border bg-surface-inset p-3 text-[11px] text-text-tertiary">
                  <h3 className="mb-1 font-semibold uppercase tracking-wider">Artifacts</h3>
                  {splitParts(selected.source_artifacts).map(part => (
                    <p key={part}>{part}</p>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className="rounded-xl border border-border bg-surface-elevated p-4 text-sm text-text-secondary">
              No operator selected.
            </div>
          )}
        </aside>
      </section>
    </div>
  );
}
