import type { ReactElement } from 'react';
import { StreamCard } from './StreamCard';
import type { ArtifactEvent } from '../primitives/event';

interface ArtifactItemProps {
  event: ArtifactEvent;
}

export function ArtifactItem({ event }: ArtifactItemProps): ReactElement {
  const href = event.url ?? event.path ?? null;
  const label = event.label.length > 0 ? event.label : 'unnamed';
  const typeLabel = event.artifactType.length > 0 ? event.artifactType : 'artifact';

  return (
    <StreamCard
      timestamp={event.timestamp}
      kind="artifact"
      label={typeLabel}
      headerRight={
        href !== null ? (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            className="rounded border border-border px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary"
            onClick={e => {
              e.stopPropagation();
            }}
          >
            Open
          </a>
        ) : null
      }
    >
      <div className="flex flex-col gap-0.5">
        <span className="font-mono text-[13px] text-text-primary">{label}</span>
        {event.path !== null ? (
          <span className="truncate font-mono text-[11px] text-text-tertiary">{event.path}</span>
        ) : null}
      </div>
    </StreamCard>
  );
}
