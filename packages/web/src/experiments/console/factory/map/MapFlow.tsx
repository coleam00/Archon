import { memo, useMemo, type ReactElement } from 'react';
import { LINE_TO } from '../canvas-lines';
import { mapFlow } from '../lib/map-flow';
import type { ArrowPath, Box, PlacedCard } from '../lib/map-layout';
import { FlowDot } from '../overview/OverviewFlow';
import { useReducedMotion } from '../overview/useReducedMotion';

/** The forward flow's dot: quieter than the running dot (10 px) and How it works' own. */
const AMBIENT_R = 3;
const AMBIENT_HALO_R = 6;
const AMBIENT_PEAK = 0.9;

/**
 * The map's flow, none of it drawn under reduced motion (a CSS class cannot stop SMIL):
 *
 * - Always, one faint dot travels every forward hand-off in turn, from the first card to the
 *   last, on one SVG timeline (`mapFlow`), so the map reads as one flow end to end. Only
 *   position and opacity animate, as on How it works.
 * - While a run works an item on a card, a brighter 10 px dot in the running colour travels the
 *   hand-off into that card, over and over (`.map-flow-dot` in factory.css). Its arrival is held
 *   by the running chip's pulsing dot on the card (rule 7). A card no hand-off runs into (the
 *   first) has none. A CSS loop per card, so the map never re-renders for it.
 */
export function MapFlow({
  cards,
  arrows,
  bounds,
  working,
}: {
  cards: readonly PlacedCard[];
  arrows: readonly ArrowPath[];
  bounds: Box;
  /** Whether a run works an item on this card now. */
  working: (card: PlacedCard) => boolean;
}): ReactElement | null {
  const reduced = useReducedMotion();
  if (reduced) return null;
  return (
    <>
      <ForwardFlow arrows={arrows} bounds={bounds} />
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

/** The forward flow's one timeline; memoised, so a live read never restarts it. */
const ForwardFlow = memo(function ForwardFlow({
  arrows,
  bounds,
}: {
  arrows: readonly ArrowPath[];
  bounds: Box;
}): ReactElement | null {
  const flow = useMemo(
    () =>
      mapFlow(
        arrows.map(arrow => ({ from: arrow.from, to: arrow.to, points: [arrow.start, arrow.end] }))
      ),
    [arrows]
  );
  if (flow === undefined) return null;
  const dur = `${flow.period.toString()}ms`;
  return (
    <svg
      aria-hidden="true"
      data-map-flow=""
      className="pointer-events-none absolute overflow-visible motion-reduce:hidden"
      style={{ left: bounds.x, top: bounds.y, width: bounds.w, height: bounds.h }}
      viewBox={`${bounds.x.toString()} ${bounds.y.toString()} ${bounds.w.toString()} ${bounds.h.toString()}`}
    >
      {flow.moves.map(move => (
        <FlowDot
          key={`${move.from}>${move.to}`}
          move={move}
          period={flow.period}
          dur={dur}
          colour={LINE_TO}
          r={AMBIENT_R}
          haloR={AMBIENT_HALO_R}
          peak={AMBIENT_PEAK}
          data={{ 'data-map-flow-move': `${move.from}>${move.to}` }}
        />
      ))}
    </svg>
  );
});
