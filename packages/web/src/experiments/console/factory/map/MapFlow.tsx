import type { ReactElement } from 'react';
import type { ArrowPath, PlacedCard } from '../lib/map-layout';

/**
 * The map's flow: while a run works an item on a card, a dot travels along the hand-off into
 * that card, over and over, 10 px with a soft halo in the running colour (`.map-flow-dot` in
 * theme.css; hidden under reduced motion). Its
 * arrival is held by the running chip's pulsing dot on the card (rule 7). A card no hand-off
 * runs into (the first) has no dot. A CSS loop per card, so the map never re-renders for it.
 */
export function MapFlow({
  cards,
  arrows,
  working,
}: {
  cards: readonly PlacedCard[];
  arrows: readonly ArrowPath[];
  /** Whether a run works an item on this card now. */
  working: (card: PlacedCard) => boolean;
}): ReactElement {
  return (
    <>
      {cards.map(card => {
        const into = arrows.find(arrow => arrow.to === card.id);
        if (into === undefined || !working(card)) return null;
        return (
          <span
            key={card.id}
            data-flow={card.id}
            aria-hidden="true"
            // At the world layer's origin, so the path's coordinates are the map's own.
            className="map-flow-dot pointer-events-none motion-reduce:hidden absolute left-0 top-0 size-2.5 rounded-full bg-[color:var(--running)]"
            style={{ offsetPath: `path('${into.d}')` }}
          />
        );
      })}
    </>
  );
}
