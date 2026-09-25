import type { ReactElement } from 'react';
import type { RunOutcome } from '../primitives/run';

const outcomeClass: Record<Exclude<RunOutcome, null>, string> = {
  succeeded: 'border-success/35 bg-success/[0.08] text-success',
  failed: 'border-error/35 bg-error/[0.08] text-error',
};

export function RunOutcomeBadge({ outcome }: { outcome: RunOutcome }): ReactElement | null {
  if (outcome === null) return null;
  return (
    <span
      data-run-outcome={outcome}
      aria-label={`Authored outcome: ${outcome}`}
      title="Workflow-authored outcome"
      className={`shrink-0 rounded-full border px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.04em] ${outcomeClass[outcome]}`}
    >
      Outcome: {outcome}
    </span>
  );
}
