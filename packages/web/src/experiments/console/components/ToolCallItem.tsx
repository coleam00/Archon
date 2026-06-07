import { useState, type ReactElement } from 'react';
import { formatRelativeToBaseline, formatClock } from '../lib/format';
import { useStreamContext } from '../lib/stream-context';
import type { InlineToolCall } from '../primitives/message';

interface ToolCallItemProps {
  call: InlineToolCall;
  /** Carried from the parent message since metadata tool calls don't track their own timestamp. */
  timestamp: string;
}

function argsSummary(input: Record<string, unknown>): string {
  const keys = Object.keys(input);
  if (keys.length === 0) return '';
  const parts: string[] = [];
  for (const k of keys.slice(0, 2)) {
    const v = input[k];
    const rendered =
      typeof v === 'string' ? `"${v.length > 48 ? `${v.slice(0, 48)}…` : v}"` : JSON.stringify(v);
    parts.push(`${k}=${rendered}`);
  }
  if (keys.length > 2) parts.push(`+${(keys.length - 2).toString()}`);
  return parts.join(' ');
}

/**
 * Tool-call row, design v3 (.log-row.tool): offset gutter · purple TOOL tag ·
 * name + args preview · duration · chevron. Clicking toggles the expanded
 * args/result detail below the row.
 */
export function ToolCallItem({ call, timestamp }: ToolCallItemProps): ReactElement {
  const [expanded, setExpanded] = useState(false);
  const { runStartedAt } = useStreamContext();
  const displayed = formatRelativeToBaseline(timestamp, runStartedAt);
  const wallClock = formatClock(timestamp);
  const summary = argsSummary(call.input);
  const hasDetails =
    Object.keys(call.input).length > 0 || (call.output !== undefined && call.output.length > 0);

  return (
    <div
      onClick={
        hasDetails
          ? (): void => {
              setExpanded(v => !v);
            }
          : undefined
      }
      className={`flex flex-col border-b border-border/60 py-[11px] ${
        hasDetails ? 'cursor-pointer transition-colors hover:bg-surface-hover/50' : ''
      }`}
    >
      <div className="flex items-center gap-4">
        <time
          dateTime={timestamp}
          title={wallClock}
          className="w-14 shrink-0 font-mono text-[11.5px] tabular-nums text-text-tertiary"
        >
          {displayed}
        </time>
        <span
          className="shrink-0 rounded-[5px] border px-[7px] py-[2px] font-mono text-[10px] font-bold uppercase tracking-[0.08em]"
          // Inline because the console scope's wildcard border-color rule
          // repaints Tailwind border utilities (see theme.css).
          style={{
            color: 'var(--brand-violet)',
            background: 'color-mix(in oklch, var(--brand-violet), transparent 86%)',
            borderColor: 'color-mix(in oklch, var(--brand-violet), transparent 70%)',
          }}
        >
          Tool
        </span>
        <span className="flex min-w-0 flex-1 items-baseline gap-2.5">
          <span className="shrink-0 font-mono text-[12.5px] font-bold text-text-primary">
            {call.name}
          </span>
          {summary.length > 0 ? (
            <span className="min-w-0 truncate font-mono text-[12px] text-text-tertiary">
              {summary}
            </span>
          ) : null}
        </span>
        {call.durationMs !== undefined ? (
          <span className="shrink-0 font-mono text-[11.5px] tabular-nums text-text-tertiary">
            {call.durationMs.toString()}ms
          </span>
        ) : null}
        {hasDetails ? (
          <span
            aria-hidden
            className="shrink-0 font-mono text-[11px] text-text-tertiary transition-transform"
            style={{ transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)' }}
          >
            ▸
          </span>
        ) : null}
      </div>
      {expanded && hasDetails ? (
        <div className="ml-[72px] mt-2 space-y-1.5">
          {Object.keys(call.input).length > 0 ? (
            <pre className="overflow-x-auto rounded border border-border bg-surface-inset p-2 font-mono text-[11px] leading-relaxed text-text-secondary">
              {JSON.stringify(call.input, null, 2)}
            </pre>
          ) : null}
          {call.output !== undefined && call.output.length > 0 ? (
            <div>
              <div className="mb-0.5 text-[9px] font-semibold uppercase tracking-wider text-text-tertiary">
                Result
              </div>
              <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded border border-border bg-surface-inset p-2 font-mono text-[11px] leading-relaxed text-text-secondary">
                {call.output.length > 2000
                  ? `${call.output.slice(0, 2000)}\n\n… (${(call.output.length - 2000).toString()} more chars)`
                  : call.output}
              </pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
