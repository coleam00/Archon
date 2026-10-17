import type { ReactElement } from 'react';
import type { ProviderEvent } from '../lib/provider-events';
import { StreamCard } from './StreamCard';

interface HookEventItemProps {
  event: Extract<ProviderEvent, { type: 'hook' }>;
  timestamp: string;
}

export function HookEventItem({ event, timestamp }: HookEventItemProps): ReactElement {
  const failed = event.status === 'failed' || event.status === 'cancelled';
  return (
    <div className="py-1">
      <StreamCard
        timestamp={timestamp}
        kind={failed ? 'error' : 'tool'}
        label="Hook"
        compact
        headerRight={
          <span
            className={`shrink-0 font-mono text-[11.5px] ${failed ? 'text-error' : 'text-text-secondary'}`}
          >
            {event.status}
            {event.exitCode !== undefined ? ` (exit ${event.exitCode.toString()})` : ''}
          </span>
        }
      >
        <div className="flex min-w-0 items-baseline gap-2.5 font-mono text-[12px]">
          <span className="break-all font-bold text-text-primary">
            {event.hookName || event.hookId}
          </span>
          <span className="text-text-secondary">{event.hookEvent}</span>
        </div>
      </StreamCard>
    </div>
  );
}
