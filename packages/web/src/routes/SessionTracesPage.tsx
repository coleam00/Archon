import { useMemo, useState } from 'react';
import {
  Activity,
  Search,
  ChevronDown,
  ChevronRight,
  User,
  Bot,
  Clock,
  CheckCircle2,
  ShieldCheck,
  Send,
} from 'lucide-react';
import tracesData from '@/lib/cc-session-traces.generated.json';
import agentRollupData from '@/lib/agent-trace.generated.json';

// PRD 7 stated outcome: per-session agent trace tab driven by static JSON.
// Source: scripts/build-cc-session-traces-json.py (cron-emitted, no live DB read).
//
// Naming note: the in-PMC-tab "Recent Carlos activity" panel (Wave 5) is fed by
// a SEPARATE file `agent-trace.generated.json` which rolls up Hermes session-store
// rows. This page consumes Claude Code's own `session-exports/**/*.jsonl` for the
// developer-side audit trail. Two adjacent surfaces, two distinct files — do NOT
// merge them; the schemas and source-of-truth differ.
//
// Privacy guard (D3 / Greg Queue B 2026-06-11): drill-down shows head 5 + tail 5
// turn previews only — NOT full transcripts. Tool calls/results stripped server-side.

interface TurnEntry {
  role: 'user' | 'assistant';
  ts: string;
  preview: string;
}

interface SessionEntry {
  session_id: string;
  workspace: string;
  started_at: string;
  ended_at: string;
  turn_count: number;
  user_turn_count: number;
  assistant_turn_count: number;
  first_prompt_preview: string;
  last_activity_preview: string;
  head_turns: TurnEntry[];
  tail_turns: TurnEntry[];
}

interface TracesPayload {
  generated_at: string;
  source: string;
  session_count: number;
  turn_count: number;
  sessions: SessionEntry[];
}

interface AgentRollupSession {
  session_id: string;
  started_at?: string | null;
  source?: string;
  model?: string;
  last_user_message_preview?: string;
  tool_call_count?: number;
  status?: string;
}

interface AgentRollupPayload {
  generated_at?: string;
  total_sessions?: number;
  recent?: AgentRollupSession[];
}

function formatTs(iso: string): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function formatDuration(start: string, end: string): string {
  if (!start || !end) return '—';
  try {
    const ms = new Date(end).getTime() - new Date(start).getTime();
    if (!Number.isFinite(ms) || ms < 0) return '—';
    const min = Math.round(ms / 60000);
    if (min < 1) return '<1 min';
    if (min < 60) return `${min} min`;
    const hr = Math.floor(min / 60);
    const rm = min % 60;
    return rm === 0 ? `${hr}h` : `${hr}h ${rm}m`;
  } catch {
    return '—';
  }
}

function shortWorkspace(path: string): string {
  // Strip everything up to the last `jid5274` segment (most paths route through it).
  const idx = path.lastIndexOf('jid5274');
  if (idx === -1) return path;
  return path.slice(idx);
}

function DailyOpsPanel({ traces }: { traces: Partial<TracesPayload> }): React.ReactElement {
  const rollup = agentRollupData as AgentRollupPayload;
  const recent = rollup.recent ?? [];
  const cronCount = recent.filter(s => s.source === 'cron').length;
  const userCount = recent.filter(s => s.source !== 'cron').length;
  const latest = recent[0];

  const tiles = [
    {
      label: 'Automation pulse',
      value: `${cronCount} cron / ${userCount} user`,
      note: 'Recent Hermes sessions split by source',
      icon: CheckCircle2,
    },
    {
      label: 'Trace coverage',
      value: `${traces.session_count ?? 0} sessions`,
      note: `${traces.turn_count ?? 0} sanitized turns in the static export`,
      icon: Activity,
    },
    {
      label: 'Privacy guard',
      value: 'Head 5 + tail 5',
      note: 'Full transcripts and tool bodies stay hidden here',
      icon: ShieldCheck,
    },
    {
      label: 'Next distribution',
      value: 'Research Firehose',
      note: 'Daily summary routes to Andrew and the VA team',
      icon: Send,
    },
  ];

  return (
    <section className="rounded-2xl border border-border bg-[oklch(0.985_0.012_88)] p-5 shadow-sm">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[var(--primary)]">
            Daily Ops Panel
          </p>
          <h2 className="mt-1 text-xl font-semibold text-text-primary">What the bots are doing</h2>
          <p className="mt-1 max-w-3xl text-sm text-text-secondary">
            Digestible operator view of automation health, trace freshness, and distribution work.
            This panel is intentionally summary-first so Jason does not need to read raw sessions.
          </p>
        </div>
        <div className="rounded-lg border border-border bg-card px-3 py-2 text-xs text-text-tertiary">
          Rollup generated {formatTs(rollup.generated_at ?? '')}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
        {tiles.map(tile => {
          // eslint-disable-next-line @typescript-eslint/naming-convention
          const Icon = tile.icon;
          return (
            <div key={tile.label} className="rounded-xl border border-border bg-card p-4">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-text-tertiary">
                  {tile.label}
                </span>
                <Icon className="h-4 w-4 text-[var(--primary)]" />
              </div>
              <div className="mt-2 text-lg font-semibold text-text-primary">{tile.value}</div>
              <p className="mt-1 text-xs leading-relaxed text-text-secondary">{tile.note}</p>
            </div>
          );
        })}
      </div>

      <div className="mt-4 rounded-xl border border-border bg-card p-4">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-text-tertiary">
          Latest visible activity
        </div>
        <p className="mt-2 text-sm text-text-primary">
          {latest?.last_user_message_preview ?? 'No recent session preview available.'}
        </p>
        <p className="mt-2 text-xs text-text-tertiary">
          Source: {latest?.source ?? 'unknown'} · Model: {latest?.model ?? 'unknown'} · Started:{' '}
          {formatTs(latest?.started_at ?? '')}
        </p>
      </div>
    </section>
  );
}

function TurnRow({ turn }: { turn: TurnEntry }): React.ReactElement {
  const isUser = turn.role === 'user';
  // eslint-disable-next-line @typescript-eslint/naming-convention
  const Icon = isUser ? User : Bot;
  return (
    <div className="flex gap-2 rounded-md border border-border bg-surface p-2 text-xs">
      <Icon
        className={`mt-0.5 h-4 w-4 flex-shrink-0 ${isUser ? 'text-emerald-600' : 'text-sky-600'}`}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-text-tertiary">
          <span>{turn.role}</span>
          <span>·</span>
          <span>{formatTs(turn.ts)}</span>
        </div>
        <p className="whitespace-pre-wrap break-words text-text-primary">{turn.preview}</p>
      </div>
    </div>
  );
}

function SessionRow({
  session,
  expanded,
  onToggle,
}: {
  session: SessionEntry;
  expanded: boolean;
  onToggle: () => void;
}): React.ReactElement {
  // eslint-disable-next-line @typescript-eslint/naming-convention
  const Chevron = expanded ? ChevronDown : ChevronRight;
  const headTurns = session.head_turns ?? [];
  const tailTurns = session.tail_turns ?? [];
  const dedupedTail = useMemo<TurnEntry[]>(() => {
    if (tailTurns.length === 0) return [];
    const headIds = new Set(headTurns.map(t => `${t.role}|${t.ts}`));
    return tailTurns.filter(t => !headIds.has(`${t.role}|${t.ts}`));
  }, [headTurns, tailTurns]);

  return (
    <div className="rounded-lg border border-border bg-surface-elevated">
      <button
        onClick={onToggle}
        className="flex w-full items-start gap-3 p-4 text-left transition-colors hover:bg-surface-hover"
        type="button"
      >
        <Chevron className="mt-0.5 h-4 w-4 flex-shrink-0 text-text-secondary" />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex items-center gap-3 text-sm font-medium text-text-primary">
            <span className="font-mono text-xs">{session.session_id.slice(0, 8)}</span>
            <span className="text-text-tertiary">·</span>
            <span className="truncate text-xs text-text-secondary">
              {shortWorkspace(session.workspace)}
            </span>
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-tertiary">
            <span className="flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {formatTs(session.started_at)}
            </span>
            <span>·</span>
            <span>{formatDuration(session.started_at, session.ended_at)}</span>
            <span>·</span>
            <span>
              {session.turn_count} turns ({session.user_turn_count} user /{' '}
              {session.assistant_turn_count} assistant)
            </span>
          </div>
          {!expanded && session.first_prompt_preview && (
            <p className="mt-1 line-clamp-2 text-xs text-text-secondary">
              <span className="font-medium text-text-tertiary">First prompt:</span>{' '}
              {session.first_prompt_preview}
            </p>
          )}
        </div>
      </button>
      {expanded && (
        <div className="flex flex-col gap-3 border-t border-border p-4">
          <div className="flex flex-col gap-2">
            <h4 className="text-[10px] font-semibold uppercase tracking-wider text-text-tertiary">
              First {headTurns.length} turns
            </h4>
            {headTurns.map((t, i) => (
              <TurnRow key={`head-${i}`} turn={t} />
            ))}
          </div>
          {dedupedTail.length > 0 && (
            <div className="flex flex-col gap-2">
              <h4 className="text-[10px] font-semibold uppercase tracking-wider text-text-tertiary">
                Last {dedupedTail.length} turns
              </h4>
              {dedupedTail.map((t, i) => (
                <TurnRow key={`tail-${i}`} turn={t} />
              ))}
            </div>
          )}
          <p className="text-[10px] italic text-text-tertiary">
            Drill-down is head 5 + tail 5 turn previews only (PII guard, Greg Queue B 2026-06-11).
            Tool calls and full transcripts are intentionally stripped at build time. For the raw
            export, see <code className="rounded bg-surface px-1">jid5274/session-exports/</code>.
          </p>
        </div>
      )}
    </div>
  );
}

export function SessionTracesPage(): React.ReactElement {
  const data = tracesData as Partial<TracesPayload>;
  const sessions = data.sessions ?? [];
  const [query, setQuery] = useState<string>('');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const filtered = useMemo<SessionEntry[]>(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter(s => {
      const blob = [
        s.session_id,
        s.workspace,
        s.first_prompt_preview,
        s.last_activity_preview,
        ...(s.head_turns ?? []).map(t => t.preview),
        ...(s.tail_turns ?? []).map(t => t.preview),
      ]
        .join(' ')
        .toLowerCase();
      return blob.includes(q);
    });
  }, [sessions, query]);

  return (
    <div className="flex h-full flex-1 flex-col gap-6 overflow-y-auto p-6">
      {/* Hero */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-3">
          <Activity className="h-6 w-6 text-sky-600" />
          <h1
            className="text-3xl font-semibold text-text-primary"
            style={{ fontFamily: "'Playfair Display', serif" }}
          >
            Agent Traces
          </h1>
          <span className="rounded-full border border-sky-700/40 bg-sky-100 px-2 py-0.5 text-[10px] font-medium text-sky-800">
            static · cron-emitted
          </span>
        </div>
        <p className="text-sm text-text-secondary">
          Read-only roll-up of recent Claude Code agent sessions in this workspace. Source is the
          on-disk <code className="rounded bg-surface px-1">session-exports/</code> tree; data is
          regenerated by <code className="rounded bg-surface px-1">build-agent-trace-json.py</code>{' '}
          on the dashboard cron. Tool-call bodies and full transcripts are stripped at build time
          per the 2026-06-11 D3 decision (Greg Queue B).
        </p>
        <div className="flex flex-wrap items-center gap-3 text-xs text-text-tertiary">
          <span>
            <strong className="text-text-secondary">{data.session_count ?? sessions.length}</strong>{' '}
            sessions
          </span>
          <span>·</span>
          <span>
            <strong className="text-text-secondary">{data.turn_count ?? 0}</strong> turns
          </span>
          <span>·</span>
          <span>Generated {formatTs(data.generated_at ?? '')}</span>
        </div>
      </div>

      <DailyOpsPanel traces={data} />

      {/* Filter */}
      <div className="flex items-center gap-2 rounded-lg border border-border bg-surface-elevated px-3 py-2">
        <Search className="h-4 w-4 text-text-tertiary" />
        <input
          type="text"
          value={query}
          onChange={e => {
            setQuery(e.target.value);
          }}
          placeholder="Filter by session id, workspace, or turn text…"
          className="flex-1 bg-transparent text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none"
        />
        {query && (
          <span className="text-xs text-text-tertiary">
            {filtered.length} / {sessions.length}
          </span>
        )}
      </div>

      {/* Session list */}
      {filtered.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border bg-surface p-8 text-center text-sm text-text-tertiary">
          {sessions.length === 0
            ? 'No session exports found. Has the build script run yet?'
            : 'No sessions match this filter.'}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {filtered.map(s => (
            <SessionRow
              key={s.session_id}
              session={s}
              expanded={expandedId === s.session_id}
              onToggle={() => {
                setExpandedId(prev => (prev === s.session_id ? null : s.session_id));
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
