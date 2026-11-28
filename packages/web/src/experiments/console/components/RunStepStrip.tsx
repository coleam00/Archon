import type { ReactElement } from 'react';
import { elapsedSince, formatElapsed } from '../lib/format';
import type { Run } from '../primitives/run';

type RunStep = NonNullable<Run['progress']>['steps'][number];

// Inline colours: the console scope's wildcard border-color rule repaints Tailwind
// utilities (see theme.css), and a segment's colour is its whole meaning.
const STEP_COLOR: Record<RunStep['state'], string> = {
  completed: 'var(--success)',
  running: 'var(--running)',
  failed: 'var(--error)',
  pending: 'var(--border-bright)',
  skipped: 'var(--border)',
};

const STEP_TEXT_CLASS: Record<RunStep['state'], string> = {
  completed: 'text-text-secondary',
  running: 'font-semibold text-[color:var(--running)]',
  failed: 'text-error',
  pending: 'text-text-tertiary',
  skipped: 'text-text-tertiary line-through',
};

/** How long a step took, or has been running; null for a step with no recorded timing. */
function stepDuration(step: RunStep): string | null {
  if (step.duration_ms !== undefined) return formatElapsed(step.duration_ms / 1000);
  return step.state === 'running' && step.started_at !== undefined
    ? formatElapsed(elapsedSince(step.started_at))
    : null;
}

/**
 * A run's steps as one status-coloured segment each, in workflow order. `named` adds
 * each step's name and duration below the strip.
 */
export function RunStepStrip({
  steps,
  named,
  live,
}: {
  steps: readonly RunStep[];
  named: boolean;
  /** Whether the run is presented as live progress; a running segment pulses only then. */
  live: boolean;
}): ReactElement | null {
  if (steps.length === 0) return null;
  const done = steps.filter(step => step.state === 'completed').length;
  return (
    <div className="mt-2">
      <ol
        aria-label={`${done.toString()} of ${steps.length.toString()} steps done`}
        className="flex gap-1"
      >
        {steps.map(step => (
          <li
            key={step.node_id}
            title={`${step.node_id} · ${step.state}`}
            className={`h-1 min-w-0 flex-1 rounded-sm ${live && step.state === 'running' ? 'animate-pulse' : ''}`}
            style={{ background: STEP_COLOR[step.state] }}
          />
        ))}
      </ol>
      {named ? (
        <ul className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-console-11">
          {steps.map(step => {
            const duration = stepDuration(step);
            return (
              <li key={step.node_id} className={STEP_TEXT_CLASS[step.state]}>
                {step.node_id}
                {duration !== null ? (
                  <span className="ml-1 tabular-nums text-text-tertiary">{duration}</span>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
