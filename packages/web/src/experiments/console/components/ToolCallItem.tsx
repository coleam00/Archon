import { useState, type ReactElement } from 'react';
import { StreamCard } from './StreamCard';
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
 * Compact tool call row. Collapsed: everything on one line — name · summary ·
 * duration · chevron. Expanded: args JSON + result below the header.
 * Clicking the card toggles expansion.
 */
export function ToolCallItem({ call, timestamp }: ToolCallItemProps): ReactElement {
  const [expanded, setExpanded] = useState(false);
  const summary = argsSummary(call.input);
  const hasDetails =
    Object.keys(call.input).length > 0 || (call.output !== undefined && call.output.length > 0);

  return (
    <StreamCard
      timestamp={timestamp}
      kind="tool"
      compact={!expanded}
      onClick={
        hasDetails
          ? (): void => {
              setExpanded(v => !v);
            }
          : undefined
      }
      headerRight={
        <>
          <span className="font-mono text-[12px] font-medium text-text-primary">{call.name}</span>
          {summary.length > 0 ? (
            <span className="min-w-0 max-w-[360px] truncate font-mono text-[11px] text-text-secondary">
              {summary}
            </span>
          ) : null}
          {call.durationMs !== undefined ? (
            <span className="shrink-0 font-mono text-[10px] tabular-nums text-text-tertiary">
              {call.durationMs.toString()}ms
            </span>
          ) : null}
          {hasDetails ? (
            <span
              aria-hidden
              className="shrink-0 font-mono text-[10px] text-text-tertiary transition-transform"
              style={{ transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)' }}
            >
              ▸
            </span>
          ) : null}
        </>
      }
    >
      {expanded && hasDetails ? (
        <div className="mt-2 space-y-1.5">
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
      ) : undefined}
    </StreamCard>
  );
}
