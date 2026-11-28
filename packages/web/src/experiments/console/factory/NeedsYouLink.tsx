/**
 * The one Needs you control a board card and a Table row carry for an item with open asks:
 * "Needs you · N", a button in the console's accent beside the card's other actions (owner,
 * 11/26), linking to the project's Needs you tab filtered to the item (#217). Answering happens
 * on that tab; the board shows no ask question, recommendation or popover. The link carries the
 * raw item key; the tab matches `?item=` by that key or its issue number (`matchesItemFilter`),
 * and N counts the asks the same way (`openAsksOf`), so the tab lists N asks.
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
      data-needs-you-link={itemKey}
      to={needsYouPath(projectId, itemKey)}
      aria-label={`${text}: open its asks on the Needs you tab`}
      className={`${INNER} inline-flex shrink-0 cursor-pointer items-center whitespace-nowrap rounded-md bg-accent-bright px-2 py-1 text-console-12 font-semibold text-white/95 shadow-sm transition-[filter,box-shadow] hover:brightness-125 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-bright focus-visible:ring-offset-1`}
    >
      {text}
    </Link>
  );
}
