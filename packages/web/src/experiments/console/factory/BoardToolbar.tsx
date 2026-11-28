/**
 * The board's one toolbar line (v1's `BoardToolbar.tsx`): the filter box and the
 * Pipeline | Table switch. The view lives in the URL (`?view=table`), so a reload keeps it;
 * `?earlier=1` opens the Table with its earlier merges listed.
 */
import type { ReactElement } from 'react';
import { useSearchParams } from 'react-router';
import { SegmentedControl } from './ui/SegmentedControl';

const VIEW_PARAM = 'view';
const EARLIER_PARAM = 'earlier';

export type BoardView = 'pipeline' | 'table';

/** The search string that opens the board at `view`. */
export function boardViewSearch(view: BoardView, options: { earlier?: boolean } = {}): string {
  const next = new URLSearchParams();
  if (view === 'table') next.set(VIEW_PARAM, 'table');
  if (options.earlier === true) next.set(EARLIER_PARAM, '1');
  const text = next.toString();
  return text === '' ? '' : `?${text}`;
}

/** The view the URL names, whether it asks for earlier merges, and a way to switch. */
export function useBoardView(): {
  view: BoardView;
  earlier: boolean;
  setView: (view: BoardView) => void;
} {
  const [params, setParams] = useSearchParams();
  return {
    view: params.get(VIEW_PARAM) === 'table' ? 'table' : 'pipeline',
    earlier: params.get(EARLIER_PARAM) === '1',
    setView: view => {
      setParams(
        current => {
          const next = new URLSearchParams(current);
          next.delete(EARLIER_PARAM);
          if (view === 'table') next.set(VIEW_PARAM, 'table');
          else next.delete(VIEW_PARAM);
          return next;
        },
        { replace: true }
      );
    },
  };
}

export function BoardToolbar({
  filter,
  onFilter,
  view,
  onView,
}: {
  filter: string;
  onFilter: (filter: string) => void;
  view: BoardView;
  onView: (view: BoardView) => void;
}): ReactElement {
  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2">
      <input
        type="search"
        value={filter}
        onChange={event => {
          onFilter(event.target.value);
        }}
        aria-label="Filter items"
        placeholder="Filter by key or title"
        className="w-full rounded border border-border bg-surface px-3 py-1.5 text-console-12 text-text-primary md:w-80"
      />
      <SegmentedControl
        label="Board view"
        active={view}
        segments={[
          {
            key: 'pipeline',
            label: 'Pipeline',
            onSelect: () => {
              onView('pipeline');
            },
          },
          {
            key: 'table',
            label: 'Table',
            onSelect: () => {
              onView('table');
            },
          },
        ]}
      />
    </div>
  );
}
