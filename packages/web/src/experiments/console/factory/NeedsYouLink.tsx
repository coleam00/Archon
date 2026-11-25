/**
 * The one Needs you control a board card and a Table row carry for an item with open asks:
 * "Needs you · N", linking to the project's Needs you tab filtered to the item (owner, 11/25,
 * #217). Answering happens on that tab; the board shows no ask question, recommendation or
 * popover. The tab matches `?item=` against the raw item key, so the link carries that key.
 */
import type { ReactElement } from 'react';
import { Link } from 'react-router';
import { CHIP } from '../routes/board/standing';
import { INNER } from './BoardCardProgress';

/** The project's Needs you tab, filtered to one item. */
export function needsYouPath(projectId: string, itemKey: string): string {
  return `/console/p/${encodeURIComponent(projectId)}/needs-you?${new URLSearchParams({ item: itemKey }).toString()}`;
}

export function NeedsYouLink({
  projectId,
  itemKey,
  count,
}: {
  projectId: string;
  itemKey: string;
  /** The item's open asks. */
  count: number;
}): ReactElement {
  const text = `${CHIP.needs_you.label} · ${String(count)}`;
  return (
    <Link
      data-chip="needs_you"
      data-needs-you-link={itemKey}
      to={needsYouPath(projectId, itemKey)}
      aria-label={`${text}: open its asks on the Needs you tab`}
      className={`${INNER} shrink-0 cursor-pointer whitespace-nowrap rounded-full px-2 py-0.5 text-console-12 font-medium ${CHIP.needs_you.tone} transition-[filter] hover:brightness-110 hover:ring-2 hover:ring-warning/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent`}
    >
      {text}
    </Link>
  );
}
