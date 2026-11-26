/**
 * The work orders, as a section of the board above its columns (ported from v1's
 * `WorkOrdersStrip.tsx`, `origin/main`): a header ("2 work orders · 1 open") that folds the
 * list, open by default and capped at about three rows, then one row per order with its key
 * and title, how many of its members merged, Resolved once the order's own read stands done,
 * each member's state as a dot, and a button that lights its members on the board. There is no
 * item page, so a row opens nothing itself.
 */
import { useId, useState, type ReactElement } from 'react';
import { ChevronDown } from 'lucide-react';
import { displayItemKey } from '../lib/item-key';
import { CHIP, type Chip } from '../routes/board/standing';
import { useFactoryCards } from './cards-context';
import { askedOf, shownChip } from './lib/item-asks';
import { useForgeTitles } from './FactoryCards';
import { itemTitle } from './lib/item-card';
import { orderSummary, type WorkOrder } from './lib/work-orders';

/** A member's state as a dot, in its chip's colour. */
const CHIP_DOT: Record<Chip, string> = {
  needs_you: 'bg-warning',
  running: 'bg-[color:var(--running)]',
  waiting: 'bg-text-tertiary/60',
  queued: 'bg-text-tertiary/60',
  failed: 'bg-error',
  stopped: 'bg-error',
  done: 'bg-success',
  resting: 'bg-text-secondary',
};

export function WorkOrdersStrip({
  orders,
  counted,
  error,
  lit,
  onLight,
}: {
  /** The project's work orders, from every item; empty until that read answers. */
  orders: readonly WorkOrder[];
  /** Every item is read. Until then no total is known, so the strip shows a skeleton. */
  counted: boolean;
  error: Error | undefined;
  /** The id of the order whose members are lit; null when none. */
  lit: string | null;
  onLight: (order: string | null) => void;
}): ReactElement | null {
  const [open, setOpen] = useState(true);
  const list = useId();
  // What a pack's view calls a work order; the orders are the project's, so the first view
  // that words them does.
  const cards = useFactoryCards();
  const words = [...(cards?.packs?.values() ?? [])].find(
    pack => pack.view?.words?.workOrder !== undefined
  )?.view?.words;
  // An order's title is its issue's when its own title column is empty, as on a card.
  const titles = useForgeTitles(
    cards?.projectId ?? null,
    orders.flatMap(order => order.read ?? [])
  );
  if (error !== undefined && !counted)
    return (
      <p role="alert" className="mb-6 text-console-13 text-error">
        The work orders could not be read: {error.message}
      </p>
    );
  // Rule 6: while the items are read, the strip's shape and no total that may be wrong.
  if (!counted)
    return (
      <div data-work-orders-loading title="Reading" className="mb-6 flex flex-col gap-2">
        <span className="h-5 w-48 rounded bg-surface-elevated motion-safe:animate-pulse" />
        <span className="h-9 rounded-console-12 bg-surface-elevated motion-safe:animate-pulse" />
        <span className="sr-only">Reading the work orders</span>
      </div>
    );
  if (orders.length === 0) return null;
  const pending = orders.filter(order => !orderSummary(order).resolved).length;
  const noun =
    orders.length === 1 ? (words?.workOrder ?? 'work order') : (words?.workOrders ?? 'work orders');
  return (
    <section data-work-orders aria-label="Work orders" className="mb-6 flex flex-col gap-2">
      {error === undefined ? null : (
        <p role="alert" className="text-console-13 text-error">
          The work orders could not be read again: {error.message}
        </p>
      )}
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={list}
          onClick={() => {
            setOpen(was => !was);
          }}
          className="-ml-2 flex items-center gap-2 whitespace-nowrap rounded px-2 py-1 text-console-14 font-semibold text-text-primary motion-safe:transition-colors motion-safe:duration-150 motion-safe:ease-out hover:bg-surface-hover"
        >
          {`${String(orders.length)} ${noun} · ${String(pending)} open`}
          <ChevronDown
            aria-hidden="true"
            className={`h-4 w-4 text-text-secondary motion-safe:transition-transform motion-safe:duration-150 ${open ? 'rotate-180' : ''}`}
          />
        </button>
      </div>
      {open ? (
        // Capped at about three rows so a long list never takes the columns' height; taller on
        // a phone, where rows wrap.
        <ul id={list} className="flex max-h-60 flex-col gap-1.5 overflow-y-auto md:max-h-32">
          {orders.map(order => (
            <WorkOrderRow
              key={order.item.id}
              order={order}
              title={orderTitle(order, titles)}
              lit={lit === order.item.id}
              onLight={onLight}
            />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/** The order's title: its own, else its issue's; null when neither is known. */
function orderTitle(order: WorkOrder, titles: Parameters<typeof itemTitle>[1]): string | null {
  if (order.read === undefined) return order.item.title ?? null;
  const read = itemTitle(order.read, titles);
  return read.titleIsKey ? null : read.title;
}

function WorkOrderRow({
  order,
  title,
  lit,
  onLight,
}: {
  order: WorkOrder;
  title: string | null;
  lit: boolean;
  onLight: (order: string | null) => void;
}): ReactElement {
  const summary = orderSummary(order);
  const mergedWords = `${String(summary.merged)} of ${String(summary.total)} merged`;
  // A member with no run has no card to light.
  const lightable = order.members.some(member => member.read !== undefined);
  // A member with open asks says so by its card's rule; the strip sits in the board's provider.
  const asks = useFactoryCards()?.itemAsks ?? null;
  return (
    <li
      data-work-order={order.item.key}
      data-resolved={summary.resolved ? '' : undefined}
      className={`flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 rounded border bg-surface-elevated px-2.5 py-1.5 text-console-13 md:flex-nowrap ${
        // Important (!): theme.css's unlayered `.console-root *` border colour outranks every
        // border utility.
        lit ? 'border-accent-bright!' : 'border-border'
      }`}
    >
      <span className="flex min-w-0 max-w-full items-baseline gap-2">
        <span data-work-order-key className="font-mono text-console-13 text-accent-bright">
          {displayItemKey(order.item.key)}
        </span>
        <span className="min-w-0 truncate text-console-14 font-medium text-text-primary">
          {title ?? 'Work order'}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-2 whitespace-nowrap text-text-secondary">
        <span data-work-order-line>{mergedWords}</span>
        <span
          role="img"
          aria-label={mergedWords}
          className="relative h-1.5 w-16 overflow-hidden rounded-full bg-surface-hover"
        >
          <span
            className="absolute inset-y-0 left-0 rounded-full bg-success"
            style={{
              width: `${summary.total === 0 ? 0 : (summary.merged / summary.total) * 100}%`,
            }}
          />
        </span>
        {summary.unstarted > 0 ? (
          <span data-work-order-unstarted>{`${String(summary.unstarted)} not started`}</span>
        ) : null}
      </span>
      {summary.resolved ? (
        <span
          data-work-order-resolved
          className={`shrink-0 rounded-full px-2 py-0.5 text-console-12 font-medium ${CHIP.done.tone}`}
        >
          Resolved
        </span>
      ) : null}
      <span className="flex flex-wrap items-center gap-1 md:shrink-0">
        {order.members.map(member => {
          const chip: Chip | undefined =
            member.read === undefined
              ? undefined
              : shownChip(member.read, askedOf(asks, member.read) === true);
          const state = chip === undefined ? 'not started' : CHIP[chip].label;
          const label = `${displayItemKey(member.item.key, order.item.key)}: ${state}`;
          return (
            <span
              key={member.item.id}
              role="img"
              aria-label={label}
              title={label}
              className={`inline-block h-2 w-2 rounded-full ${chip === undefined ? 'ring-1 ring-inset ring-text-tertiary' : CHIP_DOT[chip]}`}
            />
          );
        })}
      </span>
      <button
        type="button"
        aria-pressed={lit}
        disabled={!lightable}
        onClick={() => {
          onLight(lit ? null : order.item.id);
        }}
        className="ml-auto shrink-0 whitespace-nowrap rounded px-2 py-0.5 text-console-13 font-medium text-text-secondary motion-safe:transition-colors motion-safe:duration-150 motion-safe:ease-out hover:bg-surface-hover hover:text-text-primary disabled:opacity-50 disabled:hover:bg-transparent"
      >
        {lit ? 'Clear highlight' : 'Highlight members'}
      </button>
    </li>
  );
}
