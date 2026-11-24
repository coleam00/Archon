import { useEffect, useRef, useState, type ReactElement, type RefObject } from 'react';
import { BoardColumn } from './BoardColumn';
import { hiddenColumnsHint, type BoardModel } from './lib/board';
import { mergedWindow } from './lib/merged-window';
import type { BoardAsks } from './useBoardAsks';

/**
 * The columns whose header shows inside the scroller. Every column counts as shown until
 * the observer reports, and where there is none (a server render), so no hint flashes.
 */
function useShownColumns(
  scroller: RefObject<HTMLDivElement | null>,
  columns: readonly string[]
): ReadonlySet<string> {
  const [shown, setShown] = useState<ReadonlySet<string>>(() => new Set(columns));
  const key = columns.join('\n');
  useEffect(() => {
    const root = scroller.current;
    if (root === null || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      entries => {
        setShown(current => {
          const next = new Set(current);
          for (const entry of entries) {
            const column = (entry.target as HTMLElement).dataset.column ?? '';
            if (entry.isIntersecting) next.add(column);
            else next.delete(column);
          }
          return next;
        });
      },
      { root, threshold: 0.9 }
    );
    for (const header of root.querySelectorAll('[data-column]')) observer.observe(header);
    return (): void => {
      observer.disconnect();
    };
  }, [scroller, key]);
  return shown;
}

/**
 * Pipeline view: one column per declared column, left to right (top to bottom on a phone).
 * From md up the row takes the height it is given and each column scrolls on its own; the
 * Merged column lists the recent window (`mergedWindow`). Which columns the row hides is
 * reported through `onHint`, for the board's toolbar to say, and cleared when it unmounts.
 */
export function BoardPipeline({
  projectId,
  model,
  moved,
  lit = null,
  now,
  filtered = false,
  asks,
  onHint,
}: {
  projectId: string;
  model: BoardModel;
  moved: ReadonlySet<string>;
  /** The keys of the work order `?order=` lights; every other card dims. Null when none. */
  lit?: ReadonlySet<string> | null;
  /** The time the Merged column's window counts back from. */
  now: Date;
  /** The filter box or `?show=` narrows the cards this model holds. */
  filtered?: boolean;
  asks: BoardAsks;
  /** "Scroll for: Merged" while a column is out of view, else null. */
  onHint: (hint: string | null) => void;
}): ReactElement {
  const scroller = useRef<HTMLDivElement>(null);
  const shown = useShownColumns(
    scroller,
    model.columns.map(column => column.id)
  );
  const hint = hiddenColumnsHint(model.columns, shown);
  // Cleared on unmount (the Table, a reload), so the toolbar never names a stale column.
  useEffect(() => {
    onHint(hint);
    return (): void => {
      onHint(null);
    };
  }, [hint, onHint]);
  return (
    // The minimum sits on this box, not the row inside it: what the board draws under it (the
    // strips under the board) then follows the columns and the frame scrolls, rather than the
    // row overflowing a shrunken box and the strips drawing over the cards. The 0 basis keeps
    // the cards out of the board area's height, so this minimum is what a short window keeps.
    <div className="flex flex-col md:min-h-80 md:flex-1 md:basis-0">
      {/* A phone stacks the columns, each at full width; from md they sit side by side and
          the row scrolls sideways when they do not fit. */}
      <div
        ref={scroller}
        className="flex flex-col gap-6 md:min-h-0 md:flex-1 md:flex-row md:gap-3 md:overflow-x-auto"
      >
        {model.columns.map(column => (
          <BoardColumn
            key={column.id}
            projectId={projectId}
            column={column}
            merged={column.id === model.landedColumn ? mergedWindow(column.cards, now) : undefined}
            filtered={filtered}
            moved={moved}
            lit={lit}
            asks={asks}
          />
        ))}
      </div>
    </div>
  );
}
