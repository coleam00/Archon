import type { ReactElement } from 'react';
import type { Run } from '../primitives/run';
import { operatorPauseHint } from '../lib/run-status';

/** Who paused the run and how to resume it; nothing when no operator pause applies. */
export function OperatorPauseHint({
  run,
  className,
}: {
  run: Run;
  className: string;
}): ReactElement | null {
  const hint = operatorPauseHint(run);
  if (hint === null) return null;
  return <p className={`${className} text-console-12 text-text-secondary`}>{hint}</p>;
}
