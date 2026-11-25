/**
 * The board's last column: the pack's items whose change merged in the last `MERGED_DAYS`
 * local days, newest first (v1's Merged column). Earlier merges are not lost: the Table lists
 * them, and the column links there.
 */
import type { ReactElement } from 'react';
import { Link } from 'react-router';
import type { ItemRead } from '../skills/items';
import { CardList } from '../routes/board/ItemCard';
import { ColumnHeader } from './ColumnHeader';
import { MERGED_DAYS } from './lib/board-numbers';
import { boardViewSearch } from './BoardToolbar';
import { TONES } from './tones';

export function MergedColumn({
  projectId,
  recent,
  earlier,
  counted,
  error,
  lit,
}: {
  projectId: string;
  recent: ItemRead[];
  /** How many merged before the window. */
  earlier: number;
  /** Every item is read; until then the column has nothing to count. */
  counted: boolean;
  /** The every-item read failed: what it would count is unknown. */
  error?: Error;
  lit: ReadonlySet<string> | null;
}): ReactElement {
  return (
    <div data-merged className="flex flex-col md:min-h-0 md:w-0 md:min-w-44 md:flex-1">
      <ColumnHeader
        label="Merged"
        subtitle={`last ${String(MERGED_DAYS)} days`}
        items={recent}
        count={counted ? recent.length : error === undefined ? null : 'unknown'}
        bar="var(--success)"
        chips={false}
      />
      {counted ? null : error === undefined ? (
        <div className="mt-3 h-24 rounded-console-12 bg-surface-elevated motion-safe:animate-pulse" />
      ) : (
        <p role="alert" className="mt-3 text-console-13 text-error">
          The merged items could not be read: {error.message}
        </p>
      )}
      {recent.length === 0 ? null : (
        <CardList
          reads={recent}
          projectId={projectId}
          lit={lit}
          accent={TONES.merged.color}
          className="mt-3 flex flex-col gap-3 md:min-h-0 md:flex-1 md:overflow-y-auto md:pb-2 md:pr-1"
        />
      )}
      {earlier === 0 ? null : (
        <Link
          data-merged-earlier
          to={{ search: boardViewSearch('table', { earlier: true }) }}
          className="mt-2 inline-block text-console-13 text-accent motion-safe:transition-colors motion-safe:duration-150 motion-safe:ease-out hover:text-text-primary"
        >
          {earlier} earlier: see Table
        </Link>
      )}
    </div>
  );
}
