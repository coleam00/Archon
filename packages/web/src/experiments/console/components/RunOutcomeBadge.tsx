import type { ReactElement } from 'react';
import type { Run, RunOutcome } from '../primitives/run';

const outcomeClass: Record<Exclude<RunOutcome, null>, string> = {
  succeeded: 'border-success/35 bg-success/[0.08] text-success',
  failed: 'border-error/35 bg-error/[0.08] text-error',
};

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
      className={`shrink-0 rounded-full border px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.04em] ${outcomeClass[outcome]}`}
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
      <dl className="grid min-w-0 max-w-full grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-1 text-[11px]">
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
