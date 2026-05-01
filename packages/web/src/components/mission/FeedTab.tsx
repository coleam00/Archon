import { useState, useMemo, useEffect, useRef } from 'react';
import { useMissionStore } from '@/stores/mission-store';
import type { MissionTimelineEvent } from '@/stores/mission-store';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

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

export function FeedTab({ onOpenRun }: FeedTabProps): React.ReactElement {
  const globalFeed = useMissionStore(s => s.globalFeed);
  const [autoscroll, setAutoscroll] = useState(true);
  const [filter, setFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState<string>('');
  const bottomRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    let rows = globalFeed;
    if (typeFilter) rows = rows.filter(e => e.type === typeFilter);
    if (filter) {
      const q = filter.toLowerCase();
      rows = rows.filter(
        e =>
          e.type.toLowerCase().includes(q) ||
          e.runId.toLowerCase().includes(q) ||
          JSON.stringify(e.payload).toLowerCase().includes(q)
      );
    }
    return rows;
  }, [globalFeed, filter, typeFilter]);

  useEffect(() => {
    if (autoscroll) {
      bottomRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' });
    }
  }, [filtered.length, autoscroll]);

  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          placeholder="Filter (text in type, runId, or payload)"
          value={filter}
          onChange={e => {
            setFilter(e.target.value);
          }}
          className="max-w-sm"
        />
        <select
          value={typeFilter}
          onChange={e => {
            setTypeFilter(e.target.value);
          }}
          className="rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-text-primary"
        >
          <option value="">All types</option>
          {ALL_TYPES.map(t => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <span className="ml-auto text-xs text-text-secondary">{filtered.length} events</span>
        <Button
          type="button"
          size="sm"
          variant={autoscroll ? 'default' : 'outline'}
          onClick={() => {
            setAutoscroll(v => !v);
          }}
        >
          {autoscroll ? 'Pause' : 'Resume'}
        </Button>
      </div>

      <ol className="flex-1 space-y-1 overflow-y-auto rounded-md border border-border bg-surface p-2 font-mono text-[11px]">
        {filtered.length === 0 && (
          <li className="text-text-tertiary">No events yet — they will stream in here.</li>
        )}
        {filtered.map((event, idx) => (
          <FeedRow
            key={`${String(idx)}-${String(event.timestamp)}`}
            event={event}
            onOpenRun={onOpenRun}
          />
        ))}
        <div ref={bottomRef} />
      </ol>
    </div>
  );
}

function FeedRow({
  event,
  onOpenRun,
}: {
  event: MissionTimelineEvent;
  onOpenRun: (runId: string) => void;
}): React.ReactElement {
  const time = new Date(event.timestamp).toLocaleTimeString();
  const summary = summarize(event);
  const isClickable = event.runId !== 'system' && !event.type.startsWith('symphony_tracker_');

  return (
    <li
      className={cn(
        'flex items-start gap-2 border-l-2 border-border pl-2 hover:border-primary',
        isClickable && 'cursor-pointer'
      )}
      onClick={() => {
        if (isClickable) onOpenRun(event.runId);
      }}
    >
      <span className="shrink-0 text-text-tertiary">{time}</span>
      <span className="shrink-0 text-text-secondary">{event.type}</span>
      <span className="truncate text-text-primary">{summary}</span>
    </li>
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
