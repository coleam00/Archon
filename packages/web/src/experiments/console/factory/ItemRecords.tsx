import type { ReactElement } from 'react';
import { displayItemKey } from './lib/item-key';
import type { ItemName } from '../lib/ask-naming';
import { Link2, Scale } from 'lucide-react';
import { Link } from 'react-router';
import { EmptyNote } from '../components/EmptyNote';
import { formatDateTime } from '../lib/format';
import type { FactoryItem } from '../skills/factory';
import { describeAnswer, linkWords } from './lib/item-answers';
import { runHref } from './lib/timeline';
import { factoryPath } from './lib/views';
import { Panel, SectionHeading } from './document';
import { OrderMembers } from './ItemWorkOrder';
import type { Membership, WorkOrder } from './lib/work-orders';

/**
 * The work order a linked item is in. An active incoming `part_of` link says so itself (this
 * item is its order), which holds before the items read lands; any other link's item is read
 * from the project's items.
 */
function linkedOrder(
  link: FactoryItem['links'][number],
  itemKey: string,
  names: ReadonlyMap<string, ItemName>
): string | null {
  if (link.kind === 'part_of' && link.direction === 'incoming' && link.ended === null)
    return itemKey;
  return names.get(link.other.key)?.partOf ?? null;
}

/**
 * The item's links to other items, from this item's side, each to that item's page. On a
 * work order, its members with their state stand for its active incoming `part_of` links; on
 * a member its order run placed without a link, a line names that order.
 */
export function ItemLinks({
  projectId,
  itemKey,
  names,
  links: all,
  membership = null,
  order,
}: {
  projectId: string;
  /** This item's key: the order an active incoming `part_of` link's other item is a member of. */
  itemKey: string;
  /** The project's items by key, so a linked split member reads under its order. */
  names: ReadonlyMap<string, ItemName>;
  links: FactoryItem['links'];
  membership?: Membership | null;
  order?: WorkOrder;
}): ReactElement {
  // A member's link is shown as the member; a link from an item whose newer link names
  // another order stays a plain link.
  const members = new Set(order?.members.map(member => member.key));
  const links = all.filter(
    link =>
      !(
        link.kind === 'part_of' &&
        link.direction === 'incoming' &&
        link.ended === null &&
        members.has(link.other.key)
      )
  );
  const named = membership?.source === 'output' ? membership.order : null;
  return (
    <Panel as="section" aria-labelledby="item-links" className="flex flex-col gap-3 p-4">
      <SectionHeading
        id="item-links"
        icon={Link2}
        eyebrow="Links"
        title="Other items"
        tone="var(--text-tertiary)"
      />
      {order === undefined ? null : <OrderMembers projectId={projectId} order={order} />}
      {named === null ? null : (
        <p className="flex flex-wrap items-baseline gap-x-2 text-console-14">
          <span className="text-text-secondary">Part of</span>
          <Link
            to={factoryPath(projectId, `/items/${encodeURIComponent(named)}`)}
            className="font-mono text-console-12 text-accent-bright hover:underline"
          >
            {displayItemKey(named, null)}
          </Link>
          <span className="text-console-13 text-text-tertiary">as its order run recorded</span>
        </p>
      )}
      {links.length === 0 ? (
        order !== undefined || named !== null ? null : (
          <EmptyNote icon={Link2} sentence="No links to other items." />
        )
      ) : (
        <ul className="flex flex-col gap-1">
          {links.map(link => (
            <li key={link.id} className="flex flex-wrap items-baseline gap-x-2 text-console-14">
              <span
                className={
                  link.ended === null ? 'text-text-secondary' : 'text-text-tertiary line-through'
                }
              >
                {linkWords(link)}
              </span>
              <Link
                to={factoryPath(projectId, `/items/${encodeURIComponent(link.other.key)}`)}
                className="font-mono text-console-12 text-accent-bright hover:underline"
              >
                {displayItemKey(link.other.key, linkedOrder(link, itemKey, names))}
              </Link>
              {link.ended === null ? null : (
                <span className="text-console-13 text-text-tertiary">ended</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/** Rulings and answers given on the item, oldest first, as the item read orders them. */
export function ItemAnswers({
  projectId,
  answers,
}: {
  projectId: string;
  answers: FactoryItem['answers'];
}): ReactElement {
  return (
    <Panel as="section" aria-labelledby="item-answers" className="flex flex-col gap-3 p-4">
      <SectionHeading
        id="item-answers"
        icon={Scale}
        eyebrow="On the record"
        title="Rulings and answers"
        tone="var(--text-tertiary)"
      />
      {answers.length === 0 ? (
        <EmptyNote icon={Scale} sentence="Nothing has been ruled or answered yet." />
      ) : (
        <ol className="flex flex-col gap-2">
          {answers.map((entry, index) => {
            const line = describeAnswer(entry);
            return (
              // Answers carry no shared id; their order is the read's and stable.
              <li key={index} className="flex min-w-0 flex-col gap-0.5">
                <div className="flex flex-wrap items-baseline gap-x-2 text-console-13 text-text-tertiary">
                  <span className="font-medium text-text-secondary">{line.label}</span>
                  <span>{formatDateTime(line.at)}</span>
                  {line.runId === null ? null : (
                    <Link to={runHref(projectId, line.runId)} className="hover:underline">
                      the run
                    </Link>
                  )}
                </div>
                <p
                  className={`break-words text-console-14 ${line.withdrawn ? 'text-text-tertiary line-through' : 'text-text-primary'}`}
                >
                  {line.text}
                </p>
                {line.details.map(detail => (
                  <p key={detail} className="break-words text-console-13 text-text-secondary">
                    {detail}
                  </p>
                ))}
              </li>
            );
          })}
        </ol>
      )}
    </Panel>
  );
}
