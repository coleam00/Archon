import type { ReactNode } from 'react';
import type { NotOnMap } from '../lib/map-live';
import { ItemLink } from '../stage/StageItems';

/**
 * Items on a stage no card shows, each with the stage it stands at, so the cards never
 * undercount silently: the board lists them in that stage's column.
 */
export function MapNotOnMap({
  projectId,
  entries,
}: {
  projectId: string;
  entries: readonly NotOnMap[];
}): ReactNode {
  if (entries.length === 0) return null;
  return (
    <section aria-label="Not on the map" className="flex flex-col gap-1">
      <p className="text-console-12 font-medium text-text-secondary">
        {entries.length === 1
          ? '1 item is on a stage the map has no card for'
          : `${entries.length.toString()} items are on stages the map has no card for`}
      </p>
      <ul className="flex flex-col gap-0.5">
        {entries.map(entry => (
          <li key={entry.item.item.id} className="text-console-12 text-text-secondary">
            <ItemLink projectId={projectId} read={entry.item} />{' '}
            {entry.workflow === null ? (
              'stands at a run of no pack stage.'
            ) : (
              <>
                is in <span className="font-mono text-console-12">{entry.workflow}</span>.
              </>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
