import type { ReactElement } from 'react';
import type { Run, RunOutcome } from '../primitives/run';

// A named outcome (a string enum the workflow declares) carries no success or failure
// meaning the console can know, so it takes the neutral style.
function outcomeClass(outcome: string): string {
  if (outcome === 'succeeded') return 'border-success/35 bg-success/[0.08] text-success';
  if (outcome === 'failed') return 'border-error/35 bg-error/[0.08] text-error';
  return 'border-border bg-surface-elevated text-text-secondary';
}

export function RunOutcomeBadge({
  outcome,
  terminalRecord,
}: {
  outcome: RunOutcome;
  terminalRecord?: Run['terminalRecord'];
}): ReactElement | null {
  if (outcome === null) return null;
  const badge = (
    <span
      data-run-outcome={outcome}
      aria-label={`Authored outcome: ${outcome}`}
      title="Workflow-authored outcome"
      className={`shrink-0 rounded-full border px-2 py-0.5 font-mono text-console-10 font-semibold uppercase tracking-wider ${outcomeClass(outcome)}`}
    >
      Outcome: {outcome}
    </span>
  );
  const returns = terminalRecord?.returns;
  const value = returns?.availability === 'available' ? returns.value : undefined;
  const fields =
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? Object.entries(value).filter(
          (entry: [string, unknown]): entry is [string, string] =>
            typeof entry[1] === 'string' && entry[1].trim() !== ''
        )
      : [];
  if (fields.length === 0) return badge;

  return (
    <div className="inline-flex max-w-full min-w-0 flex-wrap items-start gap-2">
      {badge}
      <dl
        aria-label="Workflow output"
        tabIndex={0}
        className="grid max-h-[30vh] min-w-0 max-w-full grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-1 overflow-y-auto text-console-11"
      >
        {fields.map(([key, text]) => (
          <div key={key} className="contents">
            <dt className="max-w-32 whitespace-pre-wrap font-mono text-text-tertiary [overflow-wrap:anywhere]">
              {key}
            </dt>
            <dd className="min-w-0 whitespace-pre-wrap text-text-secondary [overflow-wrap:anywhere]">
              {text}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
