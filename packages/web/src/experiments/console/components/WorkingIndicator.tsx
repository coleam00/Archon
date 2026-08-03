import type { ReactElement } from 'react';

interface WorkingIndicatorProps {
  /** Latest tool/activity name for the current turn, if any. */
  activity?: string | null;
  /** Whether the inline tool trace is currently revealed. */
  expanded: boolean;
  onToggle: () => void;
}

/**
 * Single "agent is working" affordance shown while a turn is in flight, in
 * place of a stream of raw tool-call cards. Shows the current activity (latest
 * tool) and toggles the inline trace on click.
 */
export function WorkingIndicator({
  activity,
  expanded,
  onToggle,
}: WorkingIndicatorProps): ReactElement {
  return (
    <button
      type="button"
      onClick={onToggle}
      title={expanded ? 'Hide activity' : 'Show what the agent is doing'}
      className="mt-1.5 flex w-fit items-center gap-2 rounded-full border border-border bg-surface-inset px-3 py-1.5 text-[12px] text-text-secondary transition-colors hover:border-border-bright hover:text-text-primary"
    >
      <span
        aria-hidden
        className="h-3 w-3 shrink-0 animate-spin rounded-full border-2"
        style={{
          borderColor: 'color-mix(in oklch, var(--running) 25%, transparent)',
          borderTopColor: 'var(--running)',
        }}
      />
      <span className="font-medium">Agent is working</span>
      {activity !== null && activity !== undefined && activity !== '' ? (
        <span className="font-mono text-[11px] text-text-tertiary">· {activity}</span>
      ) : null}
      <span aria-hidden className="font-mono text-[10px] text-text-tertiary">
        {expanded ? '▾ hide' : '▸ details'}
      </span>
    </button>
  );
}
