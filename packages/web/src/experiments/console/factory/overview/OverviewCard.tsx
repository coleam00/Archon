import type { ReactElement } from 'react';
import type { Box } from '../lib/map-layout';
import { OVERVIEW_SMALL_TEXT, OVERVIEW_TEXT, OVERVIEW_TITLE_TEXT } from '../lib/overview-layout';
import type { OverviewCard as Card } from '../lib/overview-nav';
import { cardTone } from '../tones';
import { ICONS, KINDS } from './overview-kinds';

/*
 * The Visual standard's card (rule 2), drawn in world px on a canvas that opens at zoom 1 or
 * more, so each size here is at least what a person reads: the title OVERVIEW_TITLE_TEXT, the
 * text OVERVIEW_TEXT, the kind OVERVIEW_SMALL_TEXT (overview-layout.ts).
 */

/**
 * One card: its kind's colour along the top, its icon and kind, its title and line of text. A
 * card that opens a view is a button marked ⤢. It fills its grid cell, where every line into
 * or out of it lands.
 */
export function OverviewCard({
  card,
  box,
  onOpen,
}: {
  card: Card;
  box: Box;
  onOpen: (view: string) => void;
}): ReactElement {
  const kind = KINDS[card.kind];
  const Icon = ICONS[card.icon];
  const body = (
    <>
      <span
        aria-hidden="true"
        className="absolute inset-x-0 top-0 h-0.75"
        style={{ background: kind.color }}
      />
      <span
        className={`flex items-center gap-2 ${OVERVIEW_SMALL_TEXT} font-medium uppercase tracking-console-label text-text-tertiary`}
      >
        <Icon aria-hidden="true" className="size-4 shrink-0" style={{ color: kind.color }} />
        {kind.label}
        {card.opens === undefined ? null : (
          <span aria-hidden="true" className="ml-auto text-text-secondary">
            ⤢
          </span>
        )}
      </span>
      <span
        className={`${OVERVIEW_TITLE_TEXT} line-clamp-2 font-semibold leading-tight text-text-primary`}
      >
        {card.title}
      </span>
      <span className={`${OVERVIEW_TEXT} line-clamp-2 leading-snug text-text-secondary`}>
        {card.text}
      </span>
    </>
  );
  // Fill, depth, border and hover are `.factory-card`'s (factory.css), tinted in the kind's colour.
  const frame =
    'factory-card absolute flex flex-col gap-2 overflow-hidden rounded-console-12 border p-3 text-left';
  const style = {
    ...cardTone(kind.color),
    left: box.x,
    top: box.y,
    width: box.w,
    height: box.h,
  };
  if (card.opens === undefined)
    return (
      <div data-card={card.id} data-static="" className={frame} style={style}>
        {body}
      </div>
    );
  const opens = card.opens;
  return (
    <button
      type="button"
      data-card={card.id}
      aria-label={`${card.title}: open a closer look`}
      onClick={() => onOpen(opens)}
      className={`${frame} cursor-pointer`}
      style={style}
    >
      {body}
    </button>
  );
}
