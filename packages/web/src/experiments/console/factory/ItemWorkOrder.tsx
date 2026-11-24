import { useMemo, type ReactElement } from 'react';
import { displayItemKey } from './lib/item-key';
import { Link } from 'react-router';
import { HttpError } from '../lib/http';
import { PillBadge } from './BoardCard';
import { boardModel, itemPath, type FactoryDeclaration } from './lib/board';
import { workOrders, type WorkOrder } from './lib/work-orders';
import { useFactoryItemsRead } from './useFactoryItems';
import { useMinuteClock } from './useMinuteClock';
import { useReadRetry, type ReadRetry } from './useReadRetry';

/**
 * The project's work orders, from the items read every Factory page shares (no request of its
 * own): `orders` is undefined until that read lands, with `failed` and its Retry once it failed
 * (`useReadRetry`; called with the item page, so an error held then is an earlier visit's).
 * `own` is the open item's key and the keys its own read links to it as `part_of`: the items
 * read asks only about orders an item on the board names, so an order whose members have not
 * started is known from its own read.
 */
export function useWorkOrders(
  view: FactoryDeclaration,
  projectId: string,
  own?: { key: string; members: readonly string[] }
): { orders: WorkOrder[] | undefined } & ReadRetry {
  const read = useFactoryItemsRead(projectId);
  const { data } = read;
  const retry = useReadRetry(read);
  // A member set aside is named by why; the board's clock decides which are.
  const now = useMinuteClock();
  const ownKey = own?.key;
  // A string, so a new array of the same keys on each render does not re-derive.
  const ownMembers = own === undefined ? undefined : JSON.stringify(own.members);
  const orders = useMemo(() => {
    if (data === undefined) return undefined;
    const members =
      ownKey === undefined || ownMembers === undefined || ownKey in data.members
        ? data.members
        : { ...data.members, [ownKey]: JSON.parse(ownMembers) as string[] };
    return workOrders(data.items, boardModel(view, projectId, data.items, new Map(), now), members);
  }, [view, projectId, data, ownKey, ownMembers, now]);
  return { orders, ...retry };
}

/**
 * The item read answered that the project has no item under the key. The route also answers 404
 * for an unknown project or one no view applies to, but the item page renders inside
 * `FactoryFrame` only once the project's view has loaded, so there a 404 is the item's. Read by
 * status, never by the server's message text.
 */
export function isNoSuchItem(error: Error | undefined): boolean {
  return error instanceof HttpError && error.status === 404;
}

/** Said where an order with no run of its own would show a column: it is in none. */
export const WORK_ORDER_WORDS = 'Work order, not worked by the factory itself';

/**
 * The page of a work order the project has no item row for: only a member's order run named
 * it. Its key, and its members.
 */
export function WorkOrderOnly({
  projectId,
  order,
}: {
  projectId: string;
  order: WorkOrder;
}): ReactElement {
  return (
    <>
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="font-mono text-console-13 text-text-tertiary">
            {displayItemKey(order.key, null)}
          </span>
          <h3 className="min-w-0 break-words text-console-17 font-semibold text-text-primary">
            {order.title}
          </h3>
        </div>
        <p className="text-console-13 text-text-secondary">{WORK_ORDER_WORDS}</p>
      </header>
      <OrderMembers projectId={projectId} order={order} />
    </>
  );
}

/** An order's members, how many merged, and where each stands. */
export function OrderMembers({
  projectId,
  order,
}: {
  projectId: string;
  order: WorkOrder;
}): ReactElement {
  return (
    <div
      className="flex flex-col gap-1.5"
      aria-label={`Members of ${displayItemKey(order.key, null)}`}
    >
      <p className="text-console-14 text-text-secondary">
        Members: {order.landed} of {order.members.length} merged
      </p>
      <ul className="flex flex-col gap-1">
        {order.members.map(member => (
          <li
            key={member.key}
            className="flex flex-wrap items-center gap-x-2 gap-y-1 text-console-14"
          >
            <Link
              to={itemPath(projectId, member.key)}
              className="font-mono text-console-12 text-accent-bright hover:underline"
            >
              {displayItemKey(member.key, order.key)}
            </Link>
            {member.title === displayItemKey(member.key, order.key) ? null : (
              <span className="min-w-0 truncate text-text-primary">{member.title}</span>
            )}
            <PillBadge pill={member.pill} label={member.pillLabel} />
            <span className="text-console-13 text-text-tertiary">{member.where}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
