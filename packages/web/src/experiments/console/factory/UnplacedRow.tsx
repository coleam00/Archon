import type { ReactElement } from 'react';
import { displayItemKey } from './lib/item-key';
import { Link } from 'react-router';
import { itemPath, type PlacedCard } from './lib/board';
import { UNPLACED_LABEL } from './lib/placement';

/**
 * "N position unknown" in the board's toolbar: the items placement found no column for,
 * folded, opening as a list over the board, each item linking to its page. Over the board
 * rather than in the row, so opening it does not take the columns' height.
 */
export function UnplacedRow({
  projectId,
  cards,
}: {
  projectId: string;
  cards: readonly PlacedCard[];
}): ReactElement | null {
  if (cards.length === 0) return null;
  return (
    <details className="relative text-console-12">
      <summary className="cursor-pointer whitespace-nowrap rounded border border-border bg-surface px-2.5 py-1 text-text-secondary hover:text-text-primary">
        {cards.length} {UNPLACED_LABEL.toLowerCase()}
      </summary>
      <ul className="absolute left-0 top-full z-10 mt-1 flex max-h-60 w-72 md:left-auto md:right-0 flex-col gap-1 overflow-y-auto rounded-console-12 border border-border bg-surface-elevated px-3 py-2 shadow-lg">
        {cards.map(({ card }) => (
          <li key={card.key} className="flex min-w-0 gap-2">
            <Link
              to={itemPath(projectId, card.key)}
              className="font-mono text-console-12 text-accent-bright hover:underline"
            >
              {displayItemKey(card.key, card.order)}
            </Link>
            <span className="min-w-0 truncate text-text-secondary">{card.title}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}
