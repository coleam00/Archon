/**
 * The board's Table view (v1's `BoardTable.tsx`): one row per item the pack's board shows,
 * with the card's own values as columns; a header click sorts. The rows' values come from the
 * same `useCardList` read the cards use. Merges before the Merged column's window are listed
 * only on request, so the first read stays the size of the board. An item with open asks shows
 * the card's one Needs you control in its State cell (`NeedsYouLink.tsx`).
 */
import { useState, type ReactElement, type ReactNode } from 'react';
import { Link } from 'react-router';
import { displayItemKey } from '../lib/item-key';
import { CHIP, chipOf, howItEnded, runPath, runToOpen } from '../routes/board/standing';
import { useCardList } from './FactoryCards';
import { timeToMerged } from './lib/board-numbers';
import {
  shortDateTime,
  sortRows,
  TABLE_COLUMNS,
  type TableColumnId,
  type TableRow,
  type TableSort,
} from './lib/board-table';
import { durationWords } from './lib/duration';
import type { CardProgress } from './lib/item-card';
import { NeedsYouLink } from './NeedsYouLink';
import { orderOf } from './lib/work-orders';

export function BoardTable({
  projectId,
  rows,
  earlier,
  showEarlier = false,
}: {
  projectId: string;
  /** What the board shows: its columns' cards, then the decisions, then the Merged column's. */
  rows: readonly TableRow[];
  /** Merged before the window. */
  earlier: readonly TableRow[];
  /** Open with the earlier merges listed. */
  showEarlier?: boolean;
}): ReactElement {
  const [sort, setSort] = useState<TableSort>({ by: 'column', descending: false });
  const [withEarlier, setWithEarlier] = useState(showEarlier);
  const all = withEarlier ? [...rows, ...earlier] : [...rows];
  const progressOf = useCardList(all.map(row => row.read));
  const sorted = sortRows(all, sort, progressOf);
  const sortBy = (by: TableColumnId): void => {
    setSort(current => ({ by, descending: current.by === by ? !current.descending : false }));
  };
  return (
    <div data-board-table className="mt-3">
      <div className="overflow-x-auto">
        <table className="w-full text-left text-console-13">
          <thead>
            <tr className="border-b border-border text-console-12 uppercase tracking-wider text-text-tertiary">
              {TABLE_COLUMNS.map(column => (
                <th
                  key={column.id}
                  scope="col"
                  aria-sort={
                    sort.by === column.id
                      ? sort.descending
                        ? 'descending'
                        : 'ascending'
                      : undefined
                  }
                  className="px-1.5 py-1.5 align-bottom font-medium"
                >
                  <button
                    type="button"
                    onClick={() => {
                      sortBy(column.id);
                    }}
                    className="text-left uppercase tracking-wider hover:text-text-primary"
                  >
                    {column.label}
                    {sort.by === column.id ? (sort.descending ? ' ↓' : ' ↑') : ''}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map(row => (
              <BoardRow
                key={row.read.item.id}
                projectId={projectId}
                row={row}
                progress={progressOf(row.read)}
              />
            ))}
          </tbody>
        </table>
      </div>
      {earlier.length === 0 || withEarlier ? null : (
        <button
          type="button"
          onClick={() => {
            setWithEarlier(true);
          }}
          className="mt-2 rounded border border-border px-2 py-1 text-console-13 text-text-secondary hover:bg-surface-hover hover:text-text-primary"
        >
          Show {earlier.length} earlier merged
        </button>
      )}
    </div>
  );
}

/** One cell, its content at the top of the row. */
function Cell({
  children,
  className = '',
  name,
}: {
  children?: ReactNode;
  className?: string;
  /** Names the cell for a reader that compares it with the card. */
  name?: string;
}): ReactElement {
  return (
    <td data-cell={name} className={`px-1.5 py-1.5 align-top ${className}`}>
      {children}
    </td>
  );
}

function BoardRow({
  projectId,
  row,
  progress,
}: {
  projectId: string;
  row: TableRow;
  progress: CardProgress;
}): ReactElement {
  const { read } = row;
  const chip = chipOf(read);
  const run = runToOpen(read);
  const order = orderOf(read);
  const toMerge = timeToMerged(read);
  return (
    <tr data-row={read.item.key} className="border-b border-border">
      <Cell>
        {run === undefined ? (
          <span className="whitespace-nowrap font-mono text-console-12 text-text-tertiary">
            {progress.keyText}
          </span>
        ) : (
          <Link
            to={runPath(projectId, run.id)}
            className="whitespace-nowrap font-mono text-console-12 text-accent-bright hover:underline"
          >
            {progress.keyText}
          </Link>
        )}
      </Cell>
      <Cell className="min-w-48 text-text-primary">
        {progress.titleIsKey ? null : progress.title}
      </Cell>
      <Cell className="whitespace-nowrap font-mono text-console-12 text-text-secondary">
        {order === undefined ? null : displayItemKey(order.key)}
      </Cell>
      <Cell className="text-text-secondary">{row.column}</Cell>
      <Cell name="state">
        {progress.asks !== null ? (
          <NeedsYouLink projectId={projectId} itemKey={read.item.key} count={progress.asks.count} />
        ) : (
          <span
            data-row-state={chip}
            className={`whitespace-nowrap rounded-full px-2 py-0.5 text-console-12 font-medium ${CHIP[chip].tone}`}
          >
            {chip === 'done' ? howItEnded(read) : CHIP[chip].label}
          </span>
        )}
      </Cell>
      <Cell name="round" className="whitespace-nowrap text-text-secondary">
        {progress.round?.text}
      </Cell>
      <Cell name="returned" className="whitespace-nowrap text-text-secondary">
        {progress.returned?.text}
      </Cell>
      <Cell className="whitespace-nowrap">
        {progress.pr === null ? null : (
          <a
            href={progress.pr.url}
            target="_blank"
            rel="noreferrer"
            className="text-accent-bright hover:underline"
          >
            {progress.pr.number === null ? 'PR' : `#${String(progress.pr.number)}`}
          </a>
        )}
      </Cell>
      <Cell className="whitespace-nowrap text-text-tertiary">
        {read.merged === null ? null : shortDateTime(read.merged.at)}
      </Cell>
      <Cell name="to-merge" className="whitespace-nowrap text-text-secondary">
        {toMerge === null ? null : durationWords(toMerge)}
      </Cell>
    </tr>
  );
}
