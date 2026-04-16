import type { ReactElement } from 'react';
import type { RunOrigin } from '../primitives/run';

const ORIGIN_LABEL: Record<RunOrigin, string> = {
  web: 'Web',
  cli: 'CLI',
  slack: 'Slack',
  telegram: 'Telegram',
  discord: 'Discord',
  github: 'GitHub',
  unknown: '—',
};

/** Compact monochrome pill. Never ALL-CAPS, never suffixed. */
export function OriginBadge({ origin }: { origin: RunOrigin }): ReactElement {
  return (
    <span
      className="inline-flex items-center rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-text-secondary"
      title={`Origin: ${ORIGIN_LABEL[origin]}`}
    >
      {ORIGIN_LABEL[origin]}
    </span>
  );
}
