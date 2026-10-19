import type { ReactElement } from 'react';
import type { Run } from '../primitives/run';
import { ownerObservationHint } from '../lib/run-status';

/** The line that says why a running run is not shown as live; nothing while it is. */
export function OwnerObservationHint({
  run,
  className,
}: {
  run: Run;
  className: string;
}): ReactElement | null {
  const hint = ownerObservationHint(run);
  if (hint === null) return null;
  const tone = run.ownerObservation === 'unreachable' ? 'text-warning' : 'text-text-secondary';
  return <p className={`${className} text-[12px] ${tone}`}>{hint}</p>;
}
