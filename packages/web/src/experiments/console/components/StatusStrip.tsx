import type { ReactElement } from 'react';
import { statusStripClass, type RunStatus } from '../lib/run-status';

/** 4px vertical strip flush-left on a run card. */
export function StatusStrip({ status }: { status: RunStatus }): ReactElement {
  return (
    <span
      aria-hidden="true"
      className={`absolute left-0 top-0 h-full w-1 ${statusStripClass[status]}`}
    />
  );
}
