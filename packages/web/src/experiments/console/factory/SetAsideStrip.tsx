import type { ReactElement } from 'react';
import { Link } from 'react-router';
import { formatDateTime } from '../lib/format';
import { itemPath } from './lib/board';
import { displayItemKey } from './lib/item-key';
import type { SetAside } from './lib/set-aside';

const HEADING_ID = 'set-aside-heading';

/**
 * The items the board set aside, as one line under the board beside "Found by the factory":
 * "N set aside". The board's one toggle, beside it, opens {@link SetAsideList} below the board.
 * The board draws neither when none is set aside.
 */
export function SetAsideLine({ count }: { count: number }): ReactElement {
  return (
    <section
      aria-labelledby={HEADING_ID}
      className="rounded-console-12 border border-border bg-surface px-4 py-2"
    >
      <h2 id={HEADING_ID} className="text-console-15 font-semibold text-text-primary">
        <span className="tabular-nums">{count}</span> set aside
      </h2>
    </section>
  );
}

/**
 * Each item set aside: its key, title, why it was set aside and when its last run ended. It
 * opens below the board, in the page, so the page scrolls to it and nothing covers the board.
 */
export function SetAsideList({
  projectId,
  entries,
}: {
  projectId: string;
  entries: readonly SetAside[];
}): ReactElement {
  return (
    <section
      aria-labelledby={HEADING_ID}
      className="rounded-console-12 border border-border bg-surface px-4 py-3"
    >
      <ul id="set-aside-list" className="flex flex-col gap-2">
        {entries.map(entry => (
          <SetAsideRow key={entry.placed.card.key} projectId={projectId} entry={entry} />
        ))}
      </ul>
    </section>
  );
}

function SetAsideRow({ projectId, entry }: { projectId: string; entry: SetAside }): ReactElement {
  const { card } = entry.placed;
  return (
    <li className="flex min-w-0 flex-col text-console-13">
      <span className="flex min-w-0 items-baseline gap-2">
        <Link
          to={itemPath(projectId, card.key)}
          className="shrink-0 font-mono text-console-12 text-accent-bright hover:underline"
        >
          {displayItemKey(card.key, card.order)}
        </Link>
        <span title={card.title} className="min-w-0 truncate text-text-primary">
          {card.title}
        </span>
      </span>
      <span className="flex flex-wrap items-baseline gap-x-2">
        <span title={entry.detail ?? undefined} className="text-text-secondary">
          {entry.why}
        </span>
        {entry.since === null ? null : (
          <span className="whitespace-nowrap text-console-12 text-text-tertiary">
            {formatDateTime(entry.since)}
          </span>
        )}
      </span>
    </li>
  );
}
