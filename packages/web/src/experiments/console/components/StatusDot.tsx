import type { ReactElement } from 'react';
import { statusDotClass, type RunStatus } from '../lib/run-status';

interface StatusDotProps {
  status: RunStatus;
  size?: number;
}

export function StatusDot({ status, size = 8 }: StatusDotProps): ReactElement {
  return (
    <span
      aria-hidden="true"
      className={`inline-block rounded-full ${statusDotClass[status]}`}
      style={{ width: size, height: size }}
    />
  );
}
