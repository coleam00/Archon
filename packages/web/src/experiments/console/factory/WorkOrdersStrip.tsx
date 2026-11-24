import { useId, useState, type ReactElement } from 'react';
import { displayItemKey } from './lib/item-key';
import { ChevronDown } from 'lucide-react';
import { Link, useSearchParams } from 'react-router';
import { statusDotClass } from '../lib/run-status';
import { itemPath, PILL_LABEL, type Pill } from './lib/board';
import { NOT_STARTED, orderSearch, type WorkOrder } from './lib/work-orders';

/** A member's state as a dot, in the colour its pill has. */
const PILL_DOT_CLASS: Record<Pill, string> = {
  running: statusDotClass.running,
  'needs-you': 'bg-warning',
  failed: 'bg-error',
  awaits: 'bg-warning',
  parked: 'bg-text-secondary',
  waiting: 'bg-text-tertiary/60',
  landed: 'bg-success',
};

/**
 * The work orders with a member on the board, as a section of the board above the Pipeline's
 * columns at the board's text size: a header ("2 work orders · 1 open") that folds the list,
 * open by default and capped at about three rows, then one row per order with its key and
 * title, how many of its members merged and each member's state. The row opens the order's
 * page; its Highlight members button lights the members on the board and never navigates. A
 * lit order is named in the header with a way to clear it, so a card's "part of" link lights
 * something visible even with the list folded. Nothing when no order has a started member.
 */
export function WorkOrdersStrip({
  projectId,
  orders,
  lit,
}: {
  projectId: string;
  orders: readonly WorkOrder[];
  /** The order `?order=` lights; null when none. */
  lit: string | null;
}): ReactElement | null {
  const [open, setOpen] = useState(true);
  const list = useId();
  // An order whose members have no run yet has nothing on the board to light; its page has it.
  const shown = orders.filter(order => order.members.some(member => member.where !== NOT_STARTED));
  if (shown.length === 0) return null;
  const pending = shown.filter(order => order.landed < order.members.length).length;
  const count = `${shown.length.toString()} work order${shown.length === 1 ? '' : 's'}`;
  // Named only when `?order=` lights cards (`highlightedKeys` finds the order), so an old or
  // mistyped key never claims a highlight the board does not show.
  const lighting = orders.some(order => order.key === lit) ? lit : null;
  return (
    <section aria-label="Work orders section" className="flex shrink-0 flex-col gap-2">
      <WorkOrdersHeader
        summary={`${count} · ${pending.toString()} open`}
        open={open}
        list={list}
        onToggle={() => {
          setOpen(was => !was);
        }}
        lighting={lighting}
      />
      {open ? (
        // Capped at about three rows so a long list never takes the columns' height; taller on a
        // phone, where rows wrap and the columns stack in a page that scrolls.
        <ul
          id={list}
          aria-label="Work orders"
          className="flex max-h-60 flex-col gap-1.5 overflow-y-auto md:max-h-32"
        >
          {shown.map(order => (
            <WorkOrderRow
              key={order.key}
              projectId={projectId}
              order={order}
              lit={order.key === lit}
            />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function WorkOrdersHeader({
  summary,
  open,
  list,
  onToggle,
  lighting,
}: {
  summary: string;
  open: boolean;
  list: string;
  onToggle: () => void;
  lighting: string | null;
}): ReactElement {
  const [, setParams] = useSearchParams();
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={list}
        onClick={onToggle}
        className="-ml-2 flex items-center gap-2 whitespace-nowrap rounded px-2 py-1 text-console-14 font-semibold text-text-primary motion-safe:transition-colors motion-safe:duration-150 motion-safe:ease-out hover:bg-surface-hover"
      >
        {summary}
        <ChevronDown
          aria-hidden="true"
          className={`h-4 w-4 text-text-secondary motion-safe:transition-transform motion-safe:duration-150 ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {lighting === null ? null : (
        <span className="flex min-w-0 items-center gap-2 text-console-13">
          <span className="min-w-0 truncate text-text-primary">
            highlighting {displayItemKey(lighting, null)}
          </span>
          <button
            type="button"
            onClick={() => {
              setParams(current => new URLSearchParams(orderSearch(current, null)), {
                replace: true,
              });
            }}
            className="whitespace-nowrap rounded px-2 py-0.5 font-medium text-text-secondary motion-safe:transition-colors motion-safe:duration-150 motion-safe:ease-out hover:bg-surface-hover hover:text-text-primary"
          >
            Clear highlight
          </button>
        </span>
      )}
    </div>
  );
}

function WorkOrderRow({
  projectId,
  order,
  lit,
}: {
  projectId: string;
  order: WorkOrder;
  lit: boolean;
}): ReactElement {
  const [, setParams] = useSearchParams();
  const total = order.members.length;
  const landedWords = `${order.landed.toString()} of ${total.toString()} merged`;
  return (
    // The row is one link to the order's page (its ::after covers the row, as a board card's
    // title does); the member dots and Highlight members sit above it so they never navigate.
    <li
      data-order={order.key}
      className={`relative flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 rounded border bg-surface-elevated px-2.5 py-1.5 text-console-13 md:flex-nowrap motion-safe:transition-colors motion-safe:duration-150 motion-safe:ease-out hover:bg-surface-hover ${
        // Important (!): theme.css's unlayered `.console-root *` border colour outranks every
        // border utility. A lit row keeps its accent border on hover.
        lit ? 'border-accent-bright!' : 'hover:border-border-bright!'
      }`}
    >
      <Link
        to={itemPath(projectId, order.key)}
        className="flex min-w-0 max-w-full items-baseline gap-2 after:absolute after:inset-0 after:rounded hover:underline"
      >
        <span className="font-mono text-console-13 text-accent-bright">
          {displayItemKey(order.key, null)}
        </span>
        <span className="min-w-0 truncate text-console-14 font-medium text-text-primary">
          {order.title}
        </span>
      </Link>
      <span className="flex shrink-0 items-center gap-2 whitespace-nowrap text-text-secondary">
        {landedWords}
        <span
          role="img"
          aria-label={landedWords}
          className="relative h-1.5 w-16 overflow-hidden rounded-full bg-surface-hover"
        >
          <span
            className="absolute inset-y-0 left-0 rounded-full bg-success"
            style={{ width: `${total === 0 ? 0 : (order.landed / total) * 100}%` }}
          />
        </span>
      </span>
      <span className="relative z-10 flex flex-wrap items-center gap-1 md:shrink-0">
        {order.members.map(member => {
          const label = `${displayItemKey(member.key, order.key)}: ${member.pillLabel ?? PILL_LABEL[member.pill]}`;
          return (
            <span
              key={member.key}
              role="img"
              aria-label={label}
              title={label}
              className={`inline-block h-2 w-2 rounded-full ${PILL_DOT_CLASS[member.pill]}`}
            />
          );
        })}
      </span>
      <button
        type="button"
        aria-pressed={lit}
        onClick={() => {
          setParams(current => new URLSearchParams(orderSearch(current, lit ? null : order.key)), {
            replace: true,
          });
        }}
        className="relative z-10 ml-auto shrink-0 whitespace-nowrap rounded px-2 py-0.5 text-console-13 font-medium text-text-secondary motion-safe:transition-colors motion-safe:duration-150 motion-safe:ease-out hover:bg-surface-hover hover:text-text-primary"
      >
        {lit ? 'Clear highlight' : 'Highlight members'}
      </button>
    </li>
  );
}
