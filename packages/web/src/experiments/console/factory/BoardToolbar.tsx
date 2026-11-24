import type { ReactElement, ReactNode } from 'react';
import { SegmentedControl } from '../components/SegmentedControl';
import { BOARD_SHOW, type BoardShow } from './lib/board-show';

/**
 * The board's one toolbar line: the filter box, the Pipeline/Table switch, the number the
 * board was opened from, then whatever the view adds (`children`). It wraps on a phone.
 */
export function BoardToolbar({
  query,
  onQuery,
  table,
  onView,
  showParam,
  show,
  onClearShow,
  children,
}: {
  query: string;
  onQuery: (query: string) => void;
  table: boolean;
  onView: (view: 'pipeline' | 'table') => void;
  /** `?show=` as written; null when absent. */
  showParam: string | null;
  /** What `?show=` names; undefined when absent or unknown. */
  show: BoardShow | undefined;
  onClearShow: () => void;
  children: ReactNode;
}): ReactElement {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2">
      <input
        type="search"
        value={query}
        onChange={event => {
          onQuery(event.target.value);
        }}
        placeholder="Filter by key, title or order"
        aria-label="Filter by key, title or work order"
        className="w-56 rounded border border-border bg-surface-inset px-2.5 py-1 text-console-13 text-text-primary outline-none placeholder:text-text-tertiary focus:border-border-bright"
      />
      <SegmentedControl
        label="Board view"
        active={table ? 'table' : 'pipeline'}
        segments={[
          { key: 'pipeline', label: 'Pipeline', onSelect: () => onView('pipeline') },
          { key: 'table', label: 'Table', onSelect: () => onView('table') },
        ]}
      />
      <ShowChip param={showParam} show={show} onClear={onClearShow} />
      {children}
    </div>
  );
}

/**
 * The number the board was opened from, with a way back to every item. A `show` no filter
 * has says so rather than quietly showing everything.
 */
function ShowChip({
  param,
  show,
  onClear,
}: {
  param: string | null;
  show: BoardShow | undefined;
  onClear: () => void;
}): ReactElement | null {
  if (param === null) return null;
  return (
    <span
      role={show === undefined ? 'alert' : undefined}
      className={`flex items-center gap-2 rounded border px-2 py-0.5 text-console-12 ${
        show === undefined
          ? 'border-error/40 bg-error/10 text-error'
          : 'border-border bg-surface-elevated text-text-primary'
      }`}
    >
      {show === undefined ? `Unknown filter "${param}"` : `Showing: ${BOARD_SHOW[show].label}`}
      <button
        type="button"
        onClick={onClear}
        className="text-text-tertiary hover:text-text-primary"
        aria-label="Show every item"
      >
        Show all
      </button>
    </span>
  );
}
