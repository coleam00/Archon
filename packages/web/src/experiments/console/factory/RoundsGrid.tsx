import { useState, type ReactElement } from 'react';
import {
  Check,
  CircleDot,
  CircleX,
  Minus,
  MessageCircleQuestion,
  Undo2,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { Panel } from './document';
import {
  MEANING_WORD,
  roundHeading,
  roundLead,
  type CellMeaning,
  type GridCell,
  type GridRow,
  type RoundsGrid as Grid,
} from './lib/item-rounds-grid';
import { firstSentence } from './lib/item-story';
import { ShadowBadge } from './ShadowBadge';

/**
 * Each cell's icon and colour (rule 5's state colours): a send-back in the send-back line's
 * colour (rule 4), a shadow in its own and never a state colour (rule 10). A cell is always an
 * icon and a word, never a colour alone.
 */
const LOOK: Record<CellMeaning, { Icon: LucideIcon; className: string }> = {
  approved: { Icon: Check, className: 'text-success' },
  returned: { Icon: Undo2, className: 'text-[color:var(--node-approval)]' },
  asked: { Icon: MessageCircleQuestion, className: 'text-warning' },
  fixed: { Icon: Wrench, className: 'text-text-secondary' },
  failed: { Icon: CircleX, className: 'text-error' },
  running: { Icon: CircleDot, className: 'text-[color:var(--running)]' },
  token: { Icon: CircleDot, className: 'text-text-secondary' },
  shadow: { Icon: CircleDot, className: 'text-[color:var(--node-opaque)]' },
};

/**
 * The check rounds of one Checks panel as a table (owner change 8): a legend saying what "sent
 * back" and "approved" mean, rows of checks by columns of rounds, and under it why each round
 * that sent the change back did so, in one sentence with the rest behind "More".
 */
export function RoundsGrid({ grid }: { grid: Grid }): ReactElement {
  return (
    <Panel inset className="flex flex-col gap-3 p-3">
      <p className="text-console-13 text-text-secondary">
        {/* The legend names the words the cells use, so the two cannot drift. */}
        <span className="font-medium text-text-primary">{MEANING_WORD.returned}</span>: a check
        found something to fix and returned the change to the builder.{' '}
        <span className="font-medium text-text-primary">{MEANING_WORD.approved}</span>: the check
        passed.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-lg border-collapse text-left">
          <caption className="sr-only">Check rounds</caption>
          <thead>
            <tr>
              <th
                scope="col"
                className="py-1.5 pr-4 text-console-12 font-medium uppercase tracking-console-label text-text-tertiary"
              >
                Check
              </th>
              {grid.columns.map(column => (
                <th
                  key={`${column.runId}|${column.iteration}`}
                  scope="col"
                  className="py-1.5 pr-4 text-console-12 font-medium uppercase tracking-console-label text-text-tertiary"
                >
                  {roundHeading(column)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {grid.rows.map(row => (
              <Row key={row.key} row={row} />
            ))}
          </tbody>
        </table>
      </div>
      <Reasons grid={grid} />
    </Panel>
  );
}

function Row({ row }: { row: GridRow }): ReactElement {
  return (
    <tr data-grid-row={row.label} className="border-t border-border">
      <th
        scope="row"
        className={`py-2 pr-4 text-console-13 font-medium ${row.shadow ? 'text-text-tertiary' : 'text-text-primary'}`}
      >
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="whitespace-nowrap">{row.label}</span>
          {row.shadow ? <ShadowBadge /> : null}
        </span>
      </th>
      {row.cells.map((cells, index) => (
        // A row has one cell list per column, in the columns' order.
        <td key={index} className="py-2 pr-4 align-top">
          {cells.length === 0 ? (
            <Cell cell={{ meaning: 'token', text: 'Not run', title: null }} absent />
          ) : (
            <span className="flex flex-col gap-1">
              {cells.map((cell, at) => (
                <Cell key={at} cell={cell} />
              ))}
            </span>
          )}
        </td>
      ))}
    </tr>
  );
}

function Cell({ cell, absent = false }: { cell: GridCell; absent?: boolean }): ReactElement {
  const { Icon, className } = absent
    ? { Icon: Minus, className: 'text-text-tertiary' }
    : LOOK[cell.meaning];
  return (
    <span
      data-cell={absent ? 'absent' : cell.meaning}
      title={cell.title ?? undefined}
      className={`inline-flex items-start gap-1.5 text-console-13 ${className} ${
        cell.meaning === 'token' && !absent ? 'font-mono' : 'font-medium'
      } ${cell.meaning === 'shadow' ? '' : 'whitespace-nowrap'}`}
    >
      <Icon aria-hidden="true" className="size-4 shrink-0" />
      {cell.text}
    </span>
  );
}

/** Why each round that sent the change back did so: one sentence, the rest behind "More". */
function Reasons({ grid }: { grid: Grid }): ReactElement | null {
  const returned = grid.columns.filter(column => column.reason !== null);
  if (returned.length === 0) return null;
  return (
    <ul aria-label="Why the rounds sent it back" className="flex flex-col gap-2">
      {returned.map(column => (
        <Reason
          key={`${column.runId}|${column.iteration}`}
          lead={roundLead(column)}
          text={column.reason ?? ''}
        />
      ))}
    </ul>
  );
}

/** One reason as a list row: a lead in bold ("Round 2", "Sent back"), its first sentence, More. */
export function Reason({ lead, text }: { lead: string | null; text: string }): ReactElement {
  const [open, setOpen] = useState(false);
  const short = firstSentence(text);
  const more = short !== text.trim();
  return (
    <li className="flex min-w-0 flex-col gap-1 text-console-13 text-text-secondary">
      <p className="break-words">
        {lead === null ? null : <span className="font-medium text-text-primary">{lead}: </span>}
        {open ? text : short}{' '}
        {more ? (
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
            className="rounded text-console-12 font-medium text-text-tertiary hover:text-text-primary"
          >
            {open ? 'Less' : 'More'}
          </button>
        ) : null}
      </p>
    </li>
  );
}
