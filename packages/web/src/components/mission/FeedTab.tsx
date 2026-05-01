import { useState, useMemo, useEffect, useRef } from 'react';
import { Pause, Play } from 'lucide-react';
import { useMissionStore } from '@/stores/mission-store';
import type { MissionTimelineEvent } from '@/stores/mission-store';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Mono, fmtAgo } from './primitives';

interface FeedTabProps {
  onOpenRun: (runId: string) => void;
}

const ALL_TYPES = [
  'workflow_status',
  'dag_node',
  'workflow_step',
  'workflow_tool_activity',
  'workflow_artifact',
  'symphony_dispatch_claimed',
  'symphony_dispatch_started',
  'symphony_dispatch_completed',
  'symphony_dispatch_failed',
  'symphony_dispatch_cancelled',
  'symphony_dispatch_retry_scheduled',
  'symphony_tracker_poll_completed',
] as const;

const LEVEL_FOR_TYPE: Record<string, 'ok' | 'warn' | 'err' | 'info'> = {
  workflow_status: 'info',
  workflow_artifact: 'info',
  symphony_dispatch_completed: 'ok',
  symphony_dispatch_failed: 'err',
  symphony_dispatch_retry_scheduled: 'warn',
  symphony_dispatch_cancelled: 'warn',
};

const LEVEL_TINTS: Record<string, { color: string; bg: string }> = {
  ok: { color: 'var(--bridges-success)', bg: 'var(--bridges-tint-success-bg)' },
  warn: { color: 'var(--bridges-warning)', bg: 'var(--bridges-tint-warning-bg)' },
  err: { color: 'var(--bridges-danger)', bg: 'var(--bridges-tint-danger-bg)' },
  info: { color: 'var(--bridges-fg2)', bg: 'var(--bridges-surface-subtle)' },
};

function levelOf(type: string, payload: Record<string, unknown>): 'ok' | 'warn' | 'err' | 'info' {
  if (typeof payload.error === 'string' || typeof payload.errorMessage === 'string') return 'err';
  if (LEVEL_FOR_TYPE[type]) return LEVEL_FOR_TYPE[type];
  return 'info';
}

export function FeedTab({ onOpenRun }: FeedTabProps): React.ReactElement {
  const globalFeed = useMissionStore(s => s.globalFeed);
  const [autoscroll, setAutoscroll] = useState(true);
  const [typeFilter, setTypeFilter] = useState<string>('');
  const bottomRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    if (!typeFilter) return globalFeed;
    return globalFeed.filter(e => e.type === typeFilter);
  }, [globalFeed, typeFilter]);

  useEffect(() => {
    if (autoscroll) {
      bottomRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' });
    }
  }, [filtered.length, autoscroll]);

  return (
    <div className="mx-auto max-w-[1100px] px-6 pb-6 pt-4">
      <div className="mb-3.5 flex items-center gap-2.5">
        <h1 className="m-0 text-[18px] font-semibold tracking-tight text-bridges-fg1">Feed</h1>
        <span className="text-[13px] text-bridges-fg3">
          Every workflow event across every run, newest first.
        </span>
        <div className="flex-1" />
        <select
          value={typeFilter}
          onChange={e => {
            setTypeFilter(e.target.value);
          }}
          className="rounded-md border border-bridges-border bg-bridges-surface px-2 py-1 text-[12px] text-bridges-fg1"
        >
          <option value="">All types</option>
          {ALL_TYPES.map(t => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <Button
          type="button"
          size="sm"
          variant={autoscroll ? 'default' : 'outline'}
          onClick={() => {
            setAutoscroll(v => !v);
          }}
        >
          {autoscroll ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3" />}
          {autoscroll ? 'Pause autoscroll' : 'Resume autoscroll'}
        </Button>
      </div>

      <div className="overflow-hidden rounded-xl border border-bridges-border bg-bridges-surface">
        {filtered.length === 0 && (
          <p className="px-4 py-8 text-center text-[12.5px] text-bridges-fg3">
            No events yet — they will stream in here.
          </p>
        )}
        {filtered.map((event, idx) => (
          <FeedRow
            key={`${String(idx)}-${String(event.timestamp)}`}
            event={event}
            isLast={idx === filtered.length - 1}
            onOpenRun={onOpenRun}
          />
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

function FeedRow({
  event,
  isLast,
  onOpenRun,
}: {
  event: MissionTimelineEvent;
  isLast: boolean;
  onOpenRun: (runId: string) => void;
}): React.ReactElement {
  const isClickable = event.runId !== 'system' && !event.type.startsWith('symphony_tracker_');
  const level = levelOf(event.type, event.payload);
  const tint = LEVEL_TINTS[level];
  const summary = summarize(event);
  const text = event.type.split('.')[0]?.split('_')[0] ?? event.type;

  return (
    <button
      type="button"
      onClick={() => {
        if (isClickable) onOpenRun(event.runId);
      }}
      disabled={!isClickable}
      className={cn(
        'grid w-full grid-cols-[60px_90px_130px_1fr_auto] items-center gap-3 px-4 py-2.5 text-left text-[13px] transition-colors',
        isClickable ? 'cursor-pointer hover:bg-bridges-surface-subtle' : 'cursor-default',
        !isLast && 'border-b border-bridges-border-subtle'
      )}
    >
      <Mono className="text-[11px] text-bridges-fg3">{fmtAgo(event.timestamp)}</Mono>
      <span
        className="rounded px-2 py-0.5 text-center text-[10.5px] font-semibold uppercase tracking-[0.05em]"
        style={{ background: tint.bg, color: tint.color }}
      >
        {text}
      </span>
      <Mono className="text-[11.5px] text-bridges-fg2 truncate">{event.runId}</Mono>
      <span className="min-w-0 truncate text-bridges-fg2">{summary || event.type}</span>
      <span className="font-mono text-[11px] text-bridges-fg3">{event.type}</span>
    </button>
  );
}

function summarize(event: MissionTimelineEvent): string {
  const p = event.payload;
  const parts: string[] = [];
  if (typeof p.workflowName === 'string') parts.push(p.workflowName);
  if (typeof p.identifier === 'string') parts.push(p.identifier);
  if (typeof p.name === 'string') parts.push(p.name);
  if (typeof p.toolName === 'string') parts.push(`tool:${p.toolName}`);
  if (typeof p.status === 'string') parts.push(`→${p.status}`);
  if (typeof p.error === 'string') parts.push(`error:${p.error.slice(0, 80)}`);
  if (typeof p.errorMessage === 'string') parts.push(`error:${p.errorMessage.slice(0, 80)}`);
  return parts.join(' · ');
}
