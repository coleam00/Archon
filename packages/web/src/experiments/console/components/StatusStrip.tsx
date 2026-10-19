import type { ReactElement } from 'react';
import { statusStripClass, stillRunningStripClass, type RunStatus } from '../lib/run-status';

/** 4px vertical strip flush-left on a run card. A running strip pulses only while `live`. */
export function StatusStrip({
  status,
  live = true,
}: {
  status: RunStatus;
  live?: boolean;
}): ReactElement {
  return (
    <span
      aria-hidden="true"
      className={`absolute left-0 top-0 h-full w-1 ${
        status === 'running' && !live ? stillRunningStripClass : statusStripClass[status]
      }`}
    />
  );
}
